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

const httpState = vi.hoisted(() => ({ jsonTable: {}, streamImpl: null }));

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

vi.mock('../utils/http-client.js', async () => {
  const streamMod = await import('node:stream');
  // 按 URL 子串命中注册表；未命中即抛错（URL 形状漂移时给出可定位的失败，而非静默 undefined）
  const findJsonOrNull = (url) => {
    const keys = Object.keys(httpState.jsonTable).sort((a, b) => b.length - a.length);
    for (const k of keys) if (url.includes(k)) return httpState.jsonTable[k];
    return null;
  };
  // vanilla 构建解析已改走 Piston manifest（与升级共用一份实现，见 services/vanilla-manifest.js）。
  // 夹具接缝仍是 testState.latestBuild —— 由它合成 Piston 形状的响应，避免逐条改夹具。
  const VANILLA_VERSION = '1.21.4';
  const pistonManifest = {
    latest: { release: VANILLA_VERSION },
    versions: [
      {
        id: VANILLA_VERSION,
        type: 'release',
        url: 'https://piston-meta.mojang.com/v1/packages/uat/1.21.4.json',
      },
    ],
  };
  const pistonDetail = () => {
    const art = testState.latestBuild?.downloads?.application;
    return art ? { downloads: { server: { url: art.url, sha1: art.hash } } } : { downloads: {} };
  };
  // httpJson 契约：直接返回解析后的值（Promisified），值为 Error 实例时 reject
  const httpJson = vi.fn((url) => {
    const u = String(url);
    // 先查夹具表（用例可自带 manifest），合成层只兜底
    const entry = findJsonOrNull(u);
    if (entry !== null) {
      return entry instanceof Error ? Promise.reject(entry) : Promise.resolve(entry);
    }
    if (u.includes('version_manifest_v2.json')) return Promise.resolve(pistonManifest);
    if (u.includes('/v1/packages/uat/')) return Promise.resolve(pistonDetail());
    // forge 的构建号在 promotions 里（没有构建详情接口）——同样由合成层兜底
    if (u.includes('promotions_slim')) {
      return Promise.resolve({
        promos: { '1.21.4-recommended': '51.0.0', '1.21.4-latest': '51.0.0' },
      });
    }
    throw new Error(`unexpected json url: ${url}`);
  });
  const httpStream = vi.fn((url) => httpState.streamImpl(url, streamMod));
  // 三个具名导出必须齐全：SUT 用 ESM 具名导入，缺一个即模块解析期整体失败
  return { httpJson, httpStream, httpPost: vi.fn() };
});

const { createServerJarRoutes } = await import('../routes/server-jar.js');
const { errorHandler } = await import('../middleware/error_handler.js');

