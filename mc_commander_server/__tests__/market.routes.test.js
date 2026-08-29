/**
 * 插件市场路由集成测试（feat-8 延伸：Modrinth 代理端点）
 *
 * got 全量 mock（离线语义）：
 * - 元数据 .json() 链：按 URL 路由 fixture / 拒绝
 * - got.stream：推送真实 zip 字节（安装链路全真，仅网络层离线）
 *
 * 重点覆盖路由层契约：注册顺序（market/* 不被 :file 参数路由吞掉）、
 * 实例存在性校验、查询参数透传、错误码映射、审计 PLUGIN_MARKET_INSTALL。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import AdmZip from 'adm-zip';

vi.mock('got', () => {
  const gotFn = vi.fn();
  gotFn.stream = vi.fn();
  return { default: gotFn };
});

vi.mock('../utils/audit.js', () => ({
  AuditActions: {
    PLUGIN_UPLOAD: 'PLUGIN_UPLOAD',
    PLUGIN_ENABLE: 'PLUGIN_ENABLE',
    PLUGIN_DISABLE: 'PLUGIN_DISABLE',
    PLUGIN_DELETE: 'PLUGIN_DELETE',
    PLUGIN_MARKET_INSTALL: 'PLUGIN_MARKET_INSTALL',
  },
  recordAudit: vi.fn(),
}));

import got from 'got';
import { recordAudit } from '../utils/audit.js';
import { createPluginRoutes } from '../routes/plugins.js';
import { errorHandler } from '../middleware/error_handler.js';
import { clearMarketCache } from '../services/market.service.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-market-routes-'));
const serverPath = path.join(tmpRoot, 'inst1');

const SEARCH_FIXTURE = {
  total_hits: 1,
  hits: [{
    project_id: 'hXiIvTyT',
    slug: 'essentialsx',
    title: 'EssentialsX',
    description: 'd',
    author: 'a',
    downloads: 10,
    follows: 1,
    icon_url: 'https://cdn.modrinth.com/i.png',
    date_modified: '2026-01-01T00:00:00Z',
    display_categories: ['paper'],
    server_side: 'required',
    client_side: 'unsupported',
  }],
};

const JAR = (() => {
  const zip = new AdmZip();
  zip.addFile('plugin.yml', Buffer.from('name: EssentialsX\nversion: 2.21.0\nmain: net.essentialsx.Essentials\n', 'utf8'));
  return zip.toBuffer();
})();

function mockVersionsResponse() {
  return {
    json: async () => [{
      name: 'EssentialsX 2.21.0',
      version_number: '2.21.0',
      version_type: 'release',
      changelog: null,
      date_published: '2026-01-01T00:00:00Z',
      downloads: 1,
      game_versions: ['1.21.4'],
      loaders: ['paper'],
      files: [{ url: 'https://cdn.modrinth.com/data/x/versions/a/EssentialsX-2.21.0.jar', filename: 'EssentialsX-2.21.0.jar', primary: true, size: JAR.length }],
    }],
  };
}

let app;
let mockManager;

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  clearMarketCache();
  fs.rmSync(path.join(serverPath, 'plugins'), { recursive: true, force: true });
  app = express();
  app.use(express.json());
  mockManager = { getInstance: vi.fn() };
  app.use('/api/v1', createPluginRoutes(mockManager));
  app.use(errorHandler);
});

describe('routes/plugins.js - 市场端点', () => {
  it('GET market/search：实例存在返回 200 与搜索结果', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    vi.mocked(got).mockReturnValueOnce({ json: async () => SEARCH_FIXTURE });

    const res = await request(app)
      .get('/api/v1/instances/inst1/plugins/market/search')
      .query({ q: 'essentials' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.totalHits).toBe(1);
    expect(res.body.data.hits[0].slug).toBe('essentialsx');
    // 查询参数透传
    const [url, opts] = vi.mocked(got).mock.calls[0];
    expect(url).toBe('https://api.modrinth.com/v2/search');
    expect(opts.searchParams.query).toBe('essentials');
  });

  it('GET market/search：实例不存在 → 404（market 前缀不被 :file 路由吞掉）', async () => {
    mockManager.getInstance.mockReturnValue(null);
    const res = await request(app).get('/api/v1/instances/nope/plugins/market/search?q=x');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40401);
  });

  it('GET market/search：缺 q → 400 校验错误', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    const res = await request(app).get('/api/v1/instances/inst1/plugins/market/search');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('GET market/versions：200 + 版本映射', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    vi.mocked(got).mockReturnValueOnce(mockVersionsResponse());

    const res = await request(app)
      .get('/api/v1/instances/inst1/plugins/market/projects/essentialsx/versions')
      .query({ game_version: '1.21.4', loader: 'paper' });

    expect(res.status).toBe(200);
    expect(res.body.data.projectSlug).toBe('essentialsx');
    expect(res.body.data.versions).toHaveLength(1);
    expect(res.body.data.versions[0].versionNumber).toBe('2.21.0');
  });

  it('POST market/install：201 + 落盘 + 审计 PLUGIN_MARKET_INSTALL', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    vi.mocked(got).mockReturnValueOnce(mockVersionsResponse());
    vi.mocked(got.stream).mockReturnValueOnce(Readable.from([JAR]));

    const res = await request(app)
      .post('/api/v1/instances/inst1/plugins/market/install')
      .send({ slug: 'essentialsx', versionNumber: '2.21.0' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      file: 'EssentialsX-2.21.0.jar',
      slug: 'essentialsx',
      versionNumber: '2.21.0',
      source: 'modrinth',
      overwritten: false,
    });
    expect(fs.existsSync(path.join(serverPath, 'plugins', 'EssentialsX-2.21.0.jar'))).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst1',
      action: 'PLUGIN_MARKET_INSTALL',
      targetType: 'plugin',
      targetId: 'EssentialsX-2.21.0.jar',
      detail: expect.objectContaining({ source: 'modrinth', slug: 'essentialsx' }),
    }));
  });

  it('POST market/install：上游 404 → 响应体映射 40412', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    const err = new Error('not found');
    err.response = { statusCode: 404 };
    vi.mocked(got).mockReturnValueOnce({ json: async () => { throw err; } });

    const res = await request(app)
      .post('/api/v1/instances/inst1/plugins/market/install')
      .send({ slug: 'ghost', versionNumber: '1.0' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40412);
  });

  it('POST market/install：body 缺字段 → 400', async () => {
    mockManager.getInstance.mockReturnValue({ serverPath });
    const res = await request(app)
      .post('/api/v1/instances/inst1/plugins/market/install')
      .send({ slug: 'essentialsx' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });
});
