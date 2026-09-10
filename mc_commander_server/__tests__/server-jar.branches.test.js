/**
 * server-jar 部署链分支面收口补测（issue 511）
 * 在 server-jar.deploy.chain.test.js（30 例主链）基础上扩展未覆盖分支：
 * - versions 分发缺口：type 缺省 vanilla / fabric·未知 type 的对象形态 / forge promos 缺失
 * - Paper 构建发现链形态：裸数组响应 / 无 builds 键 / STABLE 空回退全量 / build 字段排序 / server:default 无摘要
 * - deploy 深分支：core build url/downloadUrl 形态、downloadServer 本地形态（rename/logs 预置跳过首启）、
 *   进度节流（percent=0 折算 / <1% 节流）、stream error 文件已落盘、file error、
 *   forge 成功链（installer 产出清理）/ exit1 / spawn error / 120s 超时、
 *   win32 平台（无 detached + taskkill 进程树终止）、清理失败兜底、首启输出累积
 * - 数据全部为虚构占位（1.2.3.4/Steve）
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const testState = vi.hoisted(() => ({
  serversDir: null,
  spawnBehavior: 'exit0',
  latestBuild: {},
  mcCoreVersionsValue: [],
  downloadServerImpl: null,
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
  testState.serversDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcs-jar-branches-'));
  return { default: { serversDir: testState.serversDir } };
});

vi.mock('minecraft-core', () => ({
  MinecraftServerManager: class {
    async getVersions() {
      return testState.mcCoreVersionsValue;
    }
    async getLatestBuild() {
      if (testState.latestBuild instanceof Error) throw testState.latestBuild;
      return testState.latestBuild;
    }
    async downloadServer(opts) {
      if (testState.downloadServerImpl) return testState.downloadServerImpl(opts);
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
  const nodeFs = await import('node:fs');
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
    spawn: vi.fn((cmd, args, opts) => {
      const proc = new events.EventEmitter();
      proc.stdout = new events.EventEmitter();
      proc.stderr = new events.EventEmitter();
      proc.pid = 42424;
      proc.kill = vi.fn();
      if (testState.spawnBehavior === 'forge-extract') {
        // forge --installServer 产出非 installer 的 server jar（供部署链 readdir 查找）
        nodeFs.writeFileSync(`${opts.cwd}/forge-1.0.0-server.jar`, 'forge-main-jar');
        queueMicrotask(() => proc.emit('exit', 0));
      } else if (testState.spawnBehavior === 'exit0') {
        queueMicrotask(() => proc.emit('exit', 0));
      } else if (testState.spawnBehavior === 'exit1') {
        queueMicrotask(() => proc.emit('exit', 1));
      } else if (testState.spawnBehavior === 'error') {
        queueMicrotask(() => proc.emit('error', new Error('spawn java ENOENT')));
      } else if (testState.spawnBehavior === 'emit-data') {
        queueMicrotask(() => {
          proc.stdout.emit('data', Buffer.from('starting server...'));
          proc.stderr.emit('data', Buffer.from('warning: demo'));
          proc.emit('exit', 1);
        });
      }
      // 'hang'：不发射事件，等待测试手动推进超时分支
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
const { AuditLogModel } = await import('../db/index.js');
const { errorHandler } = await import('../middleware/error_handler.js');

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

const JAR_BYTES = Buffer.from('fake-server-jar-payload');
const JAR_SHA256 = crypto.createHash('sha256').update(JAR_BYTES).digest('hex');

function buildApp() {
  const app = express();
  app.use(express.json());
  const mockManager = { activeDeploys: new Map(), emit: vi.fn(), loadInstances: vi.fn() };
  app.use('/api', createServerJarRoutes(mockManager));
  app.use(errorHandler);
  return { app, manager: mockManager };
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
  testState.mcCoreVersionsValue = [];
  testState.downloadServerImpl = null;
  testState.dbCreateError = null;
  gotState.jsonTable = {};
  gotState.streamImpl = defaultStreamImpl(JAR_BYTES);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function defineManifest() {
  gotState.jsonTable['version_manifest'] = {
    versions: [
      { type: 'release', id: '1.21.4' },
      { type: 'snapshot', id: '26w1a' },
      { type: 'release', id: '1.21' },
    ],
  };
}

describe('GET /versions 分发缺口', () => {
  it('type 缺省：默认按 vanilla 走 Mojang manifest 流程', async () => {
    defineManifest();
    const { app } = buildApp();
    const res = await request(app).get('/api/versions');
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('vanilla');
    expect(res.body.data.versions).toEqual(['1.21.4', '1.21']);
  });

  it('fabric：core 返回对象形态（versions 键）+ loader 正常', async () => {
    testState.mcCoreVersionsValue = { versions: ['1.21.4', '1.21'] };
    gotState.jsonTable['meta.fabricmc.net'] = [
      { version: '0.16.9', stable: false },
      { version: '0.16.10', stable: true },
      { version: '0.16.11', stable: true },
    ];
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=fabric');
    expect(res.status).toBe(200);
    expect(res.body.data.versions).toEqual(['1.21.4', '1.21']);
    expect(res.body.data.loaders).toEqual(['0.16.10', '0.16.11']);
  });

  it('fabric：core 对象无 versions 键 → Object.keys 兑底提取', async () => {
    testState.mcCoreVersionsValue = { neoA: {}, neoB: {} };
    gotState.jsonTable['meta.fabricmc.net'] = [];
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=fabric');
    expect(res.status).toBe(200);
    expect(res.body.data.versions).toEqual(['neoA', 'neoB']);
  });

  it('forge：promos 键缺失 → promos 兜底空对象 → 版本列表为空不抛错', async () => {
    gotState.jsonTable['promotions_slim'] = {};
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=forge');
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('forge');
    expect(res.body.data.versions).toEqual([]);
  });

  it('未知 type：core 返回普通对象（无 versions 键）→ Object.keys 提取', async () => {
    testState.mcCoreVersionsValue = { neo1: {}, neo2: {} };
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=neoforge');
    expect(res.status).toBe(200);
    expect(res.body.data.versions).toEqual(['neo1', 'neo2']);
  });
});

describe('Paper 构建发现链形态缺口', () => {
  function definePaperChain(buildsResp) {
    // key 用 projects/paper/versions（比 projects/paper 长，优先命中 builds URL，
    // 避免短 key 将发现链请求误匹配到版本列表响应）
    gotState.jsonTable['projects/paper/versions'] = buildsResp;
  }

  it('v3 裸数组响应：直接按构建数组过滤 STABLE 并选最新', async () => {
    definePaperChain([
      { id: 10, channel: 'STABLE', downloads: { 'server:default': { url: 'https://dl/10.jar', sha256: null } } },
      { id: 12, channel: 'STABLE', downloads: { 'server:default': { url: 'https://dl/12.jar', sha256: JAR_SHA256 } } },
    ]);
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
    // sha256 null → expectedHash null：仅限流不强校验
    expect(res.body.data.mcVersion).toBe('1.21.4');
  });

  it('响应无 builds 键 → 空数组 → 502 No Paper build found', async () => {
    definePaperChain({ project: 'paper' });
    const { app, manager } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('No Paper build found');
    expect(manager.emit).toHaveBeenCalledWith(
      'deployProgress',
      expect.objectContaining({ stage: 'error' })
    );
  });

  it('STABLE 空回退全量构建 + 无 id 无 downloads → build 字段组 v2 回退 URL', async () => {
    definePaperChain([
      // 双元素触发 sort 比较回调：均无 id → (b.id||0)/(a.id||0) 失败臂求值；无 downloads 键 → v2 回退
      { build: 9, channel: 'EXPERIMENTAL' },
      { build: 7, channel: 'LEGACY' },
    ]);
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    // 唯一候选 id/build=9 → downloads 缺失 → v2 回退（fileName 缺省 paper-1.21.4-9.jar）
    expect(res.status).toBe(200);
    expect(res.body.data.id).toMatch(/^paper-[0-9a-f]{8}$/);
    const { default: got } = await import('got');
    expect(got.stream.mock.calls[0][0]).toBe(
      'https://api.papermc.io/v2/projects/paper/versions/1.21.4/builds/9/downloads/paper-1.21.4-9.jar',
    );
  });

  it('server:default 存在但无 sha256 → 直链下载且跳过强校验', async () => {
    definePaperChain({
      builds: [{ id: 5, channel: 'STABLE', downloads: { 'server:default': { url: 'https://dl/no-hash.jar' } } }],
    });
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
    expect(res.body.data.mcVersion).toBe('1.21.4');
  });
});

describe('deploy · core 构建形态与 downloadServer 本地形态', () => {
  function defineVanilla() {
    defineManifest();
  }

  it('core build 顶层 url 形态 → 直链下载成功', async () => {
    defineVanilla();
    testState.latestBuild = { url: 'https://core-dl/vanilla.jar', sha256: crypto.createHash('sha256').update(JAR_BYTES).digest('hex') };
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Url Form' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Url Form');
  });

  it('core build 顶层 downloadUrl 形态 → 直链下载成功', async () => {
    defineVanilla();
    testState.latestBuild = { downloadUrl: 'https://core-dl/vanilla-dl.jar' };
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
  });

  it('build 为 null → downloadServer 落盘本地 jar → rename 为 server.jar + logs 预置跳过首启', async () => {
    defineVanilla();
    testState.latestBuild = null;
    testState.downloadServerImpl = (opts) => {
      fs.writeFileSync(path.join(opts.outputDir, 'core-server-build.jar'), 'local jar payload');
      // 预置 logs 目录：runFirstLaunch 检测到即跳过 java 进程
      fs.mkdirSync(path.join(opts.outputDir, 'logs'), { recursive: true });
      return { path: opts.outputDir };
    };
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
    const instanceId = AuditLogModel.create.mock.calls[0][0].instanceId;
    const cfg = JSON.parse(fs.readFileSync(path.join(testState.serversDir, instanceId, 'instance.json'), 'utf-8'));
    expect(cfg.jarFile).toBe('server.jar');
    // 本地产物已 rename：core-server-build.jar 不存在、server.jar 存在
    const files = fs.readdirSync(path.join(testState.serversDir, instanceId));
    expect(files).toContain('server.jar');
    expect(files).not.toContain('core-server-build.jar');
    // logs 已预置 → 首启跳过：无 java spawn
    const { spawn } = await import('child_process');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('downloadServer 返回 { url } → 转直链下载', async () => {
    defineVanilla();
    testState.latestBuild = null;
    testState.downloadServerImpl = () => ({ url: 'https://core-dl/fallback-url.jar' });
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
  });

  it('downloadServer 返回空对象且目录无 jar → 不 rename，部署仍完成', async () => {
    defineVanilla();
    testState.latestBuild = null;
    testState.downloadServerImpl = () => ({});
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
    const instanceId = AuditLogModel.create.mock.calls[0][0].instanceId;
    const cfg = JSON.parse(fs.readFileSync(path.join(testState.serversDir, instanceId, 'instance.json'), 'utf-8'));
    expect(cfg.jarFile).toBe('server.jar'); // 缺省 jarFile 原样落盘
  });

});

describe('下载进度节流与错误清理', () => {
  function defineVanillaChain() {
    defineManifest();
    testState.latestBuild = { url: 'https://core-dl/vanilla.jar' };
  }

  it('进度节流：percent=0 按 transferred/total 折算发射，<1% 增量被抑制', async () => {
    defineVanillaChain();
    gotState.streamImpl = (url, streamMod) => {
      const pt = new streamMod.PassThrough();
      queueMicrotask(() => {
        // 事件 1：percent=0、total=0 → pct=0（0 与 lastPct=-1 差 1 → 发射）
        pt.emit('downloadProgress', { percent: 0, transferred: 0, total: 0 });
        // 事件 2：percent=0、total=1000、transferred=100 → pct=0.1（发射）
        pt.emit('downloadProgress', { percent: 0, transferred: 100, total: 1000 });
        // 事件 3：增量 0.005 < 0.01 → 节流跳过
        pt.emit('downloadProgress', { percent: 0, transferred: 105, total: 1000 });
        pt.write(JAR_BYTES);
        pt.end();
      });
      return pt;
    };
    const { app, manager } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
    const progressEvents = manager.emit.mock.calls
      .filter(([evt, payload]) => evt === 'deployProgress' && payload.stage === 'download' && payload.transferred > 0)
      .map(([, p]) => p.percent);
    // 事件 2 发射（percent 0.1），事件 3 被节流；事件 1 transferred=0 不计
    expect(progressEvents).toEqual([0.1]);
  });

  it('stream error 且半成品已落盘 → 断流清理残留 + 502', async () => {
    defineVanillaChain();
    // createWriteStream 包装：同步确保文件已存在（真实 open 为异步，否则 error 时 existsSync 为 false）
    const realCreate = fs.createWriteStream.bind(fs);
    vi.spyOn(fs, 'createWriteStream').mockImplementation((p, opts) => {
      const ws = realCreate(p, opts);
      if (String(p).endsWith('.jar')) {
        try { fs.closeSync(fs.openSync(p, 'a')); } catch { /* 已存在 */ }
      }
      return ws;
    });
    gotState.streamImpl = (url, streamMod) => {
      const pt = new streamMod.PassThrough();
      queueMicrotask(() => {
        pt.write(JAR_BYTES); // 先落盘部分字节（文件已存在）
        pt.emit('error', new Error('socket reset'));
      });
      return pt;
    };
    const { app, manager } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('socket reset');
    const instanceId = manager.emit.mock.calls.find(([, p]) => p.stage === 'error')[1].instanceId;
    expect(fs.existsSync(path.join(testState.serversDir, instanceId))).toBe(false);
  });

  it('file 写入流 error → 清理 + 502（经 createWriteStream 包装捕获文件流引用）', async () => {
    defineVanillaChain();
    const realCreate = fs.createWriteStream.bind(fs);
    const createSpy = vi.spyOn(fs, 'createWriteStream').mockImplementation((p, opts) => {
      const ws = realCreate(p, opts);
      if (String(p).endsWith('server.jar')) {
        queueMicrotask(() => {
          try { fs.closeSync(fs.openSync(p, 'a')); } catch { /* 已存在 */ } // 确保存在 → unlink true 臂
          ws.emit('error', new Error('ENOSPC: disk full'));
        });
      }
      return ws;
    });
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('disk full');
    expect(createSpy).toHaveBeenCalled();
  });
});

