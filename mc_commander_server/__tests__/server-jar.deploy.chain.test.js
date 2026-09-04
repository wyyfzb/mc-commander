/**
 * server-jar 部署主链行为补测（issue 415）
 *
 * 覆盖 routes/server-jar.js 六个主链函数（经公共路由触发，SUT 真实 import）：
 * - getPaperVersions/getPaperBuild/getPaperDownload（Paper API v3 三段发现链）
 * - downloadWithProgress（进度节流 / 体积上限 / 摘要校验 / 断流清理）
 * - generateServerProperties（RCON 端口偏移与随机密码契约）
 * - runFirstLaunch（退出码/错误/60s 超时进程树终止）
 *
 * mock 边界（对齐 PR#413/#412/#409 范式：仅替身外部依赖，importOriginal 保留语义）：
 * - got：HTTP 层替身（json 按 URL 注册表返回；stream 注入可控字节流）
 * - minecraft-core：核心版本发现替身（getVersions/getLatestBuild 可控行为）
 * - child_process：假 java/forge 进程（importOriginal 保留 spawnSync）
 * - java-detector / db / config.serversDir（tmp 目录）：隔离宿主环境
 * - jar-download-guard / audit / validateBody：真实 import，语义原样
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
  mcCoreVersions: [],
  mcCoreThrow: false,
  dbCreateError: null,
}));

const gotState = vi.hoisted(() => ({ jsonTable: {}, streamImpl: null }));

vi.mock('../db/index.js', () => ({
  InstanceModel: {
    create: vi.fn(() => {
      if (testState.dbCreateError) throw testState.dbCreateError;
    }),
  },
  AuditLogModel: { create: vi.fn() },
}));

vi.mock('../config.js', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  testState.serversDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcs-deploy-chain-'));
  return { default: { serversDir: testState.serversDir } };
});

vi.mock('minecraft-core', () => ({
  MinecraftServerManager: class {
    async getVersions() {
      return testState.mcCoreVersions;
    }
    async getLatestBuild() {
      if (testState.mcCoreThrow) throw new Error('core registry unavailable');
      return testState.latestBuild;
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
    // 假 java/forge 进程：按 testState.spawnBehavior 决定退出/报错/挂起
    spawn: vi.fn(() => {
      const proc = new events.EventEmitter();
      proc.stdout = new events.EventEmitter();
      proc.stderr = new events.EventEmitter();
      proc.pid = 42424;
      proc.kill = vi.fn();
      if (testState.spawnBehavior === 'exit0') queueMicrotask(() => proc.emit('exit', 0));
      if (testState.spawnBehavior === 'exit1') queueMicrotask(() => proc.emit('exit', 1));
      if (testState.spawnBehavior === 'error') {
        queueMicrotask(() => proc.emit('error', new Error('spawn java ENOENT')));
      }
      // 'hang'：不发射任何事件，等待测试用 fake timers 推进超时分支
      return proc;
    }),
  };
});

vi.mock('got', async () => {
  const streamMod = await import('node:stream');
  const findJson = (url) => {
    const keys = Object.keys(gotState.jsonTable).sort((a, b) => b.length - a.length);
    for (const k of keys) if (url.includes(k)) return gotState.jsonTable[k];
    throw new Error(`unexpected got.json url: ${url}`);
  };
  const gotFn = vi.fn((url) => ({
    json: () => {
      const entry = findJson(url);
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve(entry);
    },
  }));
  gotFn.stream = vi.fn((url) => gotState.streamImpl(url, streamMod));
  return { default: gotFn };
});

const { createServerJarRoutes } = await import('../routes/server-jar.js');
const { InstanceModel, AuditLogModel } = await import('../db/index.js');
const { errorHandler } = await import('../middleware/error_handler.js');

/** 注入假 jar 字节流的默认下载实现（可被单个用例覆写 gotState.streamImpl） */
function defaultStreamImpl(jarBytes) {
  return (url, streamMod) => {
    const pt = new streamMod.PassThrough();
    queueMicrotask(() => {
      pt.emit('downloadProgress', { percent: 0.5, transferred: jarBytes.length, total: jarBytes.length });
      pt.write(jarBytes);
      pt.end();
    });
    return pt;
  };
}

