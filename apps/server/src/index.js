import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 版本号单一来源：package.json（与 routes/index.js 的 /health、check-update 共用）
const SERVER_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version;
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error_handler.js';
import { apiKeyRateLimit, rateLimit } from './middleware/rate_limit.js';
import { setupStaticServe } from './middleware/static_serve.js';
import cors from './middleware/cors.js';
import { setupRoutes } from './routes/index.js';
import { MCServerManager } from './services/mc_server.js';
import { adoptOrphanInstances } from './services/mc-server/adopt.js';
import { TaskScheduler } from './services/task_scheduler.js';
import { setupWebSocket } from './websocket.js';
import { collectSystemStats } from './utils/system-stats.js';
import { flushNotificationEvents } from './websocket.js';
import { MetricsModel } from './db/metrics.model.js';
import { BackupModel } from './db/backup.model.js';
import { setupWebhookDispatch } from './services/webhook.service.js';
import { BackupService, inFlightBackupOps } from './services/backup.service.js';
import { initDatabase, getDb, InstanceModel, AdminAccountModel } from './db/index.js';
import { bootstrapApiKey, isPublicBind } from './utils/credentials.js';
import { logger } from './utils/logger.js';
import { createProtocolMux } from './services/tls/mux.js';
import {
  ensureServerCert,
  isOpensslAvailable,
  loadCertMaterial,
  readCaCert,
} from './services/tls/cert.js';

// ── 启动时 .env 权限检查 ────────────
// 路径取 config.envFilePath（与 dotenv 加载、凭据写回同一个来源），避免两处各自推导
const envPath = config.envFilePath;

// .env 权限检查：POSIX 下 group/other 可读位告警
try {
  const stat = fs.statSync(envPath);
  if ((stat.mode & 0o077) !== 0) {
    logger.warn(
      `[Security] .env 文件权限过宽（${(stat.mode & 0o777).toString(8)}），建议设置为 0600（仅所有者可读写）`,
    );
  }
} catch {
  /* 文件不存在等情况由后续校验处理 */
}

// ── 首次启动播种管理员 API Key ────────────
// 不再要求部署方自行 `printf … | sha256sum`：人挑的明文无法约束强度（弱 Key 入口），
// 而服务端签发一律走 CSPRNG（32 字节）。生成后写回 .env 的摘要行（原子写 + 0600），
// 明文只在本次启动横幅里出现一次——与轮换端点同一口径（明文不落盘）。
// 写盘失败即拒绝启动（而不是只在内存里留一把）：否则每次重启都会换一把 Key，
// 已接入的脚本会在重启后收到无法解释的 401。
if (!config.apiKeyHash) {
  let bootstrapped = null;
  try {
    bootstrapped = bootstrapApiKey(config.envFilePath);
  } catch (err) {
    logger.banner('==========================================================');
    logger.banner('  错误: 未设置 API_KEY_HASH，且自动生成后写回 .env 失败');
    logger.banner('  请检查服务端目录写权限，或手动设置 API_KEY_HASH 后启动');
    logger.banner('==========================================================');
    logger.error('[Bootstrap] 写回 .env 失败:', err.message);
    process.exit(1); // 生产路径到此终止；启动流程用例把 exit 桩成 no-op，故下方以 bootstrapped 收口
  }
  if (bootstrapped) {
    config.apiKeyHash = bootstrapped.hash;
    logger.banner('==========================================================');
    logger.banner('  首次启动：已为你生成管理员 API Key（只显示这一次）');
    logger.banner(`  API Key: ${bootstrapped.apiKey}`);
    logger.banner('  摘要已写入 .env 的 API_KEY_HASH 行；明文请立即保存。');
    logger.banner('  忘记可在设置页轮换，或删除该行后重启让服务端重新签发。');
    logger.banner('==========================================================');
  }
}

