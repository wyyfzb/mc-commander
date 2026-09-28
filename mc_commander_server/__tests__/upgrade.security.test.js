/**
 * 升级接口安全加固测试（mcVersion 白名单 + JAR 路径收口 + 下载域白名单）
 *
 * 覆盖三层防线：
 * ① 路由白名单：恶意 mcVersion payload 一律 400（VALIDATION_ERROR），不触发审计与服务层
 * ② 服务层纵深：绕过路由直调 upgrade() 时，jarFile 白名单 + resolveSafePath
 *    收口保证写入/备份/回滚均不逃逸实例目录（真实临时目录 + 真实 fs）
 * ③ 下载域白名单：上游 API 响应被污染（URL 指向任意主机）时拒绝下载
 *
 * 网络隔离：got 全量 mock（json/stream 行为按用例注入），保证 CI 离线确定性。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── 可变 mock 实现（vi.hoisted：factory 内不得引用外部变量） ──
const { jsonImpl, streamImpl } = vi.hoisted(() => ({
  jsonImpl: { current: null },
  streamImpl: { current: null },
}));

vi.mock('got', () => ({
  // got(url, opts) 返回 promise-like：resolveDownloadUrl 里链式 .json()
  default: Object.assign(
    vi.fn((...args) => ({ json: () => jsonImpl.current(...args) })),
    { stream: vi.fn((...args) => streamImpl.current(...args)) },
  ),
}));

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

vi.mock('../db/index.js', () => ({
  InstanceModel: { update: vi.fn() },
}));

vi.mock('../utils/audit.js', () => ({
  recordAudit: vi.fn(),
  AuditActions: {
    INSTANCE_UPGRADE: 'INSTANCE_UPGRADE',
    INSTANCE_UPGRADE_ROLLBACK: 'INSTANCE_UPGRADE_ROLLBACK',
  },
}));

import { createUpgradeRoutes } from '../routes/upgrade.js';
import { UpgradeService, MC_VERSION_REGEX, UPGRADE_STAGES } from '../services/upgrade.service.js';
import { InstanceModel } from '../db/index.js';
import { recordAudit } from '../utils/audit.js';
import { ErrorCodes } from '../utils/response.js';

// ── 桩 serverManager（真实临时目录作为 serverPath） ──

let tmpDir;

function makeFakeStream() {
  const listeners = {};
  const stream = {
    on(ev, cb) {
      (listeners[ev] = listeners[ev] || []).push(cb);
      return stream;
    },
    pipe(file) {
      stream._file = file;
      return stream;
    },
    destroy() {},
  };
  stream._emit = (ev, ...args) => {
    (listeners[ev] || []).forEach((cb) => cb(...args));
  };
  return stream;
}

function createMockInstance(overrides = {}) {
  return {
    id: 'inst-1',
    name: 'Test Server',
    mcVersion: '1.20.4',
    jarFile: 'server-1.20.4.jar',
    serverPath: tmpDir,
    isRunning: false,
    start: vi.fn(() => {
      // 模拟首启 ready 事件（_startAndVerify 依赖）
      queueMicrotask(() =>
        serverManagerRef.current.emit('instance:status', {
          instanceId: 'inst-1',
          event: 'ready',
        }),
      );
    }),
    ...overrides,
  };
}

const serverManagerRef = { current: null };

function createMockServerManager(instanceOverrides = {}) {
  const instance = createMockInstance(instanceOverrides);
  const listeners = {};
  const emitted = [];
  const manager = {
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
      (listeners[event] || []).forEach((fn) => fn(data));
    }),
    _instance: instance,
    _emitted: emitted,
  };
  serverManagerRef.current = manager;
  return manager;
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

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upgrade-sec-'));
  jsonImpl.current = () => Promise.reject(new Error('offline (mocked)'));
  streamImpl.current = () => {
    const stream = makeFakeStream();
    queueMicrotask(() => stream._emit('error', new Error('download failed (mocked)')));
    return stream;
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── ① 路由白名单矩阵 ──

describe('路由 mcVersion 白名单', () => {
  let serverManager;
  let request;

  beforeEach(() => {
    serverManager = createMockServerManager();
    request = supertest(createApp(serverManager));
  });

  it.each([
    ['相对路径穿越', '../../etc/passwd'],
    ['深层穿越', '..%2F..%2Fetc%2Fshadow'],
    ['Windows 绝对路径', 'C:\\Windows\\evil.jar'],
    ['命令注入形态', '1.21;rm -rf /'],
    ['空白注入', '1.21 x'],
    ['URL 编码穿越字面量', '%2e%2e%2f'],
    ['超段数', '1.21.4.1.1'],
    ['非数字前缀', 'v1.21'],
    ['超长数字段', '1.9999999'],
    ['换行注入', '1.21\n'],
  ])('恶意 mcVersion「%s」返回 400 且不触发审计', async (_label, payload) => {
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ mcVersion: payload, type: 'purpur' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
    expect(res.body.message).toMatch(/Invalid mcVersion/);
    // 未到达审计埋点（埋点在全部校验之后）
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it.each(['1', '1.21', '1.21.4', '265'])('合法版本「%s」通过白名单受理 202', async (version) => {
    const res = await request
      .post('/api/v1/instances/inst-1/upgrade')
      .send({ mcVersion: version, type: 'purpur' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.mcVersion).toBe(version);
  });

  it('MC_VERSION_REGEX 导出契约：路由与服务层同一口径', () => {
    expect(MC_VERSION_REGEX).toBeInstanceOf(RegExp);
    expect(MC_VERSION_REGEX.test('1.21.4')).toBe(true);
    expect(MC_VERSION_REGEX.test('../evil')).toBe(false);
  });
});

// ── ② 服务层纵深（绕过路由直调） ──

describe('服务层路径收口（真实临时目录 + 真实 fs）', () => {
  it('穿越 mcVersion 直调服务层：fail-fast 拒绝且实例目录零文件', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);

    await expect(service.upgrade('inst-1', '../../evil', 'purpur')).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCodes.VALIDATION_ERROR.code,
    });

    // fail-fast 于备份/下载之前：无任何副作用文件
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(serverManager._emitted.filter((e) => e.event === 'instance:upgradeProgress')).toEqual(
      [],
    );
  });

  it('下载域白名单：上游 manifest 被污染指向任意主机时拒绝下载', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);

    // vanilla 分支：manifest 中 versionEntry.url 与 detail.downloads.server.url 均被污染
    jsonImpl.current = (url) => {
      if (url.includes('version_manifest')) {
        return Promise.resolve({
          versions: [{ id: '1.21.4', type: 'release', url: 'https://evil.example.com/v.json' }],
        });
      }
      return Promise.resolve({
        downloads: { server: { url: 'https://evil.example.com/server-1.21.4.jar' } },
      });
    };

    await expect(service.upgrade('inst-1', '1.21.4', 'vanilla')).rejects.toThrow(
      /Download host not allowed: evil\.example\.com/,
    );
    // 污染 URL 未产生任何写入（回滚仅恢复升级前旧 jarFile 名——污染上下文的
    // 新版本文件名从未入库，#539）
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(InstanceModel.update).not.toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.21.4.jar',
      mcVersion: '1.21.4',
    });
  });

  it('全链路成功：白名单域下载落盘在实例目录内，jarFile 入库值合规', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);

    // vanilla 分支：合法白名单域
    jsonImpl.current = (url) => {
      if (url.includes('version_manifest')) {
        return Promise.resolve({
          versions: [
            { id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v.json' },
          ],
        });
      }
      return Promise.resolve({
        downloads: { server: { url: 'https://piston-data.mojang.com/server-1.21.4.jar' } },
      });
    };
    streamImpl.current = () => {
      const stream = makeFakeStream();
      queueMicrotask(() => {
        stream._emit('downloadProgress', { percent: 1, transferred: 1, total: 1 });
        if (stream._file) stream._file.end();
      });
      return stream;
    };

    await service.upgrade('inst-1', '1.21.4', 'vanilla');

    // jarFile 入库值：固定 server-<version>.jar 形态
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.21.4.jar',
      mcVersion: '1.21.4',
    });

    // 落地路径：仍在实例目录内（穿越断言——resolveSafePath 收口生效）
    const written = fs.readdirSync(tmpDir);
    expect(written).toContain('server-1.21.4.jar');
    for (const name of written) {
      // 分隔符归一为正斜杠再断言前缀：Windows 反斜杠路径做正则转义易碎，统一归一化比较
      const norm = (p) => p.replaceAll('\\', '/');
      expect(norm(path.resolve(tmpDir, name))).toMatch(new RegExp(`^${norm(tmpDir)}/`));
    }

    // 进度终态 completed
    const stages = serverManager._emitted
      .filter((e) => e.event === 'instance:upgradeProgress')
      .map((e) => e.data.stage);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.COMPLETED);
  });

  it('下载失败回滚：进度终态 failed，无文件外逸实例目录', async () => {
    const serverManager = createMockServerManager();
    const service = new UpgradeService(serverManager);

    // purpur：resolveDownloadUrl 无 json 调用；下载流 mock 报错（beforeEach 默认）
    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(/download failed/);

    const stages = serverManager._emitted
      .filter((e) => e.event === 'instance:upgradeProgress')
      .map((e) => e.data.stage);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
    expect(stages).toContain(UPGRADE_STAGES.ROLLED_BACK);

    // 实例目录（或其外）无残留文件
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});
