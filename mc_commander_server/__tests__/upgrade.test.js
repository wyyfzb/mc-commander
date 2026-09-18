/**
 * 升级路由 + 升级服务测试（P0-4）
 * - 路由：前置校验矩阵（必填/白名单/404/运行中/重复升级/同版本）+ 202 异步受理
 * - 服务：进度事件序列（backup → download 失败 → rolled_back/failed）
 *
 * 网络隔离：got 全量 mock（离线语义），backup.service / db / audit 全 mock，
 * 保证 CI 无外网也能确定性通过。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── 模块 mock（vi.mock 提升，factory 内不得引用外部变量） ──

// got：函数调用（.json 链）直接离线拒绝；stream 返回立即 error 的伪流
vi.mock('got', () => ({
  default: Object.assign(vi.fn(() => Promise.reject(new Error('offline (mocked)'))), {
    stream: vi.fn(() => {
      const listeners = {};
      const stream = {
        on(ev, cb) {
          (listeners[ev] = listeners[ev] || []).push(cb);
          return stream;
        },
        pipe() {
          return stream;
        },
        destroy() {},
      };
      queueMicrotask(() => {
        (listeners.error || []).forEach((cb) => cb(new Error('download failed (mocked)')));
      });
      return stream;
    }),
  }),
}));

// BackupService：备份即完成（触发 backupComplete 事件），restore 恒成功
vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    constructor(serverManager) {
      this.serverManager = serverManager;
    }
    async createBackup(instanceId) {
      this.serverManager.emit('instance:backupComplete', { instanceId, backupId: 'bk-mock' });
      return 'bk-mock';
    }
    async restoreBackup() {
      return { restored: true };
    }
  },
}));

// db：升级流程中的 InstanceModel.update（替换阶段 + 回滚回写）
vi.mock('../db/index.js', () => ({
  InstanceModel: { update: vi.fn() },
}));

// 审计：路由层埋点
vi.mock('../utils/audit.js', () => ({
  recordAudit: vi.fn(),
  AuditActions: {
    INSTANCE_UPGRADE: 'INSTANCE_UPGRADE',
    INSTANCE_UPGRADE_ROLLBACK: 'INSTANCE_UPGRADE_ROLLBACK',
  },
}));

import { createUpgradeRoutes } from '../routes/upgrade.js';
import { UpgradeService, UPGRADE_STAGES, VALID_TYPES } from '../services/upgrade.service.js';

// 每个用例独立临时目录（beforeEach 在两处 describe 中均可用）
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upgrade-test-'));
});

// ── 桩 serverManager ──
// serverPath 用真实临时目录：S-P0-2 路径收口后，resolveSafePath 的逐段
// realpath 防线要求实例目录真实存在（与生产语义一致）
let tmpDir;

function createMockInstance(overrides = {}) {
  return {
    id: 'inst-1',
    name: 'Test Server',
    // 不虚构 status 字段：真实 ManagedInstance 上只有 isRunning，桩多给一个
    // 字段会让「守卫读错字段」保持绿灯（本套件曾因此掩盖 409 守卫恒假）
    mcVersion: '1.20.4',
    jarFile: 'server-1.20.4.jar',
    serverPath: tmpDir,
    isRunning: false,
    ...overrides,
  };
}

function createMockServerManager(instanceOverrides = {}) {
  const instance = createMockInstance(instanceOverrides);
  const listeners = {};
  const emitted = [];
  return {
    getInstance: vi.fn((id) => (id === instance.id ? instance : null)),
    on: vi.fn((event, fn) => {
      (listeners[event] = listeners[event] || []).push(fn);
    }),
    removeListener: vi.fn((event, fn) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      }
    }),
    emit: vi.fn((event, data) => {
      emitted.push({ event, data });
      // 真实分发：UpgradeService._createBackupAndWait 依赖事件回执
      (listeners[event] || []).forEach((fn) => fn(data));
    }),
    _instance: instance,
    _emitted: emitted,
  };
}

function createApp(serverManager) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin' };
    next();
  });
  app.use('/api/v1', createUpgradeRoutes(serverManager));
  return app;
}

describe('Upgrade Routes', () => {
  let serverManager;
  let request;

  beforeEach(() => {
    serverManager = createMockServerManager();
    request = supertest(createApp(serverManager));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /instances/:id/upgrade - mcVersion 必填返回 400', async () => {
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ type: 'vanilla' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('POST /instances/:id/upgrade - 无效 type 返回 400', async () => {
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ mcVersion: '1.21.4', type: 'bukkit' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toMatch(/Invalid type/);
    expect(res.body.details.some((d) => d.path === 'type')).toBe(true);
  });

  it('POST /instances/:id/upgrade - mcVersion 非字符串返回 400 + 结构化 details（issue 391 契约）', async () => {
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ mcVersion: 123, type: 'vanilla' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.details.some((d) => d.path === 'mcVersion')).toBe(true);
  });

  it('POST /instances/:id/upgrade - 实例不存在返回 404', async () => {
    const res = await request
      .post('/api/v1/instances/nonexist/upgrade')
      .send({ mcVersion: '1.21.4', type: 'vanilla' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40401);
  });

  it('POST /instances/:id/upgrade - 实例运行中返回 409（INSTANCE_RUNNING CONFLICT）', async () => {
    serverManager._instance.isRunning = true;
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ mcVersion: '1.21.4', type: 'vanilla' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40003);
  });

  it('POST /instances/:id/upgrade - 目标版本与当前相同返回 400（40012）', async () => {
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ mcVersion: '1.20.4', type: 'vanilla' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40012);
  });

  it('POST /instances/:id/upgrade - 正常受理返回 202', async () => {
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ mcVersion: '1.21.4', type: 'purpur' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.instanceId).toBe('inst-1');
    expect(res.body.data.mcVersion).toBe('1.21.4');
  });

  it('POST /instances/:id/upgrade - 默认 type=vanilla', async () => {
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ mcVersion: '1.21.4' });
    expect(res.status).toBe(202);
    expect(res.body.data.type).toBe('vanilla');
  });

  it('GET /instances/:id/upgrade/status - 无升级返回 upgrading:false', async () => {
    const res = await request.get('/api/v1/instances/inst-1/upgrade/status');
    expect(res.status).toBe(200);
    expect(res.body.data.upgrading).toBe(false);
  });
});

describe('UpgradeService 进度序列（离线 mock）', () => {
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backup → download 失败 → rolled_back/failed，且清理升级状态', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);

    // purpur：resolveDownloadUrl 无网络调用，直接进下载阶段 → mock 流报错
    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      /download failed/
    );

    const stages = serverManager._emitted
      .filter((e) => e.event === 'instance:upgradeProgress')
      .map((e) => e.data.stage);
    // 完整生命周期：备份两拍 → 下载两拍 → 回滚 → 失败终态
    expect(stages[0]).toBe('backup');
    expect(stages).toContain('download');
    expect(stages[stages.length - 1]).toBe('failed');
    expect(stages).toContain('rolled_back');

    // 终态后不再处于升级中
    expect(service.isUpgrading('inst-1')).toBe(false);
    expect(service.getUpgradeProgress('inst-1')).toBeNull();
  });

  it('实例不存在直接抛错', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);
    await expect(service.upgrade('ghost', '1.21.4', 'purpur')).rejects.toThrow(
      'Instance not found'
    );
  });

  it('getUpgradeProgress / isUpgrading 反映注入的进度', () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);
    expect(service.isUpgrading('inst-1')).toBe(false);
    expect(service.getUpgradeProgress('inst-1')).toBeNull();

    service._emitProgress('inst-1', UPGRADE_STAGES.DOWNLOAD, 42, 'downloading');
    expect(service.isUpgrading('inst-1')).toBe(true);
    expect(service.getUpgradeProgress('inst-1')).toMatchObject({
      instanceId: 'inst-1',
      stage: 'download',
      percent: 42,
      detail: 'downloading',
    });
  });
});

describe('UPGRADE_STAGES 常量完整性', () => {
  it('包含所有预期阶段', () => {
    expect(UPGRADE_STAGES.BACKUP).toBe('backup');
    expect(UPGRADE_STAGES.DOWNLOAD).toBe('download');
    expect(UPGRADE_STAGES.REPLACE).toBe('replace');
    expect(UPGRADE_STAGES.VERIFY).toBe('verify');
    expect(UPGRADE_STAGES.COMPLETED).toBe('completed');
    expect(UPGRADE_STAGES.FAILED).toBe('failed');
    expect(UPGRADE_STAGES.ROLLED_BACK).toBe('rolled_back');
  });

  it('VALID_TYPES 包含三种服务端类型', () => {
    expect(VALID_TYPES.has('vanilla')).toBe(true);
    expect(VALID_TYPES.has('paper')).toBe(true);
    expect(VALID_TYPES.has('purpur')).toBe(true);
    expect(VALID_TYPES.has('fabric')).toBe(false);
    expect(VALID_TYPES.has('forge')).toBe(false);
  });
});