const PAPER_URL = 'https://api.papermc.io/v3';
const JAR_BYTES = Buffer.from('fake-paper-server-jar-payload');
const JAR_SHA256 = crypto.createHash('sha256').update(JAR_BYTES).digest('hex');

/** 组装 app（与生产一致的路由 + 全局 errorHandler） */
function buildApp() {
  const app = express();
  app.use(express.json());
  const mockManager = { activeDeploys: new Map(), emit: vi.fn(), loadInstances: vi.fn() };
  app.use('/api', createServerJarRoutes(mockManager));
  app.use(errorHandler);
  return { app, manager: mockManager };
}

/** 从审计 mock 调用中取本次部署 instanceId（部署链路最早落库点） */
function lastDeployInstanceId() {
  expect(AuditLogModel.create).toHaveBeenCalled();
  return AuditLogModel.create.mock.calls[0][0].instanceId;
}

afterAll(async () => {
  const fsp = await import('node:fs/promises');
  if (testState.serversDir) {
    await fsp.rm(testState.serversDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  testState.spawnBehavior = 'exit0';
  testState.latestBuild = {};
  testState.mcCoreVersions = [];
  testState.mcCoreThrow = false;
  testState.dbCreateError = null;
  gotState.jsonTable = {};
  gotState.streamImpl = defaultStreamImpl(JAR_BYTES);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GET /versions 多核心版本分发', () => {
  it('paper：v3 versions 对象形态——版本组展平 + 预发布过滤 + slice(0,30)', async () => {
    // 34 个条目混入 2 个预发布：验证展平/过滤/截断三段逻辑
    const groupA = Array.from({ length: 20 }, (_, i) => `1.21.${i}`);
    const groupB = [...Array.from({ length: 14 }, (_, i) => `1.20.${i}`), '26.x-pre1', '1.19-rc1'];
    gotState.jsonTable = { 'projects/paper': { project: 'paper', versions: { groupA, groupB } } };
    const { app } = buildApp();

    const res = await request(app).get('/api/versions?type=paper');

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('paper');
    const versions = res.body.data.versions;
    expect(versions).toHaveLength(30); // 32 个正式版截断到 30
    expect(versions.every((v) => !v.includes('-'))).toBe(true);
    expect(versions[0]).toBe('1.21.0'); // 展平顺序 = 版本组声明顺序
  });

  it('paper：versions 为数组形态（非版本组对象）——直通过滤', async () => {
    gotState.jsonTable = {
      'projects/paper': { project: 'paper', versions: ['1.21.4', '26.x-pre1', '1.21.3'] },
    };
    const { app } = buildApp();

    const res = await request(app).get('/api/versions?type=paper');

    expect(res.status).toBe(200);
    expect(res.body.data.versions).toEqual(['1.21.4', '1.21.3']);
  });

  it('paper：上游请求失败 → 502 SERVER_ERROR', async () => {
    gotState.jsonTable = { 'projects/paper': new Error('connect ETIMEDOUT') };
    const { app } = buildApp();

    const res = await request(app).get('/api/versions?type=paper');

    expect(res.status).toBe(502);
    expect(res.body.status).toBe('error');
    expect(res.body.code).toBe(50000);
    expect(res.body.message).toContain('Failed to fetch versions');
  });

  it('vanilla：Mojang manifest 仅保留 release 且截断 30', async () => {
    gotState.jsonTable = {
      version_manifest_v2: {
        versions: [
          ...Array.from({ length: 32 }, (_, i) => ({ id: `1.21.${i}`, type: 'release' })),
          { id: '26x_snapshot', type: 'snapshot' },
        ],
      },
    };
    const { app } = buildApp();

    const res = await request(app).get('/api/versions?type=vanilla');

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('vanilla');
    expect(res.body.data.versions).toHaveLength(30);
    expect(res.body.data.versions).not.toContain('26x_snapshot');
  });

  it('fabric：core 版本列表 + loader stable 过滤截断 10', async () => {
    testState.mcCoreVersions = ['1.21.4', '1.21.3', '1.21.1'];
    gotState.jsonTable = {
      'versions/loader': [
        ...Array.from({ length: 12 }, (_, i) => ({ version: `0.16.${i}`, stable: true })),
        { version: '0.17.0-beta', stable: false },
      ],
    };
    const { app } = buildApp();

    const res = await request(app).get('/api/versions?type=fabric');

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('fabric');
    expect(res.body.data.versions).toEqual(['1.21.4', '1.21.3', '1.21.1']);
    expect(res.body.data.loaders).toHaveLength(10); // 12 个 stable 截断到 10
    expect(res.body.data.loaders.every((v) => v !== '0.17.0-beta')).toBe(true);
  });

  it('fabric：loader 上游失败 → loaders 空数组兜底（版本列表不受影响）', async () => {
    testState.mcCoreVersions = ['1.21.4'];
    gotState.jsonTable = { 'versions/loader': new Error('loader api down') };
    const { app } = buildApp();

    const res = await request(app).get('/api/versions?type=fabric');

    expect(res.status).toBe(200);
    expect(res.body.data.versions).toEqual(['1.21.4']);
    expect(res.body.data.loaders).toEqual([]);
  });

  it('forge：promotions 去重 + 1.x 过滤 + 倒序截断 30', async () => {
    gotState.jsonTable = {
      promotions_slim: {
        promos: {
          '1.21.4-latest': '51.0.0',
          '1.21.4-recommended': '51.0.0', // 与 latest 同版本 → 去重
          '1.20.1-recommended': '47.2.0',
          '2.0-latest': '99.0.0', // 非 1. 前缀 → 过滤
        },
      },
    };
    const { app } = buildApp();

    const res = await request(app).get('/api/versions?type=forge');

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('forge');
    // 源码语义：promos 键名倒序（字典序）输出，新版本组在后
    expect(res.body.data.versions).toEqual(['1.20.1', '1.21.4']);
  });

  it('未知 type：走 minecraft-core getVersions 直通（数组返回形态）', async () => {
    testState.mcCoreVersions = ['1.21.4', '1.20.6'];
    const { app } = buildApp();

    const res = await request(app).get('/api/versions?type=quilt');

    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('quilt');
    expect(res.body.data.versions).toEqual(['1.21.4', '1.20.6']);
  });
});

describe('POST /instances/deploy · Paper 主链', () => {
  function setPaperChain({ builds = null, noDownloads = false, badSha = false } = {}) {
    let build;
    if (builds === null) {
      build = {
        id: 42,
        channel: 'STABLE',
        downloads: noDownloads
          ? {}
          : {
              'server:default': {
                name: 'paper-1.21.4-42.jar',
                url: `${PAPER_URL}/projects/paper/versions/1.21.4/builds/42/downloads/paper-1.21.4-42.jar`,
                sha256: badSha ? 'deadbeef'.repeat(8) : JAR_SHA256,
              },
            },
      };
      gotState.jsonTable = {
        'projects/paper/versions': { builds: [build] },
      };
    } else {
      gotState.jsonTable = { 'projects/paper/versions': { builds } };
    }
  }

  it('paper 全链成功：STABLE 构建选择 + server:default 摘要校验通过 + 实例落盘/入库/complete 事件', async () => {
    // builds 混入更高 id 的非稳定通道：验证 channel 过滤优先于 id 排序
    setPaperChain({
      builds: [
        { id: 43, channel: 'SNAPSHOT', downloads: {} },
        { id: 42, channel: 'STABLE', downloads: { 'server:default': { name: 'paper-1.21.4-42.jar', url: `${PAPER_URL}/d/42`, sha256: JAR_SHA256 } } },
        { id: 41, channel: 'STABLE', downloads: {} },
      ],
    });
    const { app, manager } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Paper Chain Server' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const instanceId = res.body.data.id;
    expect(instanceId).toMatch(/^paper-[0-9a-f]{8}$/);
    expect(res.body.data).toMatchObject({ type: 'paper', mcVersion: '1.21.4', maxMemory: '2G', javaVersion: '21' });

    const instancePath = `${testState.serversDir}/${instanceId}`;
    expect(fs.readFileSync(`${instancePath}/server.jar`)).toEqual(JAR_BYTES);
    expect(fs.readFileSync(`${instancePath}/eula.txt`, 'utf8')).toBe('eula=true\n');
    expect(fs.existsSync(`${instancePath}/instance.json`)).toBe(true);
    expect(InstanceModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: instanceId, name: 'Paper Chain Server', type: 'paper', mcVersion: '1.21.4' }),
    );

    const stages = manager.emit.mock.calls.map(([, evt]) => evt.stage);
    expect(stages[0]).toBe('download'); // 受理即入注册表的首事件
    expect(stages).toContain('download_complete');
    expect(stages).toContain('first_launch');
    expect(stages[stages.length - 1]).toBe('complete');
    // 观察项（issue 415 PR 留档）：L557 先 delete 终态条目，但 complete 事件携
    // meta 经 trackDeployProgress 重新 set 回注册表——测试锁定当前实际行为
    expect(manager.activeDeploys.get(instanceId)).toMatchObject({ stage: 'complete' });
  });

  it('paper：无可用构建（builds 空）→ 502 No Paper build found + 实例目录清理 + error 事件', async () => {
    setPaperChain({ builds: [] });
    const { app, manager } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'No Build Server' });

    expect(res.status).toBe(502);
    expect(res.body.message).toContain('Deployment failed: No Paper build found for 1.21.4');
    const instanceId = lastDeployInstanceId();
    expect(fs.existsSync(`${testState.serversDir}/${instanceId}`)).toBe(false); // 失败路径清理
    const errEvt = manager.emit.mock.calls.map(([, evt]) => evt).find((e) => e.stage === 'error');
    expect(errEvt).toMatchObject({ stage: 'error', instanceId });
  });

  it('paper：build 无 downloads 字段 → 回退 v2 URL 直链下载（无上游摘要，跳过校验）', async () => {
    setPaperChain({ noDownloads: true });
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'V2 Fallback Server' });

    expect(res.status).toBe(200);
    const { default: got } = await import('got');
    const streamUrl = got.stream.mock.calls[0][0];
    // v2 回退：build.id 拼 v2 直链 + 生成缺省文件名
    expect(streamUrl).toBe(
      'https://api.papermc.io/v2/projects/paper/versions/1.21.4/builds/42/downloads/paper-1.21.4-42.jar',
    );
  });

  it('paper：落盘摘要与上游 sha256 不符 → 502 integrity + 残留清理（fail-closed）', async () => {
    setPaperChain({ badSha: true });
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Corrupt Jar Server' });

    expect(res.status).toBe(502);
    expect(res.body.message).toContain('Download integrity check failed');
    const instanceId = lastDeployInstanceId();
    expect(fs.existsSync(`${testState.serversDir}/${instanceId}`)).toBe(false);
  });

  it('paper：下载体积超过 512MB 上限 → 即刻断流 + 502 exceeds size limit + 清理', async () => {
    setPaperChain(); // 正常 sha（校验不应到达——超限先中断）
    const overLimit = 512 * 1024 * 1024 + 1;
    gotState.streamImpl = (url, streamMod) => {
      const pt = new streamMod.PassThrough();
      queueMicrotask(() => {
        pt.emit('downloadProgress', { percent: 1.0, transferred: overLimit, total: overLimit });
      });
      return pt;
    };
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Oversize Server' });

    expect(res.status).toBe(502);
    expect(res.body.message).toContain('exceeds size limit');
    const instanceId = lastDeployInstanceId();
    expect(fs.existsSync(`${testState.serversDir}/${instanceId}`)).toBe(false);
  });
});

