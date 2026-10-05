/**
 * Deploy 端点审计断言（INSTANCE_CREATE，issue 373）
 *
 * 部署链路重依赖（网络下载 / java 子进程 / forge 安装）全部 mock：
 * - 上游 HTTP：vanilla 的构建解析走 Piston manifest（由 httpJson 替身合成）
 * - utils/http-client：httpStream 用 PassThrough 注入假 jar 字节流（expectedHash 缺省 → 跳过摘要校验）
 * - child_process.spawn：假进程立即 exit(0)（first launch 不阻塞）
 * - java-detector：固定 java 路径（避免探测宿主环境）
 * - db / config.serversDir（tmp 目录）：隔离真实数据库与文件系统落点
 *
 * 审计「受理」语义验证：
 * - 请求受理（schema 通过 + 目录已建 + 流程启动）即落 INSTANCE_CREATE，不等终态
 * - 部署中途失败（502）不回滚审计记录；失败可见性由部署进度 error 事件承担
 * - schema 校验失败（400）属未受理，不产生审计
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

const testState = vi.hoisted(() => ({ serversDir: null, latestBuild: {} }));

vi.mock('../db/index.js', () => ({
  InstanceModel: { create: vi.fn() },
  AuditLogModel: { create: vi.fn() },
}));

vi.mock('../config.js', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  testState.serversDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcs-deploy-audit-'));
  return { default: { serversDir: testState.serversDir } };
});

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
    // 假 java 进程：立即 exit(0) → runFirstLaunch 直接 resolve，测试不等待
    spawn: vi.fn(() => {
      const proc = new events.EventEmitter();
      proc.stdout = new events.EventEmitter();
      proc.stderr = new events.EventEmitter();
      proc.pid = 42424;
      queueMicrotask(() => proc.emit('exit', 0));
      return proc;
    }),
  };
});

vi.mock('../utils/http-client.js', async () => {
  const streamMod = await import('node:stream');
  return {
    // PassThrough 注入假 jar 字节（无 expectedHash → 跳过摘要校验，仅限流语义）
    httpStream: vi.fn(() => {
      const pt = new streamMod.PassThrough();
      queueMicrotask(() => {
        pt.emit('downloadProgress', { percent: 0.5, transferred: 512, total: 1024 });
        pt.write('fake-jar-bytes');
        pt.end();
      });
      return pt;
    }),
    // 本组只走 vanilla/local 落盘路径，不触达 JSON 接口；具名导出必须齐全，否则模块解析期失败
    // vanilla 构建解析已改走 Piston manifest（与升级共用一份实现）。
    // 夹具接缝仍是 testState.latestBuild —— 由它合成 Piston 形状的响应。
    httpJson: vi.fn((url) => {
      const u = String(url);
      if (u.includes('version_manifest_v2.json')) {
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
  };
});

const { createServerJarRoutes } = await import('../routes/server-jar.js');
const { InstanceModel, AuditLogModel } = await import('../db/index.js');
const { errorHandler } = await import('../middleware/error_handler.js');

/** 组装 app（与生产一致的路由 + 全局 errorHandler） */
function buildApp() {
  const app = express();
  app.use(express.json());
  const mockManager = { activeDeploys: new Map(), emit: vi.fn(), loadInstances: vi.fn() };
  app.use('/api', createServerJarRoutes(mockManager));
  app.use(errorHandler);
  return app;
}

afterAll(async () => {
  const fsp = await import('node:fs/promises');
  if (testState.serversDir) {
    await fsp.rm(testState.serversDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  testState.latestBuild = {
    downloads: { application: { url: 'https://piston-data.mojang.com/jar/server.jar' } },
  };
});

describe('POST /instances/deploy 审计（INSTANCE_CREATE）', () => {
  it('部署成功：受理路径落 INSTANCE_CREATE（targetType/targetId/detail 齐全）', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Audit Test Server' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const instanceId = res.body.data.id;
    expect(instanceId).toMatch(/^vanilla-[0-9a-f]{8}$/);

    expect(AuditLogModel.create).toHaveBeenCalledTimes(1);
    const auditCall = AuditLogModel.create.mock.calls[0][0];
    expect(auditCall).toMatchObject({
      instanceId,
      action: 'INSTANCE_CREATE',
      targetType: 'instance',
      targetId: instanceId,
      detail: { instanceName: 'Audit Test Server', mcVersion: '1.21.4', type: 'vanilla' },
    });
    expect(InstanceModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: instanceId, name: 'Audit Test Server', type: 'vanilla' }),
    );
  });

  it('schema 校验失败（非法 type 400）：未受理，不产生 INSTANCE_CREATE 审计', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'bogus-core', mcVersion: '1.21.4', instanceName: 'Bad Request Server' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBeDefined();
    expect(AuditLogModel.create).not.toHaveBeenCalled();
  });

  it('部署中途失败（502）：受理语义不回滚审计（失败可见性由进度事件承担）', async () => {
    testState.latestBuild = null; // getLatestBuild 无 build → downloadServer 缺失抛错 → 502
    const app = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Failed Deploy Server' });

    expect(res.status).toBe(502);
    expect(res.body.status).toBe('error');
    // 受理即记录：审计已落，不随部署失败回滚
    expect(AuditLogModel.create).toHaveBeenCalledTimes(1);
    expect(AuditLogModel.create.mock.calls[0][0]).toMatchObject({
      action: 'INSTANCE_CREATE',
      targetType: 'instance',
      detail: { instanceName: 'Failed Deploy Server', mcVersion: '1.21.4', type: 'vanilla' },
    });
  });
});
