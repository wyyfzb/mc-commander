/**
 * 部署进度兜底端点与重复部署门控测试
 *
 * 覆盖 routes/server-jar.js：
 * - GET /instances/deploy/status：空态（无部署/快照超时）不返回 404，
 *   在途时返回自包含快照（实例归属 + 阶段 + 字节数 + updatedAt），与契约 schema 一致
 * - POST /instances/deploy：服务端已有在途部署时 409 拒绝（重复部署门控），
 *   且在触达网络/落库之前短路
 *
 * mock 边界（对齐 server-jar.deploy.chain.test.js 范式）：仅替身外部依赖，
 * 数据一律虚构（1.2.3.4 / paper-xxxx / Steve）
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { deployStatusResponseSchema } from '@mc-commander/schemas';

const testState = vi.hoisted(() => ({ serversDir: null }));

vi.mock('../db/index.js', () => ({
  InstanceModel: { create: vi.fn() },
  AuditLogModel: { create: vi.fn() },
}));

// 实例目录挂系统临时目录：写死 POSIX 形态（'/tmp/...'）在 Windows 上会被解析成
// 「当前盘根 + /tmp」（path.resolve 的盘符相对语义），落点既不跨平台也不受
// vitest 的临时根管辖，且用完不清理——与 server-jar.deploy.chain.test.js 同款
vi.mock('../config.js', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  testState.serversDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcs-deploy-status-'));
  return { default: { serversDir: testState.serversDir } };
});

vi.mock('minecraft-core', () => ({
  MinecraftServerManager: class {
    async getVersions() {
      return [];
    }
    async getLatestBuild() {
      return {};
    }
  },
  NodeAdapter: class {},
}));

vi.mock('../utils/java-detector.js', () => ({
  getRecommendedJavaVersion: vi.fn(() => '21'),
  findJavaPath: vi.fn(() => '/usr/bin/java'),
}));

vi.mock('../services/mc_server.js', () => ({ atomicWriteFile: vi.fn() }));

vi.mock('../utils/http-client.js', () => ({
  // 本组只测状态兜底与重复部署门控，上游一律不可达（httpJson 直接 reject）
  httpJson: vi.fn(() => Promise.reject(new Error('no network in test'))),
  httpStream: vi.fn(),
  // 具名导出必须齐全：SUT 用 ESM 具名导入，缺一个即模块解析期整体失败
  httpPost: vi.fn(),
}));

const { createServerJarRoutes } = await import('../routes/server-jar.js');
const { InstanceModel, AuditLogModel } = await import('../db/index.js');
const { errorHandler } = await import('../middleware/error_handler.js');

/** 在途快照（结构占位：虚构实例归属） */
function inFlightSnapshot(overrides = {}) {
  return {
    instanceId: 'paper-a1b2c3d4',
    instanceName: '生存服',
    type: 'paper',
    mcVersion: '1.21.4',
    stage: 'download',
    percent: 0.45,
    transferred: 52_428_800,
    total: 104_857_600,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function buildApp(entries = []) {
  const app = express();
  app.use(express.json());
  const manager = { activeDeploys: new Map(entries), emit: vi.fn(), loadInstances: vi.fn() };
  app.use('/api/v1', createServerJarRoutes(manager));
  app.use(errorHandler);
  return { app, manager };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  const fsp = await import('node:fs/promises');
  if (testState.serversDir) {
    await fsp.rm(testState.serversDir, { recursive: true, force: true });
  }
});

describe('GET /instances/deploy/status', () => {
  it('无部署：200 空态 { deploying: false }（不用 404）', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/v1/instances/deploy/status');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deploying: false });
    expect(deployStatusResponseSchema.safeParse(res.body.data).success).toBe(true);
  });

  it('activeDeploys 缺失（旧 manager 形态）：仍返回空态而非 500', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createServerJarRoutes({ emit: vi.fn() }));
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/instances/deploy/status');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deploying: false });
  });

  it('在途部署：返回自包含快照（实例归属 + 阶段 + 字节数 + 时刻）且与契约一致', async () => {
    const snapshot = inFlightSnapshot();
    const { app } = buildApp([[snapshot.instanceId, snapshot]]);

    const res = await request(app).get('/api/v1/instances/deploy/status');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deploying: true, ...snapshot });
    expect(deployStatusResponseSchema.safeParse(res.body.data).success).toBe(true);
  });

  it('死快照（超过时限未更新）：按空态返回，避免前端永久卡在「部署中」', async () => {
    const snapshot = inFlightSnapshot({ updatedAt: Date.now() - 16 * 60 * 1000 });
    const { app } = buildApp([[snapshot.instanceId, snapshot]]);

    const res = await request(app).get('/api/v1/instances/deploy/status');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deploying: false });
  });
});

describe('POST /instances/deploy 重复部署门控', () => {
  const payload = {
    type: 'paper',
    mcVersion: '1.21.4',
    instanceName: '生存服',
    maxMemory: '2G',
  };

  it('服务端已有在途部署：409 DEPLOY_IN_PROGRESS，且不落审计/不触达上游', async () => {
    const snapshot = inFlightSnapshot();
    const { app } = buildApp([[snapshot.instanceId, snapshot]]);

    const res = await request(app).post('/api/v1/instances/deploy').send(payload);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40905);
    expect(AuditLogModel.create).not.toHaveBeenCalled();
    expect(InstanceModel.create).not.toHaveBeenCalled();
  });

  it('死快照不构成门控：早已超时的在途记录不阻塞新部署', async () => {
    const snapshot = inFlightSnapshot({ updatedAt: Date.now() - 16 * 60 * 1000 });
    const { app } = buildApp([[snapshot.instanceId, snapshot]]);

    const res = await request(app).post('/api/v1/instances/deploy').send(payload);

    // 放行到部署主体（上游不可达 → 502），不是 409
    expect(res.status).not.toBe(409);
    expect(AuditLogModel.create).toHaveBeenCalled();
  });
});