describe('POST /instances/deploy · 下载异常与核心回退', () => {
  it('got.stream 中途 error → 502 + 残留清理', async () => {
    testState.latestBuild = { downloads: { application: { url: 'https://example.invalid/jar/server.jar' } } };
    gotState.streamImpl = (url, streamMod) => {
      const pt = new streamMod.PassThrough();
      queueMicrotask(() => pt.emit('error', new Error('socket hang up')));
      return pt;
    };
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Stream Error Server' });

    expect(res.status).toBe(502);
    expect(res.body.message).toContain('socket hang up');
    const instanceId = lastDeployInstanceId();
    expect(fs.existsSync(`${testState.serversDir}/${instanceId}`)).toBe(false);
  });

  it('vanilla：core build.application 携带 sha256 → 防御式取值 + 摘要校验通过', async () => {
    testState.latestBuild = {
      downloads: { application: { url: 'https://example.invalid/jar/server.jar', sha256: JAR_SHA256 } },
    };
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Vanilla Sha256 Server' });

    expect(res.status).toBe(200);
    const instanceId = res.body.data.id;
    expect(fs.readFileSync(`${testState.serversDir}/${instanceId}/server.jar`)).toEqual(JAR_BYTES);
  });

  it('vanilla：core 顶层 sha1（无 url 直链形态）→ sha1 算法选择 + 校验通过', async () => {
    const jarSha1 = crypto.createHash('sha1').update(JAR_BYTES).digest('hex');
    testState.latestBuild = { url: 'https://example.invalid/jar/server.jar', sha1: jarSha1 };
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Vanilla Sha1 Server' });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(`${testState.serversDir}/${res.body.data.id}/server.jar`)).toEqual(JAR_BYTES);
  });

  it('fabric：core 失败 → 回退 meta.fabricmc 直链（loaderVersion 缺省 0.16.10）下载成功', async () => {
    testState.mcCoreThrow = true;
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'fabric', mcVersion: '1.21.4', instanceName: 'Fabric Fallback Server' });

    expect(res.status).toBe(200);
    const { default: got } = await import('got');
    expect(got.stream.mock.calls[0][0]).toBe(
      'https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.16.10/1.0.1/server/jar',
    );
  });

  it('fabric：core 失败 + 显式 loaderVersion → 回退 URL 携带指定 loader', async () => {
    testState.mcCoreThrow = true;
    const { app } = buildApp();

    await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'fabric', mcVersion: '1.21.4', instanceName: 'Fabric Loader Server', loaderVersion: '0.16.14' });

    const { default: got } = await import('got');
    expect(got.stream.mock.calls[0][0]).toContain('/0.16.14/');
  });

  it('purpur：core 失败 → 回退 purpur API latest 直链下载成功', async () => {
    testState.mcCoreThrow = true;
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'purpur', mcVersion: '1.21.4', instanceName: 'Purpur Fallback Server' });

    expect(res.status).toBe(200);
    const { default: got } = await import('got');
    expect(got.stream.mock.calls[0][0]).toBe('https://api.purpurmc.org/v2/purpur/1.21.4/latest/download');
  });

  it('forge：安装器退出后未产出 server jar → 502 Forge server jar not found', async () => {
    // forge-installer.jar 下载后 spawn --installServer 假进程 exit0，
    // 目录中除 installer 外无 forge-*.jar → 查找失败抛错
    testState.latestBuild = { downloads: { application: { url: 'https://example.invalid/jar/forge-installer.jar' } } };
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'forge', mcVersion: '1.21.4', instanceName: 'Forge Missing Jar Server' });

    expect(res.status).toBe(502);
    expect(res.body.message).toContain('Forge server jar not found after install');
    const instanceId = lastDeployInstanceId();
    expect(fs.existsSync(`${testState.serversDir}/${instanceId}`)).toBe(false);
  });

  it('mkdirSync 失败 → 502 且不产生审计（受理前置失败）', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    const { app, manager } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Mkdir Fail Server' });

    expect(res.status).toBe(502);
    expect(res.body.message).toContain('EACCES');
    expect(AuditLogModel.create).not.toHaveBeenCalled(); // 目录未建，流程未受理
    expect(manager.emit.mock.calls.map(([, evt]) => evt.stage)).toContain('error');
    expect(mkdirSpy).toHaveBeenCalled();
  });

  it('InstanceModel.create 抛错 → 部署不阻断仍 200（DB 故障仅降级记录）', async () => {
    testState.dbCreateError = new Error('SQLITE_BUSY: database is locked');
    testState.latestBuild = { downloads: { application: { url: 'https://example.invalid/jar/server.jar' } } };
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Db Busy Server' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(fs.existsSync(`${testState.serversDir}/${res.body.data.id}/server.jar`)).toBe(true);
  });
});