// ── 公网监听的所有权证明提示 ────────────
// 威胁面：HOST 对外可达时，「部署完成 → 管理员设密」窗口内任何发现端口者可抢先
// 设密并永久接管面板。部署脚本会生成一次性 SETUP_TOKEN（见 SECURITY.md「首访设密
// 保护」），手工/容器部署容易漏掉，故这里在启动时点名提示（生成与否仍由部署方决定：
// 手工加一行 `SETUP_TOKEN=<openssl rand -hex 32>` 即可，不改服务端行为）。
function warnIfPublicBindWithoutSetupToken() {
  if (config.setupToken || !isPublicBind(config.host)) return;
  try {
    if (AdminAccountModel.isConfigured()) return; // 已设密：setup 端点已不可达，无窗口
  } catch (err) {
    // 不猜状态：DB 不可读时默认「已设密」（最坏是漏一次提示，而不是对着健康部署误报）。
    // 记一条 debug 便于排查接线错误（静默 return 会把「mock 少给一个模型」这类问题藏起来）
    logger.debug('[Security] 首访设密提示的账号状态探测失败，按已设密处理:', err.message);
    return;
  }
  logger.warn('──────────────────────────────────────────────────────────');
  logger.warn(`[Security] 监听地址 ${config.host} 对外可达，且面板尚未设密、未配置 SETUP_TOKEN。`);
  logger.warn('           此窗口内任何能访问该端口的人都可抢先设密并接管面板。');
  logger.warn('           建议：运行 openssl rand -hex 32，把输出粘到 .env 的 SETUP_TOKEN= 后重启');
  logger.warn('           （或改用部署脚本，它会自动生成并随部署输出展示）。');
  logger.warn('──────────────────────────────────────────────────────────');
}

/**
 * 准备 TLS 材料。失败一律降级为「只跑明文」而不是拒绝启动：
 * 面板起不来等于用户连修的机会都没有，而明文通道本身是可用状态。
 * 返回 material 与未启用的原因，后者要原样进设置页——用户需要知道
 * 「为什么没有 HTTPS」，而不是面对一个永久灰着的开关。
 */
function prepareTls() {
  if (!isOpensslAvailable()) {
    return { material: null, reason: '系统缺少 openssl 命令，无法生成证书' };
  }
  try {
    ensureServerCert();
    const material = loadCertMaterial();
    if (!material) {
      logger.warn('[TLS] 证书文件读取失败，本次只提供明文访问');
      return { material: null, reason: '证书文件读取失败，请查看面板日志' };
    }
    return { material, reason: null };
  } catch (err) {
    logger.warn(`[TLS] 证书准备失败，本次只提供明文访问：${err.message}`);
    return { material: null, reason: `证书准备失败：${err.message}` };
  }
}

initDatabase();
warnIfPublicBindWithoutSetupToken();

const app = express();
// 明文与 TLS 各一个 http(s) 服务器，由 mux 在同一个端口上按首字节分流。
// 两个服务器共享同一份 express app 与同一个 WebSocketServer（WS 升级请求
// 走各自 server 的 upgrade 事件，故 wss 不能绑定单一 server）。
const plainServer = http.createServer(app);
const tls = config.tls.enabled
  ? prepareTls()
  : { material: null, reason: '已在 .env 关闭（TLS_ENABLED=false）' };
const secureServer = tls.material ? https.createServer(tls.material, app) : null;
// 对外声明的 TLS 状态：与真实监听保持一致，供设置页判断「能不能给引导」
const tlsState = {
  enabled: Boolean(secureServer),
  disabledReason: secureServer ? null : tls.reason,
};
const server = secureServer
  ? createProtocolMux(
      (socket) => plainServer.emit('connection', socket),
      (socket) => secureServer.emit('connection', socket),
    )
  : plainServer;
