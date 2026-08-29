import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error_handler.js';
import { apiKeyRateLimit, rateLimit } from './middleware/rate_limit.js';
import { setupStaticServe } from './middleware/static_serve.js';
import cors from './middleware/cors.js';
import { setupRoutes } from './routes/index.js';
import { MCServerManager } from './services/mc_server.js';
import { TaskScheduler } from './services/task_scheduler.js';
import { setupWebSocket } from './websocket.js';
import { BackupModel } from './db/backup.model.js';
import { setupWebhookDispatch } from './services/webhook.service.js';
import { BackupService } from './services/backup.service.js';
import { initDatabase, InstanceModel } from './db/index.js';

// 启动前校验关键配置（在 listen 之前）
if (!config.apiKey || config.apiKey === '') {
  console.error('╔══════════════════════════════════════════════════╗');
  console.error('║  错误: 未设置 API_KEY！                          ║');
  console.error('║  请在 .env 文件中设置 API_KEY 后再启动服务端。   ║');
  console.error('╚══════════════════════════════════════════════════╝');
  process.exit(1);
}

// ── find-016 生产环境 API Key 强度校验 ────────────────────────
// 低熵形态：纯数字 / 纯小写字母 / 纯大写字母 / 纯重复字符等
const LOW_ENTROPY_PATTERNS = [
  { regex: /^\d+$/, label: '纯数字' },
  { regex: /^[a-z]+$/, label: '纯小写字母' },
  { regex: /^[A-Z]+$/, label: '纯大写字母' },
  { regex: /^(.)\1+$/, label: '纯重复字符' },
];

// 强度判定（导出供单元测试）：长度 ≥ 16 且非低熵形态视为合格
export function checkApiKeyStrength(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length < 16) {
    return { ok: false, reason: '长度不足 16 位' };
  }
  for (const { regex, label } of LOW_ENTROPY_PATTERNS) {
    if (regex.test(apiKey)) {
      return { ok: false, reason: `低熵形态（${label}）` };
    }
  }
  return { ok: true, reason: null };
}

const isProduction = process.env.NODE_ENV === 'production';
const weakKeys = ['mc-commander-dev-key', 'mc-commander-default-key', ''];
const isWeakExactKey = weakKeys.includes(config.apiKey);
const strengthCheck = checkApiKeyStrength(config.apiKey);
const isWeakApiKey = isWeakExactKey || !strengthCheck.ok;

if (isProduction && isWeakApiKey) {
  console.error('╔══════════════════════════════════════════════════╗');
  console.error('║  错误: 生产环境禁止使用默认/弱 API Key！         ║');
  if (isWeakExactKey) {
    console.error('║  请使用强随机串（如 openssl rand -hex 32）。     ║');
  } else {
    console.error(`║  当前 Key 强度不足（${strengthCheck.reason}）。   ║`);
  }
  console.error('╚══════════════════════════════════════════════════╝');
  process.exit(1);
}

if (!isProduction && isWeakApiKey) {
  console.warn('╔══════════════════════════════════════════════════╗');
  console.warn('║  警告: 正在使用默认/弱 API Key！                  ║');
  console.warn('║  请修改 .env 文件中的 API_KEY 以确保安全。        ║');
  console.warn('╚══════════════════════════════════════════════════╝');
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

// 信任反向代理（nginx/CDN），确保 req.ip 返回真实客户端 IP
app.set('trust proxy', 1);

const serverManager = new MCServerManager();

const taskScheduler = new TaskScheduler(serverManager);

// 启动时恢复卡死的进行中备份/恢复记录：进程崩溃时 status='creating'
// （备份执行中断）/'restoring'（恢复中断）记录永久停留，此后该实例的
// 备份/恢复被互斥检查永久拒绝（只能人工改库）——超时记录按语义重置
// （creating→failed、restoring→completed，备份文件本身未动）
try {
  const resetCount = BackupModel.resetStaleInProgress({ maxAgeMs: config.backupInProgressTimeoutMs });
  if (resetCount > 0) {
    console.log(`[Backup] Reset ${resetCount} stale in-progress backup record(s) on startup`);
  }
} catch (err) {
  console.error('Failed to reset stale backup records:', err.message);
}

// 启动检测：残留的 pre_restore 目录（进程在上次恢复中段崩溃）告警提示
try {
  new BackupService().detectOrphanedPreRestoreDirs();
} catch (err) {
  console.error('Failed to scan for orphaned pre-restore dirs:', err.message);
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
setupWebSocket(wss, serverManager);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`  MC_Commander Server v1.1.0`);
  console.log(`========================================`);
  console.log(`  Port: ${config.port}`);
  const maskedKey = config.apiKey.length > 4
    ? config.apiKey.substring(0, 4) + '****'
    : '****';
  console.log(`  API Key: ${maskedKey}`);
  console.log(`  Servers Dir: ${config.serversDir}`);
  console.log(`  Data Dir: ${config.dataDir}`);
  console.log(`  API Endpoint: http://localhost:${config.port}/api/v1`);
  console.log(`  WebSocket: ws://localhost:${config.port}/ws`);
  console.log(`========================================`);

  taskScheduler.start();
  console.log(`  Task scheduler: started`);

  // 面板重启后自动恢复标记 autoStart 的实例（延迟 2s 错峰启动）
  // InstanceModel 已在模块顶层通过 initDatabase() 初始化，直接同步调用即可
  setTimeout(() => {
    let autoStartInstances;
    try { autoStartInstances = InstanceModel.getAll().filter(i => i.autoStart === true); } catch { return; }
    if (autoStartInstances.length === 0) return;
    console.log(`[AutoStart] Found ${autoStartInstances.length} instance(s) marked for auto-start`);
    let idx = 0;
    const startNext = () => {
      if (idx >= autoStartInstances.length) return;
      const inst = autoStartInstances[idx++];
      const instance = serverManager.getInstance(inst.id);
      if (!instance) { startNext(); return; }
      // 跳过已运行/熔断/目录缺失
      if (instance.isRunning) { console.log(`[AutoStart] ${inst.id} already running, skipping`); startNext(); return; }
      if (instance._circuitBreakerTripped) { console.log(`[AutoStart] ${inst.id} circuit breaker tripped, skipping`); startNext(); return; }
      if (!fs.existsSync(path.join(instance.serverPath, instance.jarFile))) {
        console.log(`[AutoStart] ${inst.id} jar missing, skipping`);
        startNext(); return;
      }
      try {
        instance.start();
        console.log(`[AutoStart] ${inst.id} started successfully`);
      } catch (e) {
        console.error(`[AutoStart] ${inst.id} failed to start:`, e.message);
      }
      setTimeout(startNext, config.autoStartDelayMs);
    };
    startNext();
  }, 2000);

  console.log(`========================================`);
});

// 优雅停机：先 await stopAll（stop 命令送达 + 等待 MC 正常退出，超时强杀兜底），再关闭 HTTP/WS 服务退出。
async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  taskScheduler.stop();
  try {
    await serverManager.stopAll({ timeout: 8000 });
  } catch (e) {
    console.error('Failed to stop instances gracefully:', e.message);
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  // 兜底：server.close 回调未触发（如 WS 连接未断开）也强制退出
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