describe('generateServerProperties 落盘契约', () => {
  it('rcon.port/server-port 按 instanceId 后 4 位 hex 偏移 + enable-rcon + 16 位随机密码', async () => {
    testState.latestBuild = { downloads: { application: { url: 'https://example.invalid/jar/server.jar' } } };
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Props Contract Server' });

    expect(res.status).toBe(200);
    const instanceId = res.body.data.id;
    const offset = parseInt(instanceId.slice(-4), 16) % 100;
    const props = fs.readFileSync(`${testState.serversDir}/${instanceId}/server.properties`, 'utf8');

    expect(props).toContain(`rcon.port=${25575 + offset}`);
    expect(props).toContain(`server-port=${25565 + offset}`);
    expect(props).toContain('enable-rcon=true');
    expect(props).toContain('online-mode=true');
    const pwd = props.match(/^rcon\.password=([0-9a-f]+)$/m);
    expect(pwd).not.toBeNull();
    expect(pwd[1]).toHaveLength(16);
  });

  it('instance.json 与 eula.txt 契约（部署产物可直接启动）', async () => {
    testState.latestBuild = { downloads: { application: { url: 'https://example.invalid/jar/server.jar' } } };
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Eula Contract Server' });

    const instanceId = res.body.data.id;
    expect(fs.readFileSync(`${testState.serversDir}/${instanceId}/eula.txt`, 'utf8')).toBe('eula=true\n');
    const cfg = JSON.parse(fs.readFileSync(`${testState.serversDir}/${instanceId}/instance.json`, 'utf8'));
    expect(cfg).toMatchObject({
      id: instanceId,
      name: 'Eula Contract Server',
      type: 'vanilla',
      jarFile: 'server.jar',
      maxMemory: '2G',
      minMemory: '1G',
      javaPath: '/usr/bin/java',
    });
  });
});