const wss = new WebSocketServer({
  noServer: true,
  // 限制单条 WS 消息大小（客户端仅 subscribe/unsubscribe/ping，
  // 1MB 足够），防止恶意客户端发送超大消息导致服务端内存膨胀
  maxPayload: 1024 * 1024,
  handleProtocols: (protocols, req) => {
    // 双通道 WS 鉴权 subprotocol：API Key（既有）与管理员会话令牌（安全主线）。
    // 仅提取凭据挂到 req，真实校验在 websocket.js connection 时完成。
    // 无凭据 subprotocol 的握手不再拒绝——放行进入「首帧鉴权」通道
    // （第一条消息必须是 auth，见 websocket.js），兼容代理剥离
    // Sec-WebSocket-Protocol 头的部署环境；subprotocol 通道保留向后兼容
    for (const p of protocols) {
      if (typeof p === 'string' && p.startsWith('mc-commander-apikey.')) {
        req._wsApiKey = p.slice('mc-commander-apikey.'.length);
        return p;
      }
      if (typeof p === 'string' && p.startsWith('mc-commander-session.')) {
        req._wsSessionToken = p.slice('mc-commander-session.'.length);
        return p;
      }
    }
    return true;
  },
});

// WS 升级请求在两个 server 上各接一次：/ws 之外一律 destroy——noServer 模式下
// wss 不再自行按路径拒绝握手，路径判定必须在这里做
for (const s of secureServer ? [plainServer, secureServer] : [plainServer]) {
  s.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

// 信任反向代理（nginx/CDN）：层数可通过 TRUST_PROXY 环境变量配置，默认 1
app.set('trust proxy', config.trustProxy);

const serverManager = new MCServerManager();

// 孤儿实例接管：面板重启后扫描各实例 pid 文件，验活接管仍在运行的
// MC 进程（恢复运行态/RCON/停止能力）。必须先于 autoStart 错峰启动执行——
// 接管置 isRunning=true 后，autoStart 的已运行跳过检查天然防止双开。
// 失败不阻塞面板启动（接管缺失时实例失联、显示为已停止）
try {
  adoptOrphanInstances(serverManager);
} catch (err) {
  logger.error('[Adopt] Orphan adoption failed (panel starts without adopt):', err.message);
}

const taskScheduler = new TaskScheduler(serverManager);

// 启动时恢复卡死的进行中备份/恢复记录：进程崩溃时 status='creating'
// （备份执行中断）/'restoring'（恢复中断）记录永久停留，此后该实例的
// 备份/恢复被互斥检查永久拒绝（只能人工改库）——超时记录按语义重置
// （creating→failed、restoring→completed，备份文件本身未动）
try {
  const resetCount = BackupModel.resetStaleInProgress({
    maxAgeMs: config.backupInProgressTimeoutMs,
  });
  if (resetCount > 0) {
    logger.info(`[Backup] Reset ${resetCount} stale in-progress backup record(s) on startup`);
  }
} catch (err) {
  logger.error('Failed to reset stale backup records:', err.message);
}

// 启动检测：残留的 pre_restore 目录（进程在上次恢复中段崩溃）告警提示
try {
  new BackupService().detectOrphanedPreRestoreDirs();
} catch (err) {
  logger.error('Failed to scan for orphaned pre-restore dirs:', err.message);
}

app.use(cors());

// 安全响应头（helmet）：CSP / X-Frame-Options / X-Content-Type-Options 等
// - style-src 放行 'unsafe-inline'：React style 属性内联样式必需
// - connect-src 放行任意目标：面板前端支持指向任意配置的服务端地址
// - 禁用 upgrade-insecure-requests：局域网 http 自托管部署下相对路径请求
//   会被强制升级 https 而中断
// - 关闭 COEP（require-corp 会阻断跨源图片等嵌入资源，非本任务必需）
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(express.json({ limit: config.bodyLimitJson }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimitJson }));

