import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';

// 聚合层路由全部 mock（与 health.test.js 同范式解耦子路由实现）：
// 仅验证 index.js 自身行为——check-update 四分支、根清单、notFoundHandler。
vi.mock('../src/routes/status.js', () => ({
  createStatusRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../src/routes/players.js', () => ({
  createPlayerRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../src/routes/backups.js', () => ({
  createBackupRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../src/routes/tasks.js', () => ({
  createTaskRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../src/routes/files.js', () => ({
  createFileRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../src/routes/server-jar.js', () => ({
  createServerJarRoutes: vi.fn(() => express.Router()),
}));

import { setupRoutes } from '../src/routes/index.js';
import { errorHandler } from '../src/middleware/error_handler.js';
import { authMiddleware } from '../src/middleware/auth.js';
import config from '../src/config.js';

// 版本号单一来源与 routes/index.js 同源：package.json
const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version;

// 测试用明文 Key（与 vitest.config.js 注入的 API_KEY_HASH 一致）
const TEST_API_KEY = 'test-api-key-for-unit-tests';

describe('routes/index.js 聚合层', () => {
  let app;
  const fetchMock = vi.fn();

  // v1 角色门要求显式角色（无 req.auth 一律 403），故必须与生产同序挂上认证层：
  // 本文件不 mock 认证层，用真实 authMiddleware（API Key 分支只比摘要、不触库）
  const apiGet = (url) => request(app).get(url).set('X-API-Key', TEST_API_KEY);

  beforeAll(() => {
    app = express();
    app.use('/api/', authMiddleware);
    setupRoutes(app, { instances: new Map() }, {});
    // 与生产组装（index.js L189-191）同序：setupRoutes 之后挂 errorHandler，
    // check-update 的意外异常经 asyncHandler 透传，跳过普通中间件 notFoundHandler 由 errorHandler 接住
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  describe('GET /api/v1/check-update', () => {
    /** 造一个 releases/latest 的 302 响应（Location 的最后一段是 tag） */
    function redirect(tag) {
      return {
        status: 302,
        headers: {
          get: (k) =>
            k.toLowerCase() === 'location'
              ? `https://gitee.com/${config.repoPath}/releases/tag/${tag}`
              : null,
        },
      };
    }

    it('有新版本：tag 高于当前版本 → hasUpdate true + releases 链接', async () => {
      fetchMock.mockResolvedValue(redirect('v9.9.9'));

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        current: SERVER_VERSION,
        latest: '9.9.9',
        hasUpdate: true,
        url: `https://gitee.com/${config.repoPath}/releases/tag/v9.9.9`,
      });
      // 首选 Gitee（与部署脚本同口径），且靠 Location 头取值、不解析响应体
      expect(fetchMock).toHaveBeenCalledWith(
        `https://gitee.com/${config.repoPath}/releases/latest`,
        expect.objectContaining({ redirect: 'manual', signal: expect.anything() }),
      );
    });

    it('无新版本：tag 等于当前版本 → hasUpdate false', async () => {
      fetchMock.mockResolvedValue(redirect(`v${SERVER_VERSION}`));

      const res = await apiGet('/api/v1/check-update');

      expect(res.body.data.latest).toBe(SERVER_VERSION);
      expect(res.body.data.hasUpdate).toBe(false);
    });

    it('旧版本（回退过）不算有更新：0.8.0 对 0.9.0 → false', async () => {
      // 字符串比较会把 0.8.0 判成更新，故必须逐段数值比较
      fetchMock.mockResolvedValue(redirect('v0.8.0'));

      const res = await apiGet('/api/v1/check-update');

      expect(res.body.data.hasUpdate).toBe(false);
    });

    it('Gitee 取不到 → 回退 GitHub，仍能拿到版本', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      // 与 redirect() 同一构造函数：写死 `get: () => 值` 的桩会吞掉参数名，
      // 把实现改成读别的头也照样绿（实测打穿）
      fetchMock.mockResolvedValueOnce(redirect('v9.9.9'));

      const res = await apiGet('/api/v1/check-update');

      expect(res.body.data.latest).toBe('9.9.9');
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `https://github.com/${config.repoPath}/releases/latest`,
        expect.objectContaining({ redirect: 'manual' }),
      );
    });

    it('两源都取不到 → 降级 offline:true 且 200，不抛 500', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        current: SERVER_VERSION,
        latest: null,
        hasUpdate: false,
        offline: true,
      });
    });

    it('Location 缺失或不是合法版本号 → 视为该源失败，继续降级', async () => {
      fetchMock.mockResolvedValue({ status: 302, headers: { get: () => null } });

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(200);
      expect(res.body.data.offline).toBe(true);
      // 两个源都试过
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('超时（AbortError）→ 同样降级 offline:true', async () => {
      const abortErr = new Error('This operation was aborted');
      abortErr.name = 'AbortError';
      fetchMock.mockRejectedValue(abortErr);

      const res = await apiGet('/api/v1/check-update');

      expect(res.body.data.offline).toBe(true);
    });

    it('5 秒超时链路真的会 abort：请求悬挂时到点即断，不是「等上游自己失败」', async () => {
      // 上一条只造了个 AbortError 丢给 mock，超时链路一次都没跑过——把 setTimeout 的
      // 回调改成空函数（永不 abort）时它照样绿。
      // 不能用假定时器：supertest 走真实 socket，假定时器会让请求永远不返回。
      // 故只把实现里那个 5 秒定时器缩短到 0，其余定时器保持真实。
      const realSetTimeout = globalThis.setTimeout;
      const shorten = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
        const real = globalThis.setTimeout === shorten ? realSetTimeout : globalThis.setTimeout;
        return real(fn, ms >= 1000 ? 0 : ms, ...rest);
      });
      let aborted = 0;
      fetchMock.mockImplementation(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              aborted += 1;
              const err = new Error('This operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      try {
        const res = await apiGet('/api/v1/check-update');
        // 两个源各悬挂一次、各被超时掐断一次：说明第一个源超时后确实换源重试
        expect(aborted).toBe(2);
        expect(res.status).toBe(200);
        expect(res.body.data.offline).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        shorten.mockRestore();
      }
    });
  });

  describe('GET /api/v1/ 根清单', () => {
    it('endpoints 数组含核心端点且数量锁定，未知路径 404 由 notFoundHandler 收尾', async () => {
      const res = await apiGet('/api/v1/');
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe('v1');
      // 验收指定核心端点
      expect(res.body.data.endpoints).toEqual(
        expect.arrayContaining(['/instances', '/webhooks', '/check-update']),
      );
      // 清单数量锁定（23 项，防漂移）
      expect(res.body.data.endpoints).toHaveLength(23);

      // 未匹配路径穿透至 setupRoutes 尾部 notFoundHandler
      const nf = await apiGet('/api/v1/nonexistent');
      expect(nf.status).toBe(404);
      expect(nf.body.status).toBe('error');
      expect(nf.body.code).toBe(40400);
      expect(nf.body.message).toBe('Route GET /api/v1/nonexistent not found');
    });
  });
});