function defaultStreamImpl(jarBytes) {
  return (url, streamMod) => {
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
  httpState.jsonTable = {};
  httpState.streamImpl = defaultStreamImpl(JAR_BYTES);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function defineManifest() {
  // url 是部署路径要用的（版本列表只看 id/type，但构建解析要顺着 url 取每版详情）。
  // 合成层对未登记的 URL 会按 /v1/packages/uat/ 兜底返回详情（见 http-client 替身）。
  httpState.jsonTable['version_manifest'] = {
    versions: [
      {
        type: 'release',
        id: '1.21.4',
        url: 'https://piston-meta.mojang.com/v1/packages/uat/1.21.4.json',
      },
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

  it('fabric：直连上游 game 列表，只取 stable，loader 同理', async () => {
    // 上游真实形态（打真实请求核过）：`[{ version, stable }]`，由新到旧，
    // 快照与 rc 也在列表里但 stable=false
    httpState.jsonTable['meta.fabricmc.net/v2/versions/game'] = [
      { version: '26.4-snapshot-1', stable: false },
      { version: '26.3', stable: true },
      { version: '26.3-rc-2', stable: false },
      { version: '1.21.4', stable: true },
    ];
    httpState.jsonTable['meta.fabricmc.net/v2/versions/loader'] = [
      { version: '0.16.9', stable: false },
      { version: '0.16.10', stable: true },
      { version: '0.16.11', stable: true },
    ];
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=fabric');
    expect(res.status).toBe(200);
    // 快照/rc 不进部署选项
    expect(res.body.data.versions).toEqual(['26.3', '1.21.4']);
    expect(res.body.data.loaders).toEqual(['0.16.10', '0.16.11']);
  });

  it('fabric：上游返回非数组（异常形态）→ 空列表而不是抛错', async () => {
    httpState.jsonTable['meta.fabricmc.net/v2/versions/game'] = { unexpected: true };
    httpState.jsonTable['meta.fabricmc.net/v2/versions/loader'] = [];
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=fabric');
    expect(res.status).toBe(200);
    expect(res.body.data.versions).toEqual([]);
  });

  it('purpur：上游由旧到新，必须反向后给出（取最新在前）', async () => {
    httpState.jsonTable['api.purpurmc.org'] = {
      project: 'purpur',
      metadata: { current: '26.2' },
      versions: ['1.20.4', '1.21.4', '26.2'],
    };
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=purpur');
    expect(res.status).toBe(200);
    // 顺带钉住「按 limit 截断前先反向」——先截断会永远拿到最旧那几档
    expect(res.body.data.versions).toEqual(['26.2', '1.21.4', '1.20.4']);
  });

  it('forge：promos 键缺失 → promos 兜底空对象 → 版本列表为空不抛错', async () => {
    httpState.jsonTable['promotions_slim'] = {};
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=forge');
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('forge');
    expect(res.body.data.versions).toEqual([]);
  });

  it('未知 type：如实 400（不再委托库「什么都能答」）', async () => {
    // 部署契约只允许 vanilla/paper/fabric/forge/purpur；未知类型走到这里是非法入参。
    // 旧实现会把任意 type 透传给 minecraft-core 并接受其返回，等于对非法入参也给答案。
    const { app } = buildApp();
    const res = await request(app).get('/api/versions?type=neoforge');
    expect(res.status).toBe(400);
  });
});

describe('Paper 构建发现链形态缺口', () => {
  function definePaperChain(buildsResp) {
    // key 用 projects/paper/versions（比 projects/paper 长，优先命中 builds URL，
    // 避免短 key 将发现链请求误匹配到版本列表响应）
    httpState.jsonTable['projects/paper/versions'] = buildsResp;
  }

  it('v3 裸数组响应：直接按构建数组过滤 STABLE 并选最新', async () => {
    definePaperChain([
      {
        id: 10,
        channel: 'STABLE',
        downloads: {
          'server:default': { url: 'https://fill-data.papermc.io/10.jar', checksums: {} },
        },
      },
      {
        id: 12,
        channel: 'STABLE',
        downloads: {
          'server:default': {
            url: 'https://fill-data.papermc.io/12.jar',
            checksums: { sha256: JAR_SHA256 },
          },
        },
      },
    ]);
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
    // 选中 id=12（checksums.sha256 齐全 → 强制校验通过）
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
      expect.objectContaining({ stage: 'error' }),
    );
  });

  it('STABLE 空回退全量构建 + 无 downloads → 502（v2 拼接回退已移除，不再返回 200）', async () => {
    definePaperChain([
      { id: 9, channel: 'BETA' },
      { id: 7, channel: 'ALPHA' },
    ]);
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('No Paper build download');
  });

  it('checksums 存在但无 sha256 → 直链下载且跳过强校验', async () => {
    definePaperChain({
      builds: [
        {
          id: 5,
          channel: 'STABLE',
          downloads: {
            'server:default': { url: 'https://fill-data.papermc.io/no-hash.jar', checksums: {} },
          },
        },
      ],
    });
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Branch Fixture' });
    expect(res.status).toBe(200);
    expect(res.body.data.mcVersion).toBe('1.21.4');
  });

  it('真实 v3 响应形状：摘要位于 downloads[server:default].checksums.sha256 → 强制校验通过', async () => {
    definePaperChain([
      {
        id: 232,
        time: '2026-05-11T11:43:09Z',
        channel: 'STABLE',
        downloads: {
          'server:default': {
            name: 'paper-1.21.4-232.jar',
            checksums: { sha256: JAR_SHA256 },
            size: 51437498,
            url: 'https://fill-data.papermc.io/v1/objects/xxx/paper-1.21.4-232.jar',
          },
        },
      },
    ]);
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'paper', mcVersion: '1.21.4', instanceName: 'Real Shape' });
    expect(res.status).toBe(200);
    const { httpStream } = await import('../utils/http-client.js');
    expect(httpStream.mock.calls[0][0]).toBe(
      'https://fill-data.papermc.io/v1/objects/xxx/paper-1.21.4-232.jar',
    );
  });
});