describe('forge 安装段分支', () => {
  function defineForgeChain() {
    defineManifest();
    // forge 走 core 链：提供 build.downloads.application.url 直链下载 installer
    testState.latestBuild = {
      downloads: { application: { url: 'https://core-dl/forge-installer.jar' } },
    };
  }

  it('安装器 exit0 产出 server jar → jarFile 换名 + installer 清理 + complete', async () => {
    defineForgeChain();
    testState.spawnBehavior = 'forge-extract';
    const { app, manager } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'forge', mcVersion: '1.21.4', instanceName: 'Forge OK' });
    expect(res.status).toBe(200);
    const instanceId = res.body.data.id;
    const cfg = JSON.parse(fs.readFileSync(path.join(testState.serversDir, instanceId, 'instance.json'), 'utf-8'));
    expect(cfg.jarFile).toBe('forge-1.0.0-server.jar');
    const files = fs.readdirSync(path.join(testState.serversDir, instanceId));
    expect(files).toContain('forge-1.0.0-server.jar');
    expect(files).not.toContain('forge-installer.jar'); // unlinkSync 清理
    expect(manager.emit).toHaveBeenCalledWith(
      'deployProgress',
      expect.objectContaining({ stage: 'forge_install', ...{ percent: 0 } })
    );
  });

  it('安装器 exit 1 → 仅告警，无产物 → 502 Forge server jar not found', async () => {
    defineForgeChain();
    testState.spawnBehavior = 'exit1';
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'forge', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('Forge server jar not found');
  });

  it('安装器 spawn error → 502（error 事件 + 目录清理）', async () => {
    defineForgeChain();
    testState.spawnBehavior = 'error';
    const { app, manager } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'forge', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('spawn java ENOENT');
    expect(manager.emit).toHaveBeenCalledWith(
      'deployProgress',
      expect.objectContaining({ stage: 'error' })
    );
  });

  it('安装器 120s 超时 → kill 兜底 + 502 timed out', async () => {
    defineForgeChain();
    testState.spawnBehavior = 'hang';
    const { app } = buildApp();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const pending = request(app)
      .post('/api/instances/deploy')
      .send({ type: 'forge', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    const inflight = Promise.resolve(pending);

    let timerCall = null;
    for (let i = 0; i < 200 && !timerCall; i++) {
      await new Promise((r) => setTimeout(r, 5));
      timerCall = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 120000) || null;
    }
    expect(timerCall, 'forge 安装器应注册 120s 定时器').not.toBeNull();
    const callIdx = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 120000);
    clearTimeout(setTimeoutSpy.mock.results[callIdx].value);
    timerCall[0](); // 手动触发超时回调：extractProc.kill() + reject

    const res = await inflight;
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('timed out (120s)');
    const { spawn } = await import('child_process');
    expect(spawn.mock.results[0].value.kill).toHaveBeenCalled();
  });
});

