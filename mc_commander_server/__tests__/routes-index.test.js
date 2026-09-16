import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';

// 聚合层路由全部 mock（与 health.test.js 同范式解耦子路由实现）：
// 仅验证 index.js 自身行为——check-update 四分支、根清单、notFoundHandler。
vi.mock('../routes/status.js', () => ({
  createStatusRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/players.js', () => ({
  createPlayerRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/backups.js', () => ({
  createBackupRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/tasks.js', () => ({
  createTaskRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/files.js', () => ({
  createFileRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/server-jar.js', () => ({
  createServerJarRoutes: vi.fn(() => express.Router()),
}));

import { setupRoutes } from '../routes/index.js';
import { errorHandler } from '../middleware/error_handler.js';
import { authMiddleware } from '../middleware/auth.js';
import config from '../config.js';

// 版本号单一来源与 routes/index.js 同源：package.json
const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
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
    it('有更新：latest 与当前版本不同 → hasUpdate true + npm url', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ version: '9.9.9' }),
      });

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data).toEqual({
        current: SERVER_VERSION,
        latest: '9.9.9',
        hasUpdate: true,
        url: `https://www.npmjs.com/package/${config.npmPkgName}/v/9.9.9`,
      });
      // npm registry 查询使用 config.npmPkgName 拼接
      expect(fetchMock).toHaveBeenCalledWith(
        `https://registry.npmjs.org/${config.npmPkgName}/latest`,
        expect.objectContaining({ signal: expect.anything() })
      );
    });

    it('无更新：latest 等于当前版本 → hasUpdate false，latest truthy 时 url 仍返回', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ version: SERVER_VERSION }),
      });

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(200);
      expect(res.body.data.latest).toBe(SERVER_VERSION);
      expect(res.body.data.hasUpdate).toBe(false);
      // url 判断条件是 latest truthy 而非 hasUpdate（锁定当前行为）
      expect(res.body.data.url).toBe(
        `https://www.npmjs.com/package/${config.npmPkgName}/v/${SERVER_VERSION}`
      );
    });

    it('无更新：响应缺 version 字段 → latest null，url undefined', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        current: SERVER_VERSION,
        latest: null,
        hasUpdate: false,
        url: undefined,
      });
    });

    it('npm registry 非 ok → throw 进错误中间件 500（通用文案不泄露状态细节）', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('error');
      expect(res.body.code).toBe(50000);
      expect(res.body.message).toBe('Internal Server Error');
    });

    it('AbortError（5s 超时 abort）→ 优雅降级 offline:true 正常 200', async () => {
      const abortErr = new Error('This operation was aborted');
      abortErr.name = 'AbortError';
      fetchMock.mockRejectedValue(abortErr);

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data).toEqual({
        current: SERVER_VERSION,
        latest: null,
        hasUpdate: false,
        offline: true,
      });
    });

    it('连接错误（UND_ERR_CONNECTABLE）→ 同走优雅降级 offline:true', async () => {
      const connErr = new Error('connect failed');
      connErr.code = 'UND_ERR_CONNECTABLE';
      fetchMock.mockRejectedValue(connErr);

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(200);
      expect(res.body.data.offline).toBe(true);
      expect(res.body.data.hasUpdate).toBe(false);
    });

    it('其他异常（非 AbortError/连接错误）→ 经 asyncHandler 走错误中间件 500', async () => {
      fetchMock.mockRejectedValue(new TypeError('unexpected payload shape'));

      const res = await apiGet('/api/v1/check-update');

      expect(res.status).toBe(500);
      expect(res.body.code).toBe(50000);
      expect(res.body.message).toBe('Internal Server Error');
    });
  });

  describe('GET /api/v1/ 根清单', () => {
    it('endpoints 数组含核心端点且数量锁定，未知路径 404 由 notFoundHandler 收尾', async () => {
      const res = await apiGet('/api/v1/');
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe('v1');
      // 验收指定核心端点
      expect(res.body.data.endpoints).toEqual(
        expect.arrayContaining(['/instances', '/webhooks', '/check-update'])
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
