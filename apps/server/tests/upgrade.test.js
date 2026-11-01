/**
 * 升级路由 + 升级服务测试
 * - 路由：前置校验矩阵（必填/白名单/404/运行中/重复升级/同版本）+ 202 异步受理
 * - 服务：进度事件序列（backup → download 失败 → rolled_back/failed）
 *
 * 网络隔离：http-client 全量 mock（离线语义），backup.service / db / audit 全 mock，
 * 保证 CI 无外网也能确定性通过。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── 模块 mock（vi.mock 提升，factory 内不得引用外部变量） ──

// httpJson 默认离线拒绝（reject 即最终值，无 .json 链）；但 purpur 现在会先查
// /latest 取 md5 摘要，而以 purpur 为载体的用例需要走到下载阶段，故对该域名
// 返回可解析响应。其余上游一律拒绝，保持「未预期的网络调用必暴露」的隔离语义。
// 升级流程会校验目标版本的 Java 要求，而 Java 探测在真机上扫描 /usr/lib/jvm：
// 结果随环境变化，还会额外写一次 javaPath（打乱对 InstanceModel.update 的断言）。
// 本文件不测 Java 校验（那由 upgrade.java-check.test.js 专门覆盖），故固定为「总是满足」。
vi.mock('../src/utils/java-detector.js', () => ({
  getRecommendedJavaVersion: vi.fn(() => '21'),
  isJavaSatisfied: vi.fn(() => true),
  findJavaPathStrict: vi.fn(() => null),
  findJavaPath: vi.fn(() => 'java'),
  getAllJavaVersions: vi.fn(() => []),
}));

vi.mock('../src/utils/http-client.js', () => ({
  httpJson: vi.fn((url) =>
    String(url).includes('/purpur/')
      ? Promise.resolve({ build: '2416' })
      : Promise.reject(new Error('offline (mocked)')),
  ),
  // httpStream：返回 Node Readable（.on/.pipe/.destroy），此处立刻以 error 事件收场（下载失败载体）
  httpStream: vi.fn(() => {
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
  httpPost: vi.fn(),
}));

// BackupService：备份即完成（触发 backupComplete 事件），restore 恒成功
vi.mock('../src/services/backup.service.js', () => ({
  // 判据导出：upgrade.service 用它决定要不要跑前置备份。既有用例都走「有世界」路径
  hasWorldData: vi.fn(() => true),
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
vi.mock('../src/db/index.js', () => ({
  InstanceModel: { update: vi.fn() },
}));

// 审计：路由层埋点
vi.mock('../src/utils/audit.js', () => ({
  recordAudit: vi.fn(),
  AuditActions: {
    INSTANCE_UPGRADE: 'INSTANCE_UPGRADE',
    INSTANCE_UPGRADE_ROLLBACK: 'INSTANCE_UPGRADE_ROLLBACK',
  },
}));

import { createUpgradeRoutes } from '../src/routes/upgrade.js';
import { UpgradeService, UPGRADE_STAGES, VALID_TYPES } from '../src/services/upgrade.service.js';
import { SERVER_TYPES } from '@mc-commander/schemas';

// 每个用例独立临时目录（beforeEach 在两处 describe 中均可用）
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upgrade-test-'));
});

// ── 桩 serverManager ──
// serverPath 用真实临时目录：路径收口后，resolveSafePath 的逐段
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
    const res = await request.post('/api/v1/instances/inst-1/upgrade').send({ type: 'vanilla' });
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

  it('POST /instances/:id/upgrade - mcVersion 非字符串返回 400 + 结构化 details（契约）', async () => {
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

    // purpur：/latest 摘要查询由 mock 应答，解析后直接进下载阶段 → mock 流报错
    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(/download failed/);

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

  /* 从未启动过的实例没有世界数据，这份备份保护的是空集（升级只改 jar 与 DB 三列，
     各有独立回滚源；唯一的不可逆写入是新版本首启对世界数据的升级）。跳过必须明说：
     静默跳过会让用户在「升级搞坏了」时以为还有一份安全网。 */
  it('无世界数据 ⇒ 跳过前置备份，且进度里明说跳过了（不静默）', async () => {
    const serverManager = createMockServerManager();
    const { hasWorldData } = await import('../src/services/backup.service.js');
    hasWorldData.mockReturnValue(false);
    try {
      const service = new UpgradeService(serverManager);
      // 下载阶段照旧失败：这条用例只关心备份阶段怎么走
      await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
        /download failed/,
      );

      const backupEvents = serverManager._emitted
        .filter((e) => e.event === 'instance:upgradeProgress')
        .map((e) => e.data)
        .filter((d) => d.stage === 'backup');
      // 不成对出现「正在创建备份…」而没有结论
      expect(backupEvents.length).toBe(2);
      expect(backupEvents[0].detail).toBe('正在创建备份...');
      expect(backupEvents[1].detail).toContain('跳过备份');
      // 没有备份就没有 backupId：终态绝不能提「用备份 N 手动恢复」
      expect(service.getUpgradeProgress('inst-1')).toBeNull();
      const finalEvent = serverManager._emitted
        .filter((e) => e.event === 'instance:upgradeProgress')
        .map((e) => e.data)
        .at(-1);
      expect(finalEvent.stage).toBe('failed');
      expect(finalEvent.detail).not.toMatch(/备份 \d+ 手动恢复/);
    } finally {
      hasWorldData.mockReturnValue(true);
    }
  });

  it('有世界数据 ⇒ 照常做前置备份（跳过分支不得在正常实例上触发）', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);
    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(/download failed/);
    // 「备份完成」只会在 _createBackupAndWait 收到 backupComplete 回执后发出 ⇒
    // 它出现即证明备份服务真被调用了（不是靠跳过分支一路绿灯）
    const backupDetails = serverManager._emitted
      .filter((e) => e.event === 'instance:upgradeProgress')
      .map((e) => e.data)
      .filter((d) => d.stage === 'backup')
      .map((d) => d.detail);
    expect(backupDetails).toContain('备份完成');
    expect(backupDetails.some((d) => String(d).includes('跳过备份'))).toBe(false);
  });

  it('实例不存在直接抛错', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);
    await expect(service.upgrade('ghost', '1.21.4', 'purpur')).rejects.toThrow(
      'Instance not found',
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

describe('升级请求的 loaderVersion 透传', () => {
  // fabric/forge 的入口 jar 由 loader 版本决定：路由层丢掉这个字段，用户选了
  // 也不会生效，而失败要等到首启校验才暴露（模组按 loader 版本声明硬依赖）。
  // 断言点是**真实路由**把字段交给服务层，故 spy 服务层原型而非自建一条假路由
  it('fabric + loaderVersion → 服务层 upgrade() 收到该 loader', async () => {
    const serverManager = createMockServerManager();
    const spy = vi.spyOn(UpgradeService.prototype, 'upgrade').mockResolvedValue(undefined);
    try {
      const res = await supertest(createApp(serverManager))
        .post('/api/v1/instances/inst-1/upgrade')
        .send({ mcVersion: '1.21.4', type: 'fabric', loaderVersion: '0.16.14' });
      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith('inst-1', '1.21.4', 'fabric', '0.16.14');
    } finally {
      spy.mockRestore();
    }
  });

  it('不传 loaderVersion → 服务层收到 undefined（由上游取最新稳定版）', async () => {
    const serverManager = createMockServerManager();
    const spy = vi.spyOn(UpgradeService.prototype, 'upgrade').mockResolvedValue(undefined);
    try {
      const res = await supertest(createApp(serverManager))
        .post('/api/v1/instances/inst-1/upgrade')
        .send({ mcVersion: '1.21.4', type: 'forge' });
      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith('inst-1', '1.21.4', 'forge', undefined);
    } finally {
      spy.mockRestore();
    }
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

  it('VALID_TYPES 与契约包 SERVER_TYPES 同源（五种类型，不再各写一份）', () => {
    expect([...VALID_TYPES].sort()).toEqual([...SERVER_TYPES].sort());
    expect(VALID_TYPES.has('fabric')).toBe(true);
    expect(VALID_TYPES.has('forge')).toBe(true);
  });
});
