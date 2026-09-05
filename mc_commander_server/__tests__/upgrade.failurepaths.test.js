/**
 * 升级服务异常路径与长尾分支补测（#465）
 *
 * 覆盖既有 3 个 upgrade 测试文件未触及的分支域：
 * ① resolveDownload 三上游分支矩阵：vanilla 缺版本/缺 JAR/无 sha1、paper v3
 *    数组与对象形态/stable 过滤/build 排序/摘要有无/v2 回退、purpur 契约、
 *    未支持类型
 * ② _downloadJar：写流异常（目标目录不存在）+ 进度百分比回退（percent 缺失
 *    时 transferred/total、total 缺失时 0）与节流早退（增量 <1% 不重复广播）
 * ③ _createBackupAndWait：备份失败事件（含/不含错误消息）、他实例事件隔离、
 *    createBackup 异常、300s 备份超时
 * ④ _startAndVerify：首启 crash、他实例状态隔离、实例内存缺失、start 同步
 *    抛错/异步拒绝、120s 校验超时
 * ⑤ _doRollback：恢复旧 JAR 至旧本体路径 + DB jarFile/mcVersion 回写
 *    （#539）、oldJarPath 为空跳过复制、_originalMcVersion/oldJarFile 缺失
 *    跳过回写、回滚自身失败兜底日志、备份恢复失败不阻塞
 *
 * 网络隔离：got 全量 mock（json/stream 行为按用例注入），CI 离线确定性。
 * 超时用例用 vi fake timers；其余用真实临时目录 + 真实 fs。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── 可变 mock 实现（vi.hoisted：factory 内不得引用外部变量） ──
const { jsonImpl, streamImpl } = vi.hoisted(() => ({
  jsonImpl: { current: null },
  streamImpl: { current: null },
}));

vi.mock('got', () => ({
  // got(url, opts) 返回 promise-like：resolveDownload 里链式 .json()
  default: Object.assign(
    vi.fn((...args) => ({ json: () => jsonImpl.current(...args) })),
    { stream: vi.fn((...args) => streamImpl.current(...args)) }
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

import { UpgradeService, UPGRADE_STAGES } from '../services/upgrade.service.js';
import { InstanceModel } from '../db/index.js';
import { AppError, ErrorCodes } from '../utils/response.js';
import { logger } from '../utils/logger.js';

// ── 桩 serverManager（真实临时目录作为 serverPath） ──

let tmpDir;

const serverManagerRef = { current: null };

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
    destroy() {
      stream._destroyed = true;
    },
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
    status: 'stopped',
    mcVersion: '1.20.4',
    jarFile: 'server-1.20.4.jar',
    serverPath: tmpDir,
    isRunning: false,
    start: vi.fn(() => {}),
    ...overrides,
  };
}

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

/** 模拟下载流：发一次进度后正常写完（默认空文件） */
function streamSucceeds({ transferred = 1, total = 1, data = '' } = {}) {
  return () => {
    const stream = makeFakeStream();
    queueMicrotask(() => {
      stream._emit('downloadProgress', { percent: total > 0 ? 1 : 0, transferred, total });
      if (data) stream._file.write(data);
      stream._file.end();
    });
    return stream;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upgrade-fp-'));
  jsonImpl.current = () => Promise.reject(new Error('offline (mocked)'));
  streamImpl.current = () => {
    const stream = makeFakeStream();
    queueMicrotask(() => stream._emit('error', new Error('download failed (mocked)')));
    return stream;
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 等待升级流程推进到指定阶段（真实 fs stat 作事件轮转，不依赖 fake clock） */
function waitForStage(manager, stage, tries = 500) {
  return new Promise((resolve, reject) => {
    const poll = (n) => {
      if (progressStages(manager).includes(stage)) return resolve();
      if (n <= 0) return reject(new Error(`stage ${stage} not reached`));
      fs.stat(tmpDir, () => poll(n - 1));
    };
    poll(tries);
  });
}

function progressStages(serverManager) {
  return serverManager._emitted
    .filter((e) => e.event === 'instance:upgradeProgress')
    .map((e) => e.data.stage);
}

function progressPercents(serverManager) {
  return serverManager._emitted
    .filter((e) => e.event === 'instance:upgradeProgress' && e.data.stage === UPGRADE_STAGES.DOWNLOAD)
    .map((e) => e.data.percent);
}

// ── ① resolveDownload 三上游分支矩阵 ──

describe('resolveDownload 分支矩阵', () => {
  it('vanilla：manifest 无该版本 → 抛 not found', async () => {
    const service = new UpgradeService(createMockServerManager());
    jsonImpl.current = () => Promise.resolve({ versions: [] });
    await expect(service.resolveDownload('1.21.4', 'vanilla')).rejects.toThrow(
      'Vanilla version 1.21.4 not found'
    );
  });

  it('vanilla：version detail 无 server 下载 → 抛 no server JAR', async () => {
    const service = new UpgradeService(createMockServerManager());
    jsonImpl.current = (url) => {
      if (url.includes('version_manifest')) {
        return Promise.resolve({
          versions: [{ id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v.json' }],
        });
      }
      return Promise.resolve({});
    };
    await expect(service.resolveDownload('1.21.4', 'vanilla')).rejects.toThrow(
      'No server JAR download for 1.21.4'
    );
  });

  it('vanilla：server 下载无 sha1 → expectedHash 为 null（跳过完整性校验）', async () => {
    const service = new UpgradeService(createMockServerManager());
    jsonImpl.current = (url) => {
      if (url.includes('version_manifest')) {
        return Promise.resolve({
          versions: [{ id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v.json' }],
        });
      }
      return Promise.resolve({
        downloads: { server: { url: 'https://piston-data.mojang.com/server-1.21.4.jar' } },
      });
    };
    const res = await service.resolveDownload('1.21.4', 'vanilla');
    expect(res.url).toBe('https://piston-data.mojang.com/server-1.21.4.jar');
    expect(res.expectedHash).toBeNull();
  });

  it('paper v3：数组形态 + STABLE/RECOMMENDED 混合 → 按 build id 降序取最新并携带 sha256', async () => {
    const service = new UpgradeService(createMockServerManager());
    jsonImpl.current = () =>
      Promise.resolve([
        { id: 3, channel: 'STABLE', downloads: { 'server:default': { url: 'https://fill-data.papermc.io/b3.jar', sha256: 'a'.repeat(64) } } },
        { id: 7, channel: 'RECOMMENDED', downloads: { 'server:default': { url: 'https://fill-data.papermc.io/b7.jar', sha256: 'b'.repeat(64) } } },
      ]);
    const res = await service.resolveDownload('1.21.4', 'paper');
    expect(res.url).toBe('https://fill-data.papermc.io/b7.jar');
    expect(res.expectedHash).toEqual({ algorithm: 'sha256', digest: 'b'.repeat(64) });
  });

  it('paper v3：对象形态且无 stable build → 回退全部 builds，application 下载无摘要 → hash null', async () => {
    const service = new UpgradeService(createMockServerManager());
    jsonImpl.current = () =>
      Promise.resolve({
        builds: [{ id: 9, channel: 'EXPERIMENTAL', downloads: { application: { url: 'https://fill-data.papermc.io/b9.jar' } } }],
      });
    const res = await service.resolveDownload('1.21.4', 'paper');
    expect(res.url).toBe('https://fill-data.papermc.io/b9.jar');
    expect(res.expectedHash).toBeNull();
  });

  it('paper v3：无任何可用 build → 抛 No Paper build found', async () => {
    const service = new UpgradeService(createMockServerManager());
    jsonImpl.current = () => Promise.resolve({});
    await expect(service.resolveDownload('1.21.4', 'paper')).rejects.toThrow(
      'No Paper build found for 1.21.4'
    );
  });

  it('paper v3：latest 无 downloads → v2 回退拼接 URL（id 计算构建号）且 hash null', async () => {
    const service = new UpgradeService(createMockServerManager());
    jsonImpl.current = () => Promise.resolve({ builds: [{ id: 42 }] });
    const res = await service.resolveDownload('1.21.4', 'paper');
    expect(res.url).toBe(
      'https://api.papermc.io/v2/projects/paper/versions/1.21.4/builds/42/downloads/paper-1.21.4-42.jar'
    );
    expect(res.expectedHash).toBeNull();
  });

  it('paper v3：downloadInfo 有 name 无 url → v2 回退沿用该文件名，build 号回退 build 字段', async () => {
    const service = new UpgradeService(createMockServerManager());
    jsonImpl.current = () =>
      Promise.resolve({
        builds: [{ build: 88, downloads: { 'server:default': { name: 'custom-name.jar' } } }],
      });
    const res = await service.resolveDownload('1.21.4', 'paper');
    expect(res.url).toBe(
      'https://api.papermc.io/v2/projects/paper/versions/1.21.4/builds/88/downloads/custom-name.jar'
    );
    expect(res.expectedHash).toBeNull();
  });

  it('purpur：固定 latest/download URL 且无上游摘要', async () => {
    const service = new UpgradeService(createMockServerManager());
    const res = await service.resolveDownload('1.21.4', 'purpur');
    expect(res.url).toBe('https://api.purpurmc.org/v2/purpur/1.21.4/latest/download');
    expect(res.expectedHash).toBeNull();
  });

  it('未支持类型 → 抛 Unsupported server type', async () => {
    const service = new UpgradeService(createMockServerManager());
    await expect(service.resolveDownload('1.21.4', 'fabric')).rejects.toThrow(
      'Unsupported server type: fabric'
    );
  });
});

// ── ② _downloadJar 写流异常与进度回退 ──

describe('_downloadJar 异常与进度矩阵', () => {
  it('畸形 URL：域白名单解析失败同步抛 VALIDATION_ERROR', () => {
    const service = new UpgradeService(createMockServerManager());
    const dest = path.join(tmpDir, 'server-1.21.4.jar');
    expect(() => service._downloadJar('::not a url::', dest, 'inst-1', null)).toThrow(AppError);
    expect(() => service._downloadJar('::not a url::', dest, 'inst-1', null)).toThrow(
      /Invalid download URL/
    );
    expect(() => service._downloadJar('::not a url::', dest, 'inst-1', null)).toThrow(
      expect.objectContaining({ code: ErrorCodes.VALIDATION_ERROR.code })
    );
  });

  it('写流异常（目标目录不存在）：reject 且不产生 uncaught', async () => {
    const service = new UpgradeService(createMockServerManager());
    const badDest = path.join(tmpDir, 'no-such-dir', 'server-1.21.4.jar');
    await expect(
      service._downloadJar('https://piston-data.mojang.com/server-1.21.4.jar', badDest, 'inst-1', null)
    ).rejects.toThrow(/ENOENT|no such file or directory/i);
  });

  it('进度百分比回退与节流：percent 缺失按 transferred/total、total 缺失记 0、增量 <1% 早退', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    streamImpl.current = () => {
      const stream = makeFakeStream();
      queueMicrotask(() => {
        // total 缺失（0）→ pct 记 0
        stream._emit('downloadProgress', { percent: 0, transferred: 0, total: 0 });
        // percent 缺失且 total>0 → pct = transferred/total
        stream._emit('downloadProgress', { percent: 0, transferred: 50, total: 100 });
        // 增量 0.4% < 1% → 节流早退，不广播
        stream._emit('downloadProgress', { percent: 0, transferred: 50.4, total: 100 });
        // percent 直供
        stream._emit('downloadProgress', { percent: 0.99, transferred: 99, total: 100 });
        stream._emit('error', new Error('download failed (mocked)'));
      });
      return stream;
    };

    await expect(
      service._downloadJar('https://piston-data.mojang.com/server-1.21.4.jar', path.join(tmpDir, 'x.jar'), 'inst-1', null)
    ).rejects.toThrow(/download failed/);

    // 广播序列：0% → 50% → 99%（50.4% 被节流吸收）
    expect(progressPercents(manager)).toEqual([0, 50, 99]);
  });
});

// ── ③ 备份域 ──

describe('_createBackupAndWait 失败与超时', () => {
  it('backupFailed 事件（含错误消息）→ 升级失败并回写 DB 原版本', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    service.backupService.createBackup = vi.fn(async (instanceId) => {
      manager.emit('instance:backupFailed', { instanceId, error: 'disk full' });
      throw new Error('unreachable');
    });

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow('disk full');

    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
    expect(stages).toContain(UPGRADE_STAGES.ROLLED_BACK);
    // 回滚 DB 回写：恢复旧 jarFile 名 + 旧版本（#539；备份失败时 jarFile 未切换，幂等恢复）
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.20.4.jar',
      mcVersion: '1.20.4',
    });
  });

  it('backupFailed 事件缺 error 字段 → 兜底消息 Backup failed', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    service.backupService.createBackup = vi.fn(async (instanceId) => {
      manager.emit('instance:backupFailed', { instanceId });
      throw new Error('unreachable');
    });

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow('Backup failed');
  });

  it('他实例的 backupComplete 事件被忽略，等待本实例回执后继续', async () => {
    const manager = createMockServerManager();
    // 成功链路：首启需发射 ready 事件完成校验
    manager._instance.start = vi.fn(() => {
      queueMicrotask(() => serverManagerRef.current.emit('instance:status', {
        instanceId: 'inst-1',
        event: 'ready',
      }));
    });
    const service = new UpgradeService(manager);
    service.backupService.createBackup = vi.fn(async () => {
      // 先发他实例回执（应被 instanceId 过滤忽略），再发本实例回执
      manager.emit('instance:backupComplete', { instanceId: 'inst-other', backupId: 'bk-x' });
      manager.emit('instance:backupComplete', { instanceId: 'inst-1', backupId: 'bk-1' });
      return 'bk-1';
    });
    streamImpl.current = streamSucceeds();

    await service.upgrade('inst-1', '1.21.4', 'purpur');
    expect(progressStages(manager)).toContain(UPGRADE_STAGES.COMPLETED);
  });

  it('createBackup promise 直接拒绝 → 清理监听并上抛', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    service.backupService.createBackup = vi.fn(async () => {
      throw new Error('boom-backup');
    });

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow('boom-backup');
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
  });

  it('备份 300s 超时 → 抛 Backup timeout（fake timers）', async () => {
    vi.useFakeTimers();
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    // 备份永不完成
    service.backupService.createBackup = vi.fn(() => new Promise(() => {}));

    const promise = service.upgrade('inst-1', '1.21.4', 'purpur');
    const assertion = expect(promise).rejects.toThrow('Backup timeout');
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;

    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
  });
});

// ── ④ 首启校验域 ──

describe('_startAndVerify 失败与超时', () => {
  it('首启 crash → 校验拒绝 + 回滚恢复旧 JAR 内容 + DB 版本回写', async () => {
    const manager = createMockServerManager();
    manager._instance.start = vi.fn(() => {
      queueMicrotask(() => serverManagerRef.current.emit('instance:status', {
        instanceId: 'inst-1',
        event: 'crash',
      }));
    });
    const service = new UpgradeService(manager);
    // 旧 JAR 实际存在：replace 阶段会先复制到备份，crash 后回滚应恢复其内容
    fs.writeFileSync(path.join(tmpDir, 'server-1.20.4.jar'), 'OLD_JAR_CONTENT');
    streamImpl.current = streamSucceeds({ data: 'NEW_JAR_CONTENT' });

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Server crashed during startup verification'
    );

    const stages = progressStages(manager);
    expect(stages).toContain(UPGRADE_STAGES.ROLLED_BACK);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);

    // 回滚把备份的旧 JAR 恢复回旧 jar 本体路径（#539：目标不再是被切换的新名）
    expect(fs.readFileSync(path.join(tmpDir, 'server-1.20.4.jar'), 'utf8')).toBe('OLD_JAR_CONTENT');
    // 错位副本（新名 jar）已删：旧版本 jar 本体唯一
    expect(fs.existsSync(path.join(tmpDir, 'server-1.21.4.jar'))).toBe(false);
    // 临时备份 JAR 由 _doRollback finally 内异步 unlink 清理（fire-and-forget），
    // 与回滚 resolve 之间无同步屏障——waitFor 轮询等待落盘完成再断言
    await vi.waitFor(() =>
      expect(fs.readdirSync(tmpDir)).not.toContain('._upgrade_backup_server-1.20.4.jar')
    );
    // DB：replace 阶段写新版本，回滚阶段恢复旧 jarFile 名 + 原版本（#539）
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.21.4.jar',
      mcVersion: '1.21.4',
    });
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.20.4.jar',
      mcVersion: '1.20.4',
    });
  });

  it('他实例的 instance:status 事件被忽略，本实例 ready 后完成升级', async () => {
    const manager = createMockServerManager();
    manager._instance.start = vi.fn(() => {
      queueMicrotask(() => {
        serverManagerRef.current.emit('instance:status', { instanceId: 'inst-other', event: 'ready' });
        serverManagerRef.current.emit('instance:status', { instanceId: 'inst-1', event: 'ready' });
      });
    });
    const service = new UpgradeService(manager);
    streamImpl.current = streamSucceeds();

    await service.upgrade('inst-1', '1.21.4', 'purpur');
    expect(progressStages(manager)[progressStages(manager).length - 1]).toBe(UPGRADE_STAGES.COMPLETED);
  });

  it('verify 阶段实例内存缺失 → 抛 Instance not found in memory，回滚早退不回写 DB', async () => {
    const manager = createMockServerManager();
    const realGetInstance = manager.getInstance;
    // 第 1 次（编排入口）返回实例；verify 阶段起返回 null
    manager.getInstance = vi.fn()
      .mockImplementationOnce((id) => realGetInstance(id))
      .mockReturnValue(null);
    const service = new UpgradeService(manager);
    streamImpl.current = streamSucceeds();

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Instance not found in memory'
    );

    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
    // 回滚因实例缺失早退：仅 replace 阶段的 update，无 mcVersion 恢复回写
    expect(InstanceModel.update).toHaveBeenCalledTimes(1);
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.21.4.jar',
      mcVersion: '1.21.4',
    });
  });

  it('start() 返回 rejected promise → 上抛启动错误', async () => {
    const manager = createMockServerManager();
    manager._instance.start = vi.fn(() => Promise.reject(new Error('eula not accepted')));
    const service = new UpgradeService(manager);
    streamImpl.current = streamSucceeds();

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow('eula not accepted');
    expect(progressStages(manager)).toContain(UPGRADE_STAGES.ROLLED_BACK);
  });

  it('start() 同步抛错 → 上抛且监听已清理', async () => {
    const manager = createMockServerManager();
    manager._instance.start = vi.fn(() => {
      throw new Error('port already in use');
    });
    const service = new UpgradeService(manager);
    streamImpl.current = streamSucceeds();

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow('port already in use');
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
  });

  it('首启校验 120s 超时 → 抛 Startup verification timed out（fake timers）', async () => {
    vi.useFakeTimers();
    const manager = createMockServerManager();
    manager._instance.start = vi.fn(() => {});
    const service = new UpgradeService(manager);
    streamImpl.current = streamSucceeds();

    const promise = service.upgrade('inst-1', '1.21.4', 'purpur');
    const assertion = expect(promise).rejects.toThrow('Startup verification timed out (120s)');
    // 下载/替换链路含真实 I/O 轮转：先等 VERIFY 阶段定时器已注册，再推进时钟
    await waitForStage(manager, UPGRADE_STAGES.VERIFY);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;

    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
    expect(stages).toContain(UPGRADE_STAGES.ROLLED_BACK);
  });
});

