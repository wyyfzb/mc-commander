import { Router } from 'express';
import { createStatusRoutes } from './status.js';
import { createPlayerRoutes } from './players.js';
import { createBackupRoutes } from './backups.js';
import { createTaskRoutes } from './tasks.js';
import { createFileRoutes } from './files.js';
import { createServerJarRoutes } from './server-jar.js';
import { createKeyRoutes } from './keys.js';
import { success } from '../utils/response.js';
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
      ]
    }));
  });

  app.use('/api/v1', v1Router);

  app.use(notFoundHandler);
}
