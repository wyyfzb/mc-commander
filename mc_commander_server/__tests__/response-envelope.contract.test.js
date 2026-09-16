import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import request from 'supertest';
import express from 'express';
import {
  fileListResponseSchema,
  fileMkdirResponseSchema,
  fileRenameResponseSchema,
  pluginListSchema,
  pluginDeleteResultSchema,
  upgradeStatusResponseSchema,
} from '@mc-commander/schemas';

vi.mock('../services/plugin.service.js', () => ({
  listPlugins: vi.fn(() => ({
    plugins: [{
      file: 'vault.jar',
      name: 'vault',
      enabled: true,
      sizeBytes: 1024,
      mtimeMs: 1760000000000,
      meta: null,
    }],
  })),
  deletePlugin: vi.fn(() => ({ deleted: 'vault.jar' })),
  uploadPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  readPluginMeta: vi.fn(() => null),
}));

vi.mock('../services/market.service.js', () => ({
  searchMarketPlugins: vi.fn(),
  getMarketProjectVersions: vi.fn(),
  installPluginFromMarket: vi.fn(),
  checkPluginUpdates: vi.fn(),
}));

const upgradeMocks = { isUpgrading: () => false, getUpgradeProgress: () => null };
vi.mock('../services/upgrade.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // 普通 function 实现：路由层以 new UpgradeService(serverManager) 构造
    UpgradeService: vi.fn(function () { return upgradeMocks; }),
  };
});

import { setupRoutes } from '../routes/index.js';
import { errorHandler } from '../middleware/error_handler.js';
import { deletePlugin } from '../services/plugin.service.js';

// 简易 mock serverManager（与 files.enhanced.test.js 同模式）
function createMockServerManager(serversDir) {
  const instances = new Map();
  return {
    getInstance(id) {
      return instances.get(id);
    },
    instances,
    createInstance(id) {
      const serverPath = path.join(serversDir, id);
      fs.mkdirSync(serverPath, { recursive: true });
      instances.set(id, { id, serverPath, isRunning: false });
      return instances.get(id);
    },
  };
}

let app, serverManager, tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-envelope-test-'));
  serverManager = createMockServerManager(tmpDir);
  serverManager.createInstance('test-inst');
  upgradeMocks.isUpgrading = () => false;
  upgradeMocks.getUpgradeProgress = () => null;

  app = express();
  app.use(express.json());
  // 认证层替身：v1 角色门要求显式角色（无 req.auth 一律 403），故此处直接落 admin 角色
  app.use('/api/v1', (req, res, next) => {
    req.auth = { source: 'test', role: 'admin' };
    next();
  });
  setupRoutes(app, serverManager, null);
  app.use(errorHandler);
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('响应信封契约观测（issue 402：validatedSuccess 接入后的全链路验证）', () => {
  it('files 列表：信封结构不变且 data 与 fileListResponseSchema 一致', async () => {
    const res = await request(app).get('/api/v1/instances/test-inst/files?path=/');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const parsed = fileListResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
  });

  it('files mkdir：data 与 fileMkdirResponseSchema 一致（新增契约）', async () => {
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/mkdir')
      .send({ path: '/newdir' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.message).toBe('Directory created successfully');
    const parsed = fileMkdirResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
  });

  it('files rename：data 与 fileRenameResponseSchema 一致（新增契约）', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test-inst', 'a.txt'), 'hello');
    const res = await request(app)
      .post('/api/v1/instances/test-inst/files/rename')
      .send({ path: '/a.txt', newPath: '/b.txt' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const parsed = fileRenameResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
  });

  it('plugins 列表：信封结构不变且 data 与 pluginListSchema 一致', async () => {
    const res = await request(app).get('/api/v1/instances/test-inst/plugins');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const parsed = pluginListSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
  });

  it('plugins 删除：data 与 pluginDeleteResultSchema 一致（新增契约）', async () => {
    const res = await request(app).delete('/api/v1/instances/test-inst/plugins/vault.jar');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(deletePlugin).toHaveBeenCalled();
    const parsed = pluginDeleteResultSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
  });

  it('upgrade status 空闲分支：data 与 upgradeStatusResponseSchema 一致（新增契约）', async () => {
    const res = await request(app).get('/api/v1/instances/test-inst/upgrade/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data).toEqual({ upgrading: false });
    const parsed = upgradeStatusResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
  });

  it('upgrade status 升级中分支：data 与 upgradeStatusResponseSchema 一致（新增契约）', async () => {
    upgradeMocks.isUpgrading = () => true;
    upgradeMocks.getUpgradeProgress = () => ({
      instanceId: 'test-inst',
      stage: 'download',
      percent: 40,
      detail: 'downloading jar',
      timestamp: 1760000000000,
    });
    const res = await request(app).get('/api/v1/instances/test-inst/upgrade/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.upgrading).toBe(true);
    const parsed = upgradeStatusResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
  });
});