describe('deploy · 上游直链形态', () => {
  // 曾有一组「downloadServer 本地落盘」用例（build 为 path 形态 / build 为 null /
  // 库返回 url / 库返回空对象）。它们测的是 minecraft-core 的**库内自取**那条路，
  // 而那条路已被移除——它下面板侧的体积上限与下载域白名单都不生效（URL 不经过本仓，
  // 断言不到）。故随实现一并删除，不是被跳过。
  function defineVanilla() {
    defineManifest();
  }

  it('core build 真实形状（downloads.application.url）→ 直链下载成功', async () => {
    defineVanilla();
    // 夹具仍以 downloads.application.url 形态给地址，由合成层转成 Piston 详情
    testState.latestBuild = {
      downloads: {
        application: {
          url: 'https://piston-data.mojang.com/vanilla.jar',
          hash: crypto.createHash('sha1').update(JAR_BYTES).digest('hex'),
          hashType: 'sha1',
        },
      },
    };
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/instances/deploy')
      .send({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'Url Form' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Url Form');
  });
});

describe('下载进度节流与错误清理', () => {
  function defineVanillaChain() {
    defineManifest();
    testState.latestBuild = {
      downloads: { application: { url: 'https://piston-data.mojang.com/vanilla.jar' } },
    };
  }

  it('进度节流：按客户端 percent 直采发射，<1% 增量被抑制', async () => {
    defineVanillaChain();
    httpState.streamImpl = (url, streamMod) => {
      const pt = new streamMod.PassThrough();
      queueMicrotask(() => {
        // 事件 1：total=0 → 客户端 percent 亦为 0 → pct=0（0 与 lastPct=-1 差 1 → 发射）
        pt.emit('downloadProgress', { percent: 0, transferred: 0, total: 0 });
        // 事件 2：percent 恒等于 transferred/total = 0.1 → 发射
        pt.emit('downloadProgress', { percent: 0.1, transferred: 100, total: 1000 });
        // 事件 3：增量 0.005 < 0.01 → 节流跳过
        pt.emit('downloadProgress', { percent: 0.105, transferred: 105, total: 1000 });
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
      .filter(
        ([evt, payload]) =>
          evt === 'deployProgress' && payload.stage === 'download' && payload.transferred > 0,
      )
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
        try {
          fs.closeSync(fs.openSync(p, 'a'));
        } catch {
          /* 已存在 */
        }
      }
      return ws;
    });
    httpState.streamImpl = (url, streamMod) => {
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
          try {
            fs.closeSync(fs.openSync(p, 'a'));
          } catch {
            /* 已存在 */
          } // 确保存在 → unlink true 臂
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
      downloads: { application: { url: 'https://maven.minecraftforge.net/forge-installer.jar' } },
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
    const cfg = JSON.parse(
      fs.readFileSync(path.join(testState.serversDir, instanceId, 'instance.json'), 'utf-8'),
    );
    expect(cfg.jarFile).toBe('forge-1.0.0-server.jar');
    const files = fs.readdirSync(path.join(testState.serversDir, instanceId));
    expect(files).toContain('forge-1.0.0-server.jar');
    expect(files).not.toContain('forge-installer.jar'); // unlinkSync 清理
    expect(manager.emit).toHaveBeenCalledWith(
      'deployProgress',
      expect.objectContaining({ stage: 'forge_install', ...{ percent: 0 } }),
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
      expect.objectContaining({ stage: 'error' }),
    );
  });

  it('安装器 120s 超时 → 进程树终止 + 502 timed out', async () => {
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
    timerCall[0](); // 手动触发超时回调：终止进程树 + reject

    const res = await inflight;
    expect(res.status).toBe(502);
    expect(res.body.message).toContain('timed out (120s)');
    const { spawn, spawnSync } = await import('child_process');
    // 单进程 SIGKILL 兜底
    expect(spawn.mock.results[0].value.kill).toHaveBeenCalled();
    // 进程树终止（与实例 stop 同策略，见 utils/process-tree.js）：
    // Windows 走 taskkill /T 递归；POSIX 上安装器未 detached（无进程组语义）→ 不做 kill(-pid)
    if (process.platform === 'win32') {
      expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '42424'], {
        stdio: 'ignore',
      });
    } else {
      expect(spawnSync).not.toHaveBeenCalledWith('taskkill', expect.anything(), expect.anything());
    }
  });
});

describe('win32 平台分支与首启输出', () => {
  it('win32：spawn 不带 detached + 60s 超时走 taskkill /T 进程树终止', async () => {
    defineManifest();
    testState.latestBuild = {
      downloads: { application: { url: 'https://piston-data.mojang.com/vanilla.jar' } },
    };
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
      expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/F', '/T', '/PID', '42424'], {
        stdio: 'ignore',
      });
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('首启 stdout/stderr 输出累积 + 退出码非 0 且无 logs → 告警不阻断', async () => {
    defineManifest();
    testState.latestBuild = {
      downloads: { application: { url: 'https://piston-data.mojang.com/vanilla.jar' } },
    };
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
    httpState.jsonTable['projects/paper'] = { versions: {} };
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
      expect.objectContaining({ stage: 'error' }),
    );
  });
});
