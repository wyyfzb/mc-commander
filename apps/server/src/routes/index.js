import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { createStatusRoutes } from './status.js';
import { createPlayerRoutes } from './players.js';
import { createBackupRoutes } from './backups.js';
import { createTaskRoutes } from './tasks.js';
import { createFileRoutes } from './files.js';
import { createServerJarRoutes } from './server-jar.js';
import { createKeyRoutes } from './keys.js';
import {
  createMachineCredentialRoutes,
  createMachineCredentialSelfRoutes,
} from './machine_credentials.js';
import { createMetricsRoutes } from './metrics.js';
import { createAuditRoutes } from './audit.js';
import { createWebhookRoutes } from './webhooks.js';
import { createUpgradeRoutes } from './upgrade.js';
import { createMsmpRoutes } from './msmp.js';
import { createPluginRoutes } from './plugins.js';
import { createAuthRoutes } from './auth.js';
import { createHttpsRoutes } from './https.js';
import { createPanelRoutes } from './panel.js';
import { createPreferenceRoutes } from './preferences.js';
import { success } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import config from '../config.js';
import { notFoundHandler } from '../middleware/error_handler.js';
import { requireAdminRole } from '../middleware/auth.js';
import { compareVersions, parseVersion } from '@mc-commander/schemas';

/** 版本号单一来源：package.json（/health、check-update、启动横幅共用，杜绝三处硬编码漂移） */
const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
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
/**
 * @param {{ enabled: boolean, disabledReason: string|null }} tlsState
 *   由启动流程判定的 TLS 监听状态：路由只转发，不自行推导（服务端没在听 TLS
 *   却对外说 enabled，会把用户引到一个打不开的地址上）
 */
export function createApiV1Router(serverManager, taskScheduler, tlsState) {
  const v1Router = Router();
  v1Router.use(requireAdminRole);

  v1Router.use('/', createStatusRoutes(serverManager));
  v1Router.use('/', createPlayerRoutes(serverManager));
  v1Router.use('/', createBackupRoutes(serverManager));
  v1Router.use('/', createTaskRoutes(serverManager, taskScheduler));
  v1Router.use('/', createFileRoutes(serverManager));
  v1Router.use('/', createServerJarRoutes(serverManager));
  v1Router.use('/', createKeyRoutes());
  v1Router.use('/', createMachineCredentialRoutes());
  v1Router.use('/', createMachineCredentialSelfRoutes());
  v1Router.use('/', createMetricsRoutes());
  v1Router.use('/', createAuditRoutes());
  v1Router.use('/', createWebhookRoutes());
  v1Router.use('/', createUpgradeRoutes(serverManager));
  v1Router.use('/', createMsmpRoutes(serverManager));
  v1Router.use('/', createPluginRoutes(serverManager));
  v1Router.use('/', createAuthRoutes());
  v1Router.use('/', createHttpsRoutes(tlsState));
  v1Router.use('/', createPanelRoutes());
  v1Router.use('/', createPreferenceRoutes());

  // GET /api/v1/check-update —— 面板更新检查（Node 内置 fetch，零新增依赖）
  // 取 releases/latest 的 302 Location 读 tag：不消耗 GitHub API 配额、不需要 token。
  // Gitee 优先（国内直连）与部署脚本同口径，取不到再回退 GitHub；两源都失败按离线返回，
  // 不抛 500——「查不到新版本」是正常态，用户需要的是可重试的说明而不是空白。
  v1Router.get(
    '/check-update',
    asyncHandler(async (req, res) => {
      const current = SERVER_VERSION;
      const offline = () =>
        res.json(success({ current, latest: null, hasUpdate: false, offline: true }));
      for (const host of ['https://gitee.com', 'https://github.com']) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
          const r = await fetch(`${host}/${config.repoPath}/releases/latest`, {
            redirect: 'manual',
            signal: ctrl.signal,
          });
          const location = r.headers.get('location');
          // tag 是 Location 的最后一段（`.../releases/tag/v0.9.0`），不带 v 前缀交给比较
          const tag = location?.split('/').pop()?.replace(/^v/, '') ?? null;
          if (!tag || !parseVersion(tag)) continue;
          res.json(
            success({
              current,
              latest: tag,
              hasUpdate: (compareVersions(tag, current) ?? 0) > 0,
              url: `${host}/${config.repoPath}/releases/tag/v${tag}`,
            }),
          );
          return;
        } catch {
          // 单源失败（超时/连接错误/无 Location）不终止：换下一个源
        } finally {
          clearTimeout(timer);
        }
      }
      offline();
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

export function setupRoutes(app, serverManager, taskScheduler, tlsState) {
  // 轻量健康检查：仅返回存活与版本（信息暴露收口：未认证的 /health
  // 不再暴露 instanceCount/nodeVersion/uptime 运行细节；check-update 依赖的
  // version 保留），不调用 getAllInstances()。/health 挂在 app 上而非常规
  // /api 前缀下，故不经认证、也不受角色门管辖（既有公开语义保持不变）
  app.get('/health', (req, res) => {
    // 允许跨源读取：设置页的「这台设备信不信面板证书」检测要从 http 页面打
    // https 端点，同主机不同协议即跨源，而 helmet 默认的 CORP=同源会让已受信的
    // 响应被浏览器丢弃——检测就会把「证书装好了」误报成「还没生效」。
    // 只放开 CORP 不放开 CORS：no-cors 探测只需响应不被拦，响应体仍是不可读的
    // 不透明内容，故这里不新增任何信息暴露面
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.json(
      success({
        status: 'ok',
        version: SERVER_VERSION,
      }),
    );
  });

  app.use(API_V1_MOUNT, createApiV1Router(serverManager, taskScheduler, tlsState));

  app.use(notFoundHandler);
}
