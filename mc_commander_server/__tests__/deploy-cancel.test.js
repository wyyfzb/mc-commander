/**
 * 部署取消（issue：长任务取消能力）服务端行为面：
 * - 取消端点受理语义：无在途 → 409 40906；instanceId 不匹配 → 409 且不动在途任务
 * - 取消落点各异（下载中 / 首启中）都收敛到同一终态：cancelled 进度事件 +
 *   实例目录清理 + 注册表清空 + 未完成情形下的 DB 行回滚 + 部署 POST 回 409 40915
 * - 幂等：重复取消第二次 409；取消后注册表已释放可再次发起部署（不被 DEPLOY_IN_PROGRESS 拦）
 * 数据全部为虚构占位（1.2.3.4 / 演示实例）
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

const testState = vi.hoisted(() => ({
  serversDir: null,
  spawnBehavior: 'exit0',
  latestBuild: {},
}));

const httpState = vi.hoisted(() => ({ streamImpl: null, manifestPromise: null }));

vi.mock('../db/index.js', () => ({
  InstanceModel: {
    create: vi.fn(),
    delete: vi.fn(),
  },
  AuditLogModel: { create: vi.fn() },
}));

vi.mock('../config.js', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  testState.serversDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcs-deploy-cancel-'));
  return { default: { serversDir: testState.serversDir } };
});

vi.mock('minecraft-core', () => ({
  MinecraftServerManager: class {
    async getVersions() {
      return [];
    }
    async getLatestBuild() {
      return testState.latestBuild;
    }
    async downloadServer() {
      return {};
    }
  },
  NodeAdapter: class {},
}));

vi.mock('../utils/java-detector.js', () => ({
  getRecommendedJavaVersion: vi.fn(() => '21'),
  findJavaPath: vi.fn(() => '/usr/bin/java'),
}));

vi.mock('../services/mc_server.js', async () => {
  const fsSync = await import('node:fs');
  return { atomicWriteFile: (p, c) => fsSync.writeFileSync(p, c) };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const events = await import('node:events');
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
    spawn: vi.fn(() => {
      const proc = new events.EventEmitter();
      proc.stdout = new events.EventEmitter();
      proc.stderr = new events.EventEmitter();
      proc.pid = 42424;
      proc.kill = vi.fn();
      if (testState.spawnBehavior === 'exit0') {
        queueMicrotask(() => proc.emit('exit', 0));
      }
      // 'hang'：不发射任何事件（用于停在工作中的阶段等待取消）
      return proc;
    }),
  };
});

// 三个具名导出都要给：SUT（server-jar.js）用 ESM 具名导入，缺一个就是模块解析期报错
vi.mock('../utils/http-client.js', async () => {
  const streamMod = await import('node:stream');
  return {
    // vanilla 构建解析已改走 Piston manifest（与升级共用一份实现）。
    // 夹具接缝仍是 testState.latestBuild —— 由它合成 Piston 形状的响应。
    httpJson: vi.fn((url) => {
      const u = String(url);
      if (u.includes('version_manifest_v2.json')) {
        // 用例可挂住「版本查询」这一窗口（manifestPromise 未设时立即返回）
        if (httpState.manifestPromise) return httpState.manifestPromise;
        return Promise.resolve({
          latest: { release: '1.21.4' },
          versions: [
            {
              id: '1.21.4',
              type: 'release',
              url: 'https://piston-meta.mojang.com/v1/packages/uat/1.21.4.json',
            },
          ],
        });
      }
      if (u.includes('/v1/packages/uat/')) {
        const art = testState.latestBuild?.downloads?.application;
        return Promise.resolve(
          art ? { downloads: { server: { url: art.url, sha1: art.hash } } } : { downloads: {} },
        );
      }
      return Promise.resolve({});
    }),
    httpPost: vi.fn(),
    httpStream: vi.fn((url, opts) => httpState.streamImpl(url, opts, streamMod)),
  };
});

const { createServerJarRoutes } = await import('../routes/server-jar.js');
const { httpStream } = await import('../utils/http-client.js');
const { InstanceModel, AuditLogModel } = await import('../db/index.js');
const { errorHandler } = await import('../middleware/error_handler.js');

const JAR_BYTES = Buffer.from('fake-server-jar-payload');
/** vanilla 走 Piston 时摘要只有 sha1 一种口径（见 services/vanilla-manifest.js） */
const JAR_SHA1 = crypto.createHash('sha1').update(JAR_BYTES).digest('hex');