// 限流分层挂载：
// ① 按真实连接 IP 的全局限流（认证之前挂载，防未认证暴力破解，
//    且避免伪造 x-api-key 头污染按 key 计数）
// ② 认证中间件（认证通过后才按 x-api-key 计数，未认证请求只吃 IP 限额）
app.use('/api/', rateLimit());
app.use('/api/', authMiddleware);
app.use('/api/', apiKeyRateLimit());

// 根证书下载：必须免认证——用户导入根证书时还没登录，登录页本身也可能
// 因证书未受信而不可用。证书是公开信息（私钥不在此端点），分发它不降低安全性；
// 真正的风险是明文下载被中间人换成攻击者的 CA，故面板在下载页与设置页都展示
// 指纹，用户导入后可与设备证书列表里的指纹核对。
app.get('/ca.crt', (req, res) => {
  const pem = readCaCert();
  if (!pem) {
    res.status(404).type('text/plain; charset=utf-8').send('内置 HTTPS 未启用');
    return;
  }
  res.type('application/x-x509-ca-cert');
  // inline 而非 attachment：iOS 需要浏览器直接打开证书页才会弹出「安装描述文件」，
  // 强制下载会落进文件 App，用户还得自己找到并点开——多两步就多一批放弃的人
  res.setHeader('Content-Disposition', 'inline; filename="mc-commander-ca.crt"');
  res.send(pem);
});

// 静态托管：必须挂 setupRoutes 之前（其内部 notFoundHandler 直接收尾，
// 挂其后静态请求无法命中）；未部署前端时不挂载，非 /api 仍走 JSON 404
setupStaticServe(app, config.publicDir);

setupRoutes(app, serverManager, taskScheduler, tlsState);

app.use(errorHandler);

setupWebhookDispatch(serverManager);
const wsSetup = setupWebSocket(wss, serverManager);
// 系统资源统计的 WS 推送（每 15s）：前端把它当**缓存失效信号**——收到即重取
// GET /system-stats（另有 30s 保底轮询兜底，两者叠加不构成双写）。两处读数口径
// 并不完全同源：内存/磁盘同逻辑（本模块内为拷贝实现），CPU 一方是 loadavg 近似、
// 另一方是 /proc/stat 差分，故数值只以 HTTP 为准。返回的 stop 句柄接入停机路径
const stopSystemStatsBroadcast = wsSetup.startSystemStatsBroadcast();

// 分钟级主机指标落库（60s 一行，48h 保留期）：观测数据面，供 GET /api/v1/metrics
// 与后续 dashboard「昨日摘要」消费。在线玩家数从全部已加载实例汇总。
//
// 保留期 48h 而非 24h：清理是**每日一次**，故窗口实际在 [保留期, 保留期+24h) 之间摆动。
// 保留期取 24h 时，清理后「昨日」这个完整本地日历日只剩 1387/1440 分钟——同一张卡在
// 一天里的不同时刻会给出不同口径的数。取 48h 可让「昨日」在全天任意时刻都完整可算。
const METRICS_SAMPLE_INTERVAL_MS = 60_000;
const METRICS_RETENTION_HOURS = 48;
const METRICS_SWEEP_INTERVAL_MS = 24 * 3600_000;
let lastRetentionSweep = 0;

function countOnlinePlayers() {
  let total = 0;
  for (const instance of serverManager.instances.values()) {
    total += instance.players?.size ?? 0;
  }
  return total;
}

function recordMetricsSample() {
  try {
    const stats = collectSystemStats();
    MetricsModel.record({
      cpuUsage: stats.cpuUsage,
      memoryUsedGb: stats.memoryUsage,
      memoryTotalGb: stats.totalMemory,
      memoryPercent: stats.memoryPercent,
      playersOnline: countOnlinePlayers(),
    });
    if (Date.now() - lastRetentionSweep > METRICS_SWEEP_INTERVAL_MS) {
      lastRetentionSweep = Date.now();
      const removed = MetricsModel.deleteOlderThan(METRICS_RETENTION_HOURS);
      if (removed > 0) logger.info(`[Metrics] Pruned ${removed} stale samples`);
    }
  } catch (err) {
    logger.warn('[Metrics] Failed to record sample:', err.message);
  }
}