// ── ⑤ 回滚域 ──

describe('_doRollback 分支行为', () => {
  it('oldJarPath 为空：跳过 JAR 复制但仍按旧名+旧版本回写 DB', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    manager._instance._originalMcVersion = '1.20.4';

    await service._doRollback('inst-1', null, null, 'server-1.20.4.jar');

    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.20.4.jar',
      mcVersion: '1.20.4',
    });
  });

  it('_originalMcVersion 缺失：跳过 DB 回写', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);

    await service._doRollback('inst-1', null, null, 'server-1.20.4.jar');

    expect(InstanceModel.update).not.toHaveBeenCalled();
  });

  it('回滚自身失败：记错误日志、清理临时备份，原错误仍上抛', async () => {
    const manager = createMockServerManager();
    manager._instance.start = vi.fn(() => {
      queueMicrotask(() => {
        // 启动时实例目录"消失"：回滚的路径收口将抛非 PathTraversal 错误
        manager._instance.serverPath = undefined;
        serverManagerRef.current.emit('instance:status', { instanceId: 'inst-1', event: 'crash' });
      });
    });
    const service = new UpgradeService(manager);
    fs.writeFileSync(path.join(tmpDir, 'server-1.20.4.jar'), 'OLD_JAR_CONTENT');
    streamImpl.current = streamSucceeds();
    const errorSpy = vi.spyOn(logger, 'error');

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Server crashed during startup verification'
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Rollback failed'),
      expect.anything()
    );
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
    // 临时备份 JAR 仍被 finally 清理（异步 unlink，waitFor 与落盘同步）
    await vi.waitFor(() =>
      expect(fs.readdirSync(tmpDir)).not.toContain('._upgrade_backup_server-1.20.4.jar')
    );
  });

  it('备份恢复（restoreBackup）失败不阻塞主流程：原错误照常上抛', async () => {
    const manager = createMockServerManager();
    manager._instance.start = vi.fn(() => {
      queueMicrotask(() => serverManagerRef.current.emit('instance:status', {
        instanceId: 'inst-1',
        event: 'crash',
      }));
    });
    const service = new UpgradeService(manager);
    service.backupService.restoreBackup = vi.fn().mockRejectedValue(new Error('restore boom'));
    streamImpl.current = streamSucceeds();

    // 原始错误（crash）而非恢复错误（restore boom）上抛
    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Server crashed during startup verification'
    );
    expect(service.backupService.restoreBackup).toHaveBeenCalledWith('bk-mock');
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
  });
});

// ── ⑥ 构造器降级 ──

describe('构造器降级', () => {
  it('serverManager 为 null：回退实例本地 Map，进度查询返回空态', () => {
    const service = new UpgradeService(null);
    expect(service.isUpgrading('any')).toBe(false);
    expect(service.getUpgradeProgress('any')).toBeNull();
  });
});
