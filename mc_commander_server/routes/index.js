import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { createStatusRoutes } from './status.js';
import { createPlayerRoutes } from './players.js';
import { createBackupRoutes } from './backups.js';
import { createTaskRoutes } from './tasks.js';
import { createFileRoutes } from './files.js';
import { createServerJarRoutes } from './server-jar.js';
import { createKeyRoutes } from './keys.js';
import { createMetricsRoutes } from './metrics.js';
import { createAuditRoutes } from './audit.js';
import { createWebhookRoutes } from './webhooks.js';
import { createUpgradeRoutes } from './upgrade.js';
import { createPluginRoutes } from './plugins.js';
import { createAuthRoutes } from './auth.js';
import { success } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import config from '../config.js';
import { notFoundHandler } from '../middleware/error_handler.js';
import { requireAdminRole } from '../middleware/auth.js';

/** 版本号单一来源：package.json（/health、check-update、启动横幅共用，杜绝三处硬编码漂移） */
const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version;

/** API v1 挂载点（唯一事实源：setupRoutes 挂载与路由表枚举测试共用，防前缀漂移） */
export const API_V1_MOUNT = '/api/v1';

/**
 * 组装 /api/v1 路由表。导出供路由表枚举测试复用**同一个**组装入口——测试自建一份
 * 路由表就失去了「新增端点自动纳入覆盖」的意义。
 *
 * 角色门挂在 v1Router 上且早于全部子 router：默认要求 admin，只放行白名单内的
 * 只读请求。逐 router / 逐端点加守卫必漏（12 个子 router 各自新增端点时无人补守卫），
 * 而挂在聚合层 + 路由表枚举测试可让新端点自动落入「默认拒绝」。
 */
export function createApiV1Router(serverManager, taskScheduler) {
  const v1Router = Router();
  v1Router.use(requireAdminRole);

  v1Router.use('/', createStatusRoutes(serverManager));
  v1Router.use('/', createPlayerRoutes(serverManager));
  v1Router.use('/', createBackupRoutes(serverManager));
  v1Router.use('/', createTaskRoutes(serverManager, taskScheduler));
  v1Router.use('/', createFileRoutes(serverManager));
  v1Router.use('/', createServerJarRoutes(serverManager));
  v1Router.use('/', createKeyRoutes());
  v1Router.use('/', createMetricsRoutes());
  v1Router.use('/', createAuditRoutes());
  v1Router.use('/', createWebhookRoutes());
  v1Router.use('/', createUpgradeRoutes(serverManager));
  v1Router.use('/', createPluginRoutes(serverManager));
  v1Router.use('/', createAuthRoutes());

  // GET /api/v1/check-update —— 面板更新检查（Node 内置 fetch，零新增依赖）
  // 网络不可达属可预期失败，按 asyncHandler 约定在处理器内自行捕获降级
  v1Router.get(
    '/check-update',
    asyncHandler(async (req, res) => {
      try {
        const pkgName = config.npmPkgName;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const npmRes = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!npmRes.ok) throw new Error(`npm registry ${npmRes.status}`);
        const pkg = await npmRes.json();
        const current = SERVER_VERSION;
        const latest = pkg.version || null;
        res.json(
          success({
            current,
            latest,
            hasUpdate: latest !== null && latest !== current,
            url: latest ? `https://www.npmjs.com/package/${pkgName}/v/${latest}` : undefined,
          }),
        );
      } catch (e) {
        // 网络不可达不报错
        if (e.name === 'AbortError' || e.code === 'UND_ERR_CONNECTABLE') {
          res.json(
            success({ current: SERVER_VERSION, latest: null, hasUpdate: false, offline: true }),
          );
        } else {
          throw e;
        }
      }
    }),
  );

  v1Router.get('/', (req, res) => {
    res.json(
      success({
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
        ],
      }),
    );
  });

  return v1Router;
}

export function setupRoutes(app, serverManager, taskScheduler) {
  // 轻量健康检查：仅返回存活与版本（信息暴露收口：未认证的 /health
  // 不再暴露 instanceCount/nodeVersion/uptime 运行细节；check-update 依赖的
  // version 保留），不调用 getAllInstances()。/health 挂在 app 上而非常规
  // /api 前缀下，故不经认证、也不受角色门管辖（既有公开语义保持不变）
  app.get('/health', (req, res) => {
    res.json(
      success({
        status: 'ok',
        version: SERVER_VERSION,
      }),
    );
  });

  app.use(API_V1_MOUNT, createApiV1Router(serverManager, taskScheduler));

  app.use(notFoundHandler);
}
