import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 版本号单一来源：package.json（与 routes/index.js 的 /health、check-update 共用）
const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version;
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
import { BackupModel } from './db/backup.model.js';
import { setupWebhookDispatch } from './services/webhook.service.js';
import { BackupService } from './services/backup.service.js';
import { initDatabase, getDb, InstanceModel, AdminAccountModel } from './db/index.js';
import { bootstrapApiKey, isPublicBind } from './utils/credentials.js';
import { logger } from './utils/logger.js';

// ── 启动时 .env 权限检查 ────────────
// 路径取 config.envFilePath（与 dotenv 加载、凭据写回同一个来源），避免两处各自推导
const envPath = config.envFilePath;

// .env 权限检查：POSIX 下 group/other 可读位告警
try {
  const stat = fs.statSync(envPath);
  if ((stat.mode & 0o077) !== 0) {
    logger.warn(`[Security] .env 文件权限过宽（${(stat.mode & 0o777).toString(8)}），建议设置为 0600（仅所有者可读写）`);
  }
} catch { /* 文件不存在等情况由后续校验处理 */ }

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

initDatabase();
warnIfPublicBindWithoutSetupToken();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
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

// 信任反向代理（nginx/CDN）：层数可通过 TRUST_PROXY 环境变量配置，默认 1
app.set('trust proxy', config.trustProxy);

const serverManager = new MCServerManager();

// 孤儿实例接管：面板重启后扫描各实例 pid 文件，验活接管仍在运行的
// MC 进程（恢复运行态/RCON/停止能力）。必须先于 autoStart 错峰启动执行——
// 接管置 isRunning=true 后，autoStart 的已运行跳过检查天然防止双开。
// 失败不阻塞面板启动（接管缺失退化为旧行为：实例失联显示已停止）
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
  const resetCount = BackupModel.resetStaleInProgress({ maxAgeMs: config.backupInProgressTimeoutMs });
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
app.use(helmet({
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
}));

app.use(express.json({ limit: config.bodyLimitJson }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimitJson }));

// 限流分层挂载：
// ① 按真实连接 IP 的全局限流（认证之前挂载，防未认证暴力破解，
//    且避免伪造 x-api-key 头污染按 key 计数）
// ② 认证中间件（认证通过后才按 x-api-key 计数，未认证请求只吃 IP 限额）
app.use('/api/', rateLimit());
app.use('/api/', authMiddleware);
app.use('/api/', apiKeyRateLimit());

// 静态托管：必须挂 setupRoutes 之前（其内部 notFoundHandler 直接收尾，
// 挂其后静态请求无法命中）；未部署前端时不挂载，非 /api 仍走 JSON 404
setupStaticServe(app, config.publicDir);

setupRoutes(app, serverManager, taskScheduler);

app.use(errorHandler);

setupWebhookDispatch(serverManager);
const wsSetup = setupWebSocket(wss, serverManager);
// 系统资源统计的 WS 推送（每 15s）：前端把它当**缓存失效信号**——收到即重取
// GET /system-stats（另有 30s 保底轮询兜底，两者叠加不构成双写）。两处读数口径
// 并不完全同源：内存/磁盘同逻辑（本模块内为拷贝实现），CPU 一方是 loadavg 近似、
// 另一方是 /proc/stat 差分，故数值只以 HTTP 为准。返回的 stop 句柄接入停机路径
const stopSystemStatsBroadcast = wsSetup.startSystemStatsBroadcast();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`错误: 端口 ${config.port} 已被占用，请修改 .env 的 PORT 配置或停止占用该端口的进程。`);
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
  const maskedHash = config.apiKeyHash.length > 8
    ? config.apiKeyHash.substring(0, 8) + '...'
    : '****';
  logger.banner(`  API Key Hash: ${maskedHash}`);
  logger.banner(`  Servers Dir: ${config.serversDir}`);
  logger.banner(`  Data Dir: ${config.dataDir}`);
  logger.banner(`  API Endpoint: http://localhost:${config.port}/api/v1`);
  logger.banner(`  WebSocket: ws://localhost:${config.port}/ws`);
  logger.banner(`========================================`);

  taskScheduler.start();
  logger.banner(`  Task scheduler: started`);

  // 面板重启后自动恢复标记 autoStart 的实例（延迟 2s 错峰启动）
  // InstanceModel 已在模块顶层通过 initDatabase() 初始化，直接同步调用即可
  setTimeout(() => {
    let autoStartInstances;
    try { autoStartInstances = InstanceModel.getAll().filter(i => i.autoStart === true); } catch { return; }
    if (autoStartInstances.length === 0) return;
    logger.info(`[AutoStart] Found ${autoStartInstances.length} instance(s) marked for auto-start`);
    let idx = 0;
    const startNext = () => {
      if (idx >= autoStartInstances.length) return;
      const inst = autoStartInstances[idx++];
      const instance = serverManager.getInstance(inst.id);
      if (!instance) { startNext(); return; }
      // 跳过已运行/熔断/目录缺失
      if (instance.isRunning) { logger.info(`[AutoStart] ${inst.id} already running, skipping`); startNext(); return; }
      if (instance._circuitBreakerTripped) { logger.info(`[AutoStart] ${inst.id} circuit breaker tripped, skipping`); startNext(); return; }
      if (!fs.existsSync(path.join(instance.serverPath, instance.jarFile))) {
        logger.info(`[AutoStart] ${inst.id} jar missing, skipping`);
        startNext(); return;
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
// 由 adoptOrphanInstances 接管（owner 2026-09-09 拍板：面板停机不停实例）。
// 边界：面板不在线期间实例崩溃无自动重启（autoRestart 依赖面板进程）。
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down (MC instances keep running)...`);
  taskScheduler.stop();
  stopSystemStatsBroadcast();
  wss.close(() => {
    logger.info('WebSocket server closed');
    try {
      getDb().close();
      logger.info('Database closed');
    } catch (e) {
      logger.error('Failed to close database:', e.message);
    }
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    // 兜底：server.close 回调未触发也强制退出
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
  logger.error('[Fatal] Uncaught exception:', err instanceof Error ? (err.stack || err.message) : String(err));
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('[Fatal] Unhandled rejection:', reason instanceof Error ? (reason.stack || reason.message) : String(reason));
  shutdown('unhandledRejection');
});
