import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import config from './config.js';
import { hashToken } from './utils/password.js';
import { isWeakApiKey } from './utils/weak-key.js';

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
import { initDatabase, getDb, InstanceModel } from './db/index.js';
import { logger } from './utils/logger.js';

// ── 启动时 API Key 哈希迁移 + .env 权限检查 ────────────
const envPath = path.join(__dirname, '.env');

// 迁移：旧格式 API_KEY=<明文> → API_KEY_HASH=<sha256hex>
if (!config.apiKeyHash && config.apiKey) {
  const hash = hashToken(config.apiKey);
  config.apiKeyHash = hash;
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    content = content.replace(/^API_KEY=.*$/m, '');
    const hashLine = `API_KEY_HASH=${hash}`;
    if (/^API_KEY_HASH=.*$/m.test(content)) {
      content = content.replace(/^API_KEY_HASH=.*$/m, hashLine);
    } else {
      content += (content === '' || content.endsWith('\n') ? '' : '\n') + hashLine + '\n';
    }
    const tmp = envPath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 无权限位 */ }
    fs.renameSync(tmp, envPath);
    logger.info('[Security] API Key 已自动迁移为哈希存储格式（API_KEY_HASH）');
  } catch (err) {
    logger.error(`[Security] API Key 哈希迁移失败：${err.message}，请手动将 .env 中 API_KEY 替换为 API_KEY_HASH=<sha256hex>`);
  }
}

// .env 权限检查：POSIX 下 group/other 可读位告警
try {
  const stat = fs.statSync(envPath);
  if ((stat.mode & 0o077) !== 0) {
    logger.warn(`[Security] .env 文件权限过宽（${(stat.mode & 0o777).toString(8)}），建议设置为 0600（仅所有者可读写）`);
  }
} catch { /* 文件不存在等情况由后续校验处理 */ }

// 生产环境弱 API Key 检测（S-P0-5）：仅在明文 API_KEY 迁移路径中可检测
//（哈希值无法逆推）。弱 = 长度 < 16 或纯重复字符（如 'aaaa...'）。
// ALLOW_WEAK_KEY=1 显式豁免（开发/测试环境默认不检查）。
if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_WEAK_KEY) {
  const rawKey = process.env.API_KEY;
  if (rawKey) {
    if (isWeakApiKey(rawKey)) {
      // exit 前引导输出走 banner 白名单（stderr 直写，不受 LOG_LEVEL 过滤）
      logger.banner('╔══════════════════════════════════════════════════╗');
      logger.banner('║  错误: 生产环境不允许使用弱 API Key！         ║');
      logger.banner('║  Key 长度须 >= 16 且不得为纯重复字符。         ║');
      logger.banner('║  如确需使用弱 Key，请设置 ALLOW_WEAK_KEY=1。    ║');
      logger.banner('╚══════════════════════════════════════════════════╝');
      process.exit(1);
    }
  }
  // apiKeyHash 已存在但无明文 → 无法检测原始密钥强度，放行
}

// 启动前校验关键配置（在 listen 之前）
if (!config.apiKeyHash) {
  logger.banner('╔══════════════════════════════════════════════════╗');
  logger.banner('║  错误: 未设置 API_KEY_HASH！                     ║');
  logger.banner('║  请在 .env 文件中设置 API_KEY_HASH 后再启动。  ║');
  logger.banner('╚══════════════════════════════════════════════════╝');
  process.exit(1);
}

initDatabase();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // find-012：限制单条 WS 消息大小（客户端仅 subscribe/unsubscribe/ping，
  // 1MB 足够），防止恶意客户端发送超大消息导致服务端内存膨胀
  maxPayload: 1024 * 1024,
  handleProtocols: (protocols, req) => {
    // 双通道 WS 鉴权 subprotocol：API Key（既有）与管理员会话令牌（安全主线）。
    // 仅提取凭据挂到 req，真实校验在 websocket.js connection 时完成
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
    return false;
  },
});

// 信任反向代理（nginx/CDN）：层数可通过 TRUST_PROXY 环境变量配置，默认 1
app.set('trust proxy', config.trustProxy);

const serverManager = new MCServerManager();

// 孤儿实例接管（UXT-15）：面板重启后扫描各实例 pid 文件，验活接管仍在运行的
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
// eslint-disable-next-line no-unused-vars
const wsSetup = setupWebSocket(wss, serverManager);

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

// 优雅停机：停实例 → 关 WS → 关 DB → 关 HTTP，确保 WAL 刷盘且连接不泄漏
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down...`);
  taskScheduler.stop();
  try {
    await serverManager.stopAll({ timeout: 8000 });
  } catch (e) {
    logger.error('Failed to stop instances gracefully:', e.message);
  }
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
// 路由漏用 asyncHandler）都会让主进程无日志崩溃，所有 MC 实例托管断连（一键部署
// 可由 systemd 自愈，手动部署场景面板失联且不自愈）。记录结构化错误日志（含堆栈）
// 后复用 shutdown() 优雅退出（停实例落盘、关库），禁止静默吞异常继续运行
process.on('uncaughtException', (err) => {
  logger.error('[Fatal] Uncaught exception:', err instanceof Error ? (err.stack || err.message) : String(err));
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('[Fatal] Unhandled rejection:', reason instanceof Error ? (reason.stack || reason.message) : String(reason));
  shutdown('unhandledRejection');
});