/**
 * 下载流：正常完成（写完即 end）。
 * 第三参 streamMod 由 mock 工厂注入（工厂在模块级只 import 一次），
 * 便于工厂与假流共用同一份 node:stream。
 */
function completingStream(jarBytes) {
  return (url, opts, streamMod) => {
    const pt = new streamMod.PassThrough();
    queueMicrotask(() => {
      pt.emit('downloadProgress', {
        // percent 与 transferred/total 自洽（半程），忠实 httpStream 的产出形状
        percent: 0.5,
        transferred: jarBytes.length / 2,
        total: jarBytes.length,
      });
      pt.write(jarBytes);
      pt.end();
    });
    return pt;
  };
}

/**
 * 下载流：永不结束（停在下载阶段，等待取消中断）。
 * 返回真实 PassThrough：SUT 以 pipe() 接文件写流收尾，取消路径对该流调 .destroy()
 */
function hangingStream() {
  return (url, opts, streamMod) => new streamMod.PassThrough();
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const mockManager = { activeDeploys: new Map(), emit: vi.fn(), loadInstances: vi.fn() };
  app.use('/api', createServerJarRoutes(mockManager));
  app.use(errorHandler);
  return { app, manager: mockManager };
}

/** 轮询直到条件成立（部署流程本身是异步的，事件循环推进若干次即可观察到阶段） */
async function waitFor(predicate, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('waitFor: 条件在预期轮次内未成立');
}

/**
 * 发起部署请求并立即派发：superagent 的请求只有 .then()/.end() 才真正发出，
 * 只创建 Test 对象就等（`await` 之前）在途部署根本不存在，取消端点会回「无可取消对象」
 */
function startDeploy(app, body) {
  return request(app)
    .post('/api/instances/deploy')
    .send(body)
    .then((res) => res);
}

/** 从进度事件里取服务端生成的部署实例 id */
function deployId(manager) {
  for (const call of manager.emit.mock.calls) {
    const [event, payload] = call;
    if (event === 'deployProgress' && payload?.instanceId) return payload.instanceId;
  }
  return null;
}

/** 进度事件中的阶段序列 */
function stages(manager) {
  return manager.emit.mock.calls
    .filter(([event]) => event === 'deployProgress')
    .map(([, payload]) => payload.stage);
}

const DEPLOY_BODY = {
  type: 'vanilla',
  mcVersion: '1.21.4',
  instanceName: '演示实例',
  maxMemory: '2G',
  eula: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  testState.spawnBehavior = 'exit0';
  // minecraft-core 的真实返回形状：摘要只在 downloads.application 的 hash + hashType
  testState.latestBuild = {
    downloads: {
      application: {
        url: 'https://piston-data.mojang.com/server.jar',
        // vanilla 的摘要只来自 Piston 的 sha1；给 sha256 会被当作 sha1 比对而失败
        hash: JAR_SHA1,
      },
    },
  };
  httpState.streamImpl = completingStream(JAR_BYTES);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const fsp = await import('node:fs/promises');
  if (testState.serversDir) await fsp.rm(testState.serversDir, { recursive: true, force: true });
});