const stopMetricsSampler = (() => {
  recordMetricsSample();
  const timer = setInterval(recordMetricsSample, METRICS_SAMPLE_INTERVAL_MS);
  return () => clearInterval(timer);
})();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      `错误: 端口 ${config.port} 已被占用，请修改 .env 的 PORT 配置或停止占用该端口的进程。`,
    );
    process.exit(1);
    return;
  }
  // 其他 listen 错误仍按 Node.js 默认行为抛出
  throw err;
});

server.listen(config.port, config.host, () => {
  // 启动横幅走 banner 白名单（stderr 直写不受 LOG_LEVEL 过滤）：部署排障时
  // 即使 LOG_LEVEL=error 也能看到启动信息（journalctl 场景同理，见 README「日志」章节）
  logger.banner(`========================================`);
  logger.banner(`  MC_Commander Server v${SERVER_VERSION}`);
  logger.banner(`========================================`);
  logger.banner(`  Host: ${config.host}`);
  logger.banner(`  Port: ${config.port}`);
  const maskedHash =
    config.apiKeyHash.length > 8 ? config.apiKeyHash.substring(0, 8) + '...' : '****';
  logger.banner(`  API Key Hash: ${maskedHash}`);
  logger.banner(`  Servers Dir: ${config.serversDir}`);
  logger.banner(`  Data Dir: ${config.dataDir}`);
  logger.banner(`  API Endpoint: http://localhost:${config.port}/api/v1`);
  logger.banner(`  WebSocket: ws://localhost:${config.port}/ws`);
  // 同一端口两种协议：列出来是为了让排障的人知道 https/wss 也是通的，
  // 不必去猜证书是否生效
  if (secureServer) {
    logger.banner(`  HTTPS: https://localhost:${config.port}/`);
    logger.banner(`  Secure WebSocket: wss://localhost:${config.port}/ws`);
  }
  logger.banner(`========================================`);

  taskScheduler.start();
  logger.banner(`  Task scheduler: started`);

  // 面板重启后自动恢复标记 autoStart 的实例（延迟 2s 错峰启动）
  // InstanceModel 已在模块顶层通过 initDatabase() 初始化，直接同步调用即可
  setTimeout(() => {
    let autoStartInstances;
    try {
      autoStartInstances = InstanceModel.getAll().filter((i) => i.autoStart === true);
    } catch {
      return;
    }
    if (autoStartInstances.length === 0) return;
    logger.info(`[AutoStart] Found ${autoStartInstances.length} instance(s) marked for auto-start`);
    let idx = 0;
    const startNext = () => {
      if (idx >= autoStartInstances.length) return;
      const inst = autoStartInstances[idx++];
      const instance = serverManager.getInstance(inst.id);
      if (!instance) {
        startNext();
        return;
      }
      // 跳过已运行/熔断/目录缺失
      if (instance.isRunning) {
        logger.info(`[AutoStart] ${inst.id} already running, skipping`);
        startNext();
        return;
      }
      if (instance._circuitBreakerTripped) {
        logger.info(`[AutoStart] ${inst.id} circuit breaker tripped, skipping`);
        startNext();
        return;
      }
      if (!fs.existsSync(path.join(instance.serverPath, instance.jarFile))) {
        logger.info(`[AutoStart] ${inst.id} jar missing, skipping`);
        startNext();
        return;
      }
      try {
        instance.start();
        logger.info(`[AutoStart] ${inst.id} started successfully`);
      } catch (e) {
        logger.error(`[AutoStart] ${inst.id} failed to start:`, e.message);
      }
      setTimeout(startNext, config.autoStartDelayMs);
    };
    startNext();
  }, 2000);

  logger.info(`========================================`);
});

