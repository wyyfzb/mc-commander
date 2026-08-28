import { Router } from 'express';
import { createStatusRoutes } from './status.js';
import { createPlayerRoutes } from './players.js';
import { createBackupRoutes } from './backups.js';
import { createTaskRoutes } from './tasks.js';
import { createFileRoutes } from './files.js';
import { createServerJarRoutes } from './server-jar.js';
import { createKeyRoutes } from './keys.js';
import { createAuditRoutes } from './audit.js';
import { createWebhookRoutes } from './webhooks.js';
import { createUpgradeRoutes } from './upgrade.js';
import { success } from '../utils/response.js';
import config from '../config.js';
import { notFoundHandler } from '../middleware/error_handler.js';

export function setupRoutes(app, serverManager, taskScheduler) {
  // 轻量健康检查：仅返回进程存活与静态信息，不调用 getAllInstances()（内部
  // toStatus() 含 RCON 探测等开销，未认证的 /health 不应触发全量实例状态扫描）
  app.get('/health', (req, res) => {
    const instanceCount = serverManager?.instances?.size ?? 0;
    res.json(success({
      status: 'ok',
      version: '0.1.0',
      uptime: Math.floor(process.uptime()),
      instanceCount,
      nodeVersion: process.version,
    }));
  });

  const v1Router = Router();

  v1Router.use('/', createStatusRoutes(serverManager));
  v1Router.use('/', createPlayerRoutes(serverManager));
  v1Router.use('/', createBackupRoutes(serverManager));
  v1Router.use('/', createTaskRoutes(serverManager, taskScheduler));
  v1Router.use('/', createFileRoutes(serverManager));
  v1Router.use('/', createServerJarRoutes(serverManager));
  v1Router.use('/', createKeyRoutes());
  v1Router.use('/', createAuditRoutes());
  v1Router.use('/', createWebhookRoutes());
  v1Router.use('/', createUpgradeRoutes(serverManager));

  // GET /api/v1/check-update —— 面板更新检查（Node 内置 fetch，零新增依赖）
  v1Router.get('/check-update', async (req, res, next) => {
    try {
      const pkgName = config.npmPkgName;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const npmRes = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!npmRes.ok) throw new Error(`npm registry ${npmRes.status}`);
      const pkg = await npmRes.json();
      const current = '0.1.0'; // 与 package.json / overview 保持一致
      const latest = pkg.version || null;
      res.json(success({
        current,
        latest,
        hasUpdate: latest !== null && latest !== current,
        url: latest ? `https://www.npmjs.com/package/${pkgName}/v/${latest}` : undefined,
      }));
    } catch (e) {
      // 网络不可达不报错
      if (e.name === 'AbortError' || e.code === 'UND_ERR_CONNECTABLE') {
        res.json(success({ current: '0.1.0', latest: null, hasUpdate: false, offline: true }));
      } else {
        next(e);
      }
    }
  });

  v1Router.get('/', (req, res) => {
    res.json(success({
      version: 'v1',
      endpoints: [
        '/overview',
        '/instances',
        '/instances/:id',
        '/instances/:id/start',
        '/instances/:id/stop',
        '/instances/:id/restart',
        '/instances/:id/command',
        '/instances/:id/logs',
        '/instances/:id/properties',
        '/instances/:id/world',
        '/instances/:id/players',
        '/instances/:id/backups',
        '/instances/:id/tasks',
        '/instances/:id/files/mkdir',
        '/instances/:id/files/rename',
        '/instances/:id/files/upload',
        '/webhooks',
        '/webhooks/:id',
        '/webhooks/:id/test',
        '/webhooks/:id/deliveries',
        '/instances/:id/upgrade',
        '/instances/:id/upgrade/status',
        '/check-update',
      ]
    }));
  });

  app.use('/api/v1', v1Router);

  app.use(notFoundHandler);
}