describe('POST /instances/deploy/cancel 受理语义', () => {
  it('无可取消任务：409 DEPLOY_NOT_IN_FLIGHT（不静默成功）', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy/cancel')
      .send({ instanceId: 'vanilla-deadbeef' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40906);
  });

  it('instanceId 不匹配：409 且不中断在途部署（滞后一周期的取消不得误杀新部署）', async () => {
    httpState.streamImpl = hangingStream();
    const { app, manager } = buildApp();
    const deploying = startDeploy(app, DEPLOY_BODY);
    const id = await waitFor(() => deployId(manager));

    const stale = await request(app)
      .post('/api/instances/deploy/cancel')
      .send({ instanceId: 'vanilla-00000000' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe(40906);
    // 在途任务仍在：注册表条目未被动过，进度也未出现取消终态
    expect(stages(manager)).not.toContain('cancelled');
    expect(manager.activeDeploys.has(id)).toBe(true);

    // 收尾：取消真实在途的那个，避免悬挂的请求泄漏到后续用例
    await request(app).post('/api/instances/deploy/cancel').send({ instanceId: id });
    await deploying;
  });

  it('body 缺 instanceId：400 校验失败（契约必填）', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/instances/deploy/cancel').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });
});

describe('取消在途部署', () => {
  it('下载阶段取消：cancelled 终态 + 目录清理 + 注册表清空 + POST 回 409 40915', async () => {
    httpState.streamImpl = hangingStream();
    const { app, manager } = buildApp();
    const deploying = startDeploy(app, DEPLOY_BODY);
    const id = await waitFor(() => deployId(manager));
    const instanceDir = `${testState.serversDir}/${id}`;
    expect(fs.existsSync(instanceDir)).toBe(true);

    const cancel = await request(app).post('/api/instances/deploy/cancel').send({ instanceId: id });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toEqual({ instanceId: id, cancelled: true });

    const res = await deploying;
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40915);
    // 终态事件是「已取消」而不是「失败」：通知中心与用户回执都读它
    expect(stages(manager)).toContain('cancelled');
    expect(stages(manager)).not.toContain('error');
    expect(fs.existsSync(instanceDir)).toBe(false);
    expect(manager.activeDeploys.has(id)).toBe(false);
    // 取消信号必须交给传输层：仅靠 stream.destroy() 在「响应头尚未到达」时拆不掉
    // 那个 fetch，慢上游会把 socket 挂到超时（http-client.test.js 有该能力的正向断言）
    const streamOpts = vi.mocked(httpStream).mock.calls.at(-1)?.[1];
    expect(streamOpts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('首启阶段取消：已入库的行一并回滚（不留指向已删目录的幽灵实例）', async () => {
    testState.spawnBehavior = 'hang';
    const { app, manager } = buildApp();
    const deploying = startDeploy(app, { ...DEPLOY_BODY, eula: true });
    const id = await waitFor(() => deployId(manager));
    // 停在首启：DB 行已写入（首启窗口是取消与「已入库」重叠的唯一阶段）
    await waitFor(() => stages(manager).includes('first_launch'));
    expect(InstanceModel.create).toHaveBeenCalledTimes(1);

    await request(app).post('/api/instances/deploy/cancel').send({ instanceId: id });
    const res = await deploying;

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40915);
    httpState.manifestPromise = null;
    expect(stages(manager)).toContain('cancelled');
    expect(InstanceModel.delete).toHaveBeenCalledWith(id);
    expect(fs.existsSync(`${testState.serversDir}/${id}`)).toBe(false);
  });

  it('上游版本查询窗口内取消：无在途 IO 可中断时靠 await 边界拦下（不下载/不建目录/不入库）', async () => {
    // 版本查询是部署的第一个 await：此窗口内既没有下载流也没有子进程，
    // 取消只能靠 await 边界后的 throwIfCancelled 生效
    // vanilla 的第一个 await 现在是 Piston manifest 查询（与升级同一实现），
    // 不再经过 minecraft-core 的版本查询 ⇒ 挂住这一处
    let releaseQuery = () => {};
    httpState.manifestPromise = new Promise((resolve) => {
      releaseQuery = resolve;
    });
    const { app, manager } = buildApp();
    const deploying = startDeploy(app, DEPLOY_BODY);
    const id = await waitFor(() => deployId(manager));

    const cancel = await request(app).post('/api/instances/deploy/cancel').send({ instanceId: id });
    expect(cancel.status).toBe(200);

    // 放行上游查询：续延立即撞上取消判据，而非继续下载
    releaseQuery({
      latest: { release: '1.21.4' },
      versions: [
        {
          id: '1.21.4',
          type: 'release',
          url: 'https://piston-meta.mojang.com/v1/packages/uat/1.21.4.json',
        },
      ],
    });
    const res = await deploying;

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40915);
    expect(stages(manager)).toContain('cancelled');
    expect(stages(manager)).not.toContain('download_complete');
    expect(fs.existsSync(`${testState.serversDir}/${id}`)).toBe(false);
    expect(InstanceModel.create).not.toHaveBeenCalled();
  });

  it('收尾失败（目录被占用）也要据实回报：cancelled 终态带清理明细，不宣称已清理', async () => {
    httpState.streamImpl = hangingStream();
    const { app, manager } = buildApp();
    const deploying = startDeploy(app, DEPLOY_BODY);
    const id = await waitFor(() => deployId(manager));

    // Windows 上进程句柄释放是异步的：目录仍被占用时 rmSync 抛 EPERM/EBUSY
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy, rmdir');
    });

    await request(app).post('/api/instances/deploy/cancel').send({ instanceId: id });
    const res = await deploying;
    rmSpy.mockRestore();

    expect(res.status).toBe(409);
    const cancelled = manager.emit.mock.calls
      .filter(([event, payload]) => event === 'deployProgress' && payload.stage === 'cancelled')
      .map(([, payload]) => payload);
    expect(cancelled).toHaveLength(1);
    // 前端据此显示「收尾未完成」：没有明细就只剩「已清理」这一种说法（会谎报）
    expect(cancelled[0].error).toContain('实例目录未能删除');
    expect(cancelled[0].error).toContain('EBUSY');
    // WS 断线时前端只剩 POST 回声，明细必须同样带出（响应 details.cleanup）
    expect(res.body.details?.cleanup).toContain('实例目录未能删除');
    // 收尾失败不改变取消本身的终态语义
    expect(stages(manager)).not.toContain('error');
  });

  it('取消后注册表释放：可再次发起部署（不被 DEPLOY_IN_PROGRESS 拦）', async () => {
    httpState.streamImpl = hangingStream();
    const { app, manager } = buildApp();
    const deploying = startDeploy(app, DEPLOY_BODY);
    const id = await waitFor(() => deployId(manager));
    await request(app).post('/api/instances/deploy/cancel').send({ instanceId: id });
    await deploying;

    // 第二次取消：幂等面——任务已结束，端点回「无可取消对象」而不是再次触发中断
    const again = await request(app).post('/api/instances/deploy/cancel').send({ instanceId: id });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe(40906);

    // 再次部署：本次让下载正常完成，验证取消没有留下阻塞（注册表/门控均已释放）
    httpState.streamImpl = completingStream(JAR_BYTES);
    manager.emit.mockClear();
    const redeploy = await request(app).post('/api/instances/deploy').send(DEPLOY_BODY);
    expect(redeploy.status).toBe(200);
    expect(stages(manager)).toContain('complete');
    expect(manager.activeDeploys.size).toBe(0);
  });

  it('部署正常结束时不留注册表条目：取消端点回「无可取消对象」', async () => {
    const { app, manager } = buildApp();
    const res = await request(app).post('/api/instances/deploy').send(DEPLOY_BODY);
    expect(res.status).toBe(200);

    const cancel = await request(app)
      .post('/api/instances/deploy/cancel')
      .send({ instanceId: res.body.data.id });
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe(40906);
    expect(manager.activeDeploys.size).toBe(0);
    // 审计「受理」语义不受取消能力影响：成功路径仍记一条 INSTANCE_CREATE
    expect(AuditLogModel.create).toHaveBeenCalledTimes(1);
  });
});