describe('win32 平台分支与首启输出', () => {
  it('win32：spawn 不带 detached + 60s 超时走 taskkill /T 进程树终止', async () => {
    defineManifest();
    testState.latestBuild = { url: 'https://core-dl/vanilla.jar' };
    testState.spawnBehavior = 'hang';
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const { app } = buildApp();
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      const pending = request(app)
        .post('/api/instances/deploy')
        .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Win Server', eula: true });
      const inflight = Promise.resolve(pending);

      let timeoutCall = null;
      for (let i = 0; i < 200 && !timeoutCall; i++) {
        await new Promise((r) => setTimeout(r, 5));
        timeoutCall = setTimeoutSpy.mock.calls.find(([, ms]) => ms === 60000) || null;
      }
      expect(timeoutCall).not.toBeNull();
      const callIdx = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 60000);
      clearTimeout(setTimeoutSpy.mock.results[callIdx].value);
      timeoutCall[0]();

      const res = await inflight;
      expect(res.status).toBe(200);
      const { spawn, spawnSync } = await import('child_process');
      // win32 不设 detached
      const spawnOpts = spawn.mock.calls[0][2];
      expect(spawnOpts.detached).toBeUndefined();
      // 进程树终止：taskkill /F /T /PID
      expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '42424'], { stdio: 'ignore' });
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('首启 stdout/stderr 输出累积 + 退出码非 0 且无 logs → 告警不阻断', async () => {
    defineManifest();
    testState.latestBuild = { url: 'https://core-dl/vanilla.jar' };
    testState.spawnBehavior = 'emit-data';
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
  });
});

describe('失败清理兜底', () => {
  it('部署失败且 rmSync 清理抛错 → 仅告警，仍返回 502 + error 事件', async () => {
    defineManifest();
    gotState.jsonTable['projects/paper'] = { versions: {} };
    // paper 发现链失败 → 进入 catch 清理段
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy');
    });
    const { app, manager } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(502);
    expect(rmSpy).toHaveBeenCalled();
    expect(manager.emit).toHaveBeenCalledWith(
      'deployProgress',
      expect.objectContaining({ stage: 'error' })
    );
  });
});