describe('runFirstLaunch 首启行为', () => {
  beforeEach(() => {
    testState.latestBuild = { downloads: { application: { url: 'https://example.invalid/jar/server.jar' } } };
  });

  it('首启退出码非 0 且无 logs 目录 → 记录告警但不阻断部署（resolve）', async () => {
    testState.spawnBehavior = 'exit1';
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Exit1 Server' });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toMatch(/^vanilla-[0-9a-f]{8}$/);
  });

  it('首启 spawn 出错（如 java 缺失）→ 记录告警但不阻断部署（resolve）', async () => {
    testState.spawnBehavior = 'error';
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Spawn Error Server' });

    expect(res.status).toBe(200);
  });

  it('首启 60s 超时 → 按进程组终止（kill(-pid, SIGKILL)）+ 单进程兜底 + 部署完成', async () => {
    testState.spawnBehavior = 'hang';
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const { app } = buildApp();

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const pending = request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Timeout Server' });
    // supertest Test 为惰性 thenable：Promise.resolve 触发 then → 立即发起请求
    const inflight = Promise.resolve(pending);

    // 轮询等待 runFirstLaunch 注册 60s 首启定时器（真实 IO 链在 tmp 目录毫秒级完成）
    let timeoutCall = null;
    for (let i = 0; i < 200 && !timeoutCall; i++) {
      await new Promise((r) => setTimeout(r, 5));
      timeoutCall = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 60000) || null;
    }
    expect(timeoutCall, 'runFirstLaunch 应注册 60s 首启定时器').not.toBeNull();

    // 模拟 60s 到期：取消真实定时器后手动触发超时回调（进程树终止 + resolve）
    const callIdx = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 60000);
    clearTimeout(setTimeoutSpy.mock.results[callIdx].value);
    timeoutCall[0]();

    const res = await inflight;
    expect(res.status).toBe(200);
    expect(res.body.data.id).toMatch(/^vanilla-[0-9a-f]{8}$/);
    // 进程树终止：Linux/macOS spawn 带 detached（pid 即 PGID）→ 负 pid 发组信号
    expect(killSpy).toHaveBeenCalledWith(-42424, 'SIGKILL');
    // 单进程 SIGKILL 兜底
    const { spawn } = await import('child_process');
    expect(spawn.mock.results[0].value.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