// 优雅停机：只关面板自身资源（调度器/WS/DB/HTTP），不停 MC 实例——实例
// detached 运行且 pid 文件已随 start() 落盘，面板退出后继续服务玩家，下次启动
// 由 adoptOrphanInstances 接管（面板停机不停实例）。
// 边界：面板不在线期间实例崩溃无自动重启（autoRestart 依赖面板进程）。
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down (MC instances keep running)...`);
  // 备份中途退出会把世界留在危险状态：save-off 已发、save-on 还没发，
  // 服务端从此不再自动保存，而面板已经没了——再没有界面能把它打开。
  // 有界等待：只等这一种，且不超过 30 秒（systemd 默认 TimeoutStopSec=90）。
  // 部署/升级中途退出只留下可重跑的残骸，不等，但如实告知。
  const pending = inFlightBackupOps();
  if (pending.length > 0) {
    const kinds = pending.map((p) => `${p.instanceId}(${p.kind})`).join('、');
    logger.warn(`有 ${pending.length} 个备份/恢复正在进行：${kinds}，最多等待 30 秒让它收尾`);
    const deadline = Date.now() + 30_000;
    while (inFlightBackupOps().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const left = inFlightBackupOps();
    if (left.length > 0) {
      // 等超时也要说清后果：用户下次看到「服务器不自动保存」时得有据可查
      logger.error(
        `仍有 ${left.length} 个备份/恢复未收尾就退出（${left.map((p) => p.instanceId).join('、')}）：` +
          '若其中某个已发出 save-off，该实例的自动保存可能停在关闭状态，重启服务器即可恢复',
      );
    }
  }
  taskScheduler.stop();
  stopSystemStatsBroadcast();
  stopMetricsSampler();
  flushNotificationEvents();
  // 先踢掉全部客户端：wss.close() 要等连接自己断开才回调，而浏览器那页正在等面板退出，
  // 两边互等就是永久挂起——实测面板停在 SIGTERM 之后 85 秒才退出，直到标签页被关掉
  for (const client of wss.clients) client.terminate();
  wss.close(() => {
    logger.info('WebSocket server closed');
    // 停机窗口内 serverManager 仍可能发出通知事件（入队未刷），关库前收尾
    flushNotificationEvents();
    try {
      getDb().close();
      logger.info('Database closed');
    } catch (e) {
      logger.error('Failed to close database:', e.message);
    }
    // 每个监听器都要关：mux 只负责分流，已分出去的连接由各自的
    // http/https.Server 持有，漏关任何一个都会让进程带着监听句柄退出。
    // 无 TLS 时 server 就是 plainServer 本身，按集合去重后逐个关
    const closables = secureServer ? [server, plainServer, secureServer] : [plainServer];
    let pending = closables.length;
    const done = () => {
      if (--pending > 0) return;
      logger.info('Server closed');
      process.exit(0);
    };
    for (const s of closables) s.close(done);
    // 兜底：close 回调未触发也强制退出
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 进程级兜底最后防线（asyncHandler 请求级防护之后的纵深）：uncaughtException /
// unhandledRejection 若无兜底，Node 15+ 默认直接终止进程——任何漏防点（如未来
// 路由漏用 asyncHandler）都会让主进程无日志崩溃，面板失联且不自愈（一键部署
// 可由 systemd 自愈）。记录结构化错误日志（含堆栈）后复用 shutdown() 退出——
// 崩溃路径同样不停 MC 实例（进程继续服务玩家，重启后接管），禁止静默吞异常继续运行
process.on('uncaughtException', (err) => {
  logger.error(
    '[Fatal] Uncaught exception:',
    err instanceof Error ? err.stack || err.message : String(err),
  );
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error(
    '[Fatal] Unhandled rejection:',
    reason instanceof Error ? reason.stack || reason.message : String(reason),
  );
  shutdown('unhandledRejection');
});
