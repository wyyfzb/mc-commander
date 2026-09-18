/**
 * 升级回滚路径 jarFile 名实一致化行为级测试（#539）
 *
 * 回滚终态契约：DB { jarFile: 旧名, mcVersion: 旧版本 } + 磁盘旧版本 jar
 * 本体唯一（错位副本清零、临时副本清零）+ 内存实例同步。修复前回滚仅回写
 * mcVersion 且恢复复制目标指向已被阶段 3 切换的新名，产生「新名旧内容」
 * jar + 旧 jar 本体残留，备份快照 --exclude 随之失效（冗余随备份链累积）。
 *
 * 覆盖：
 * ① verify 失败 → 回滚：DB 回写/磁盘文件名/内存三者一致，错位副本与残留清零
 * ② 阶段 3 前失败（下载中断）：jarFile 未切换，同名守卫不误删旧 jar 本体，
 *    DB 幂等恢复旧名旧版本
 * ③ 错位副本删除失败不阻塞回滚主流程（DB 回写与内存同步照常完成）
 * ④ 直调 _doRollback（阶段 3 已切换模拟）：恢复复制目标为旧本体路径
 *
 * 网络隔离：got 全量 mock（CI 离线确定性）；真实临时目录 + 真实 fs，
 * 复制/删除落盘行为可断言（禁止占位断言）。
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
  default: Object.assign(
    vi.fn(() => ({ json: () => jsonImpl.current() })),
    { stream: vi.fn(() => streamImpl.current()) }
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

import { UpgradeService, UPGRADE_STAGES } from '../services/upgrade.service.js';
import { InstanceModel } from '../db/index.js';

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

/** 下载流正常写完（数据可注入） */
function streamSucceeds({ data = 'NEW_JAR_CONTENT' } = {}) {
  return () => {
    const stream = makeFakeStream();
    queueMicrotask(() => {
      stream._emit('downloadProgress', { percent: 1, transferred: 1, total: 1 });
      if (data) stream._file.write(data);
      stream._file.end();
    });
    return stream;
  };
}

/** 首启即 crash 的实例桩（触发 verify 失败 → 回滚） */
function startEmitsCrash() {
  return vi.fn(() => {
    queueMicrotask(() => serverManagerRef.current.emit('instance:status', {
      instanceId: 'inst-1',
      event: 'crash',
    }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upgrade-rollback-'));
  jsonImpl.current = () => Promise.reject(new Error('offline (mocked)'));
  streamImpl.current = streamSucceeds();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function progressStages(serverManager) {
  return serverManager._emitted
    .filter((e) => e.event === 'instance:upgradeProgress')
    .map((e) => e.data.stage);
}

const OLD_JAR = () => path.join(tmpDir, 'server-1.20.4.jar');
const NEW_JAR = () => path.join(tmpDir, 'server-1.21.4.jar');

// ── ① verify 失败 → 回滚终态三者自洽 ──

describe('回滚终态三者自洽（#539 核心行为）', () => {
  it('verify 失败回滚后：DB 回写旧名+旧版本、磁盘旧 jar 本体唯一且内容一致、错位副本与残留清零、内存同步', async () => {
    const manager = createMockServerManager({ start: startEmitsCrash() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_CONTENT');

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Server crashed during startup verification'
    );

    // DB：replace 写新名新版本 → 回滚回写旧名旧版本（最后一次调用=回滚回写）
    expect(InstanceModel.update).toHaveBeenCalledTimes(2);
    expect(InstanceModel.update).toHaveBeenLastCalledWith('inst-1', {
      jarFile: 'server-1.20.4.jar',
      mcVersion: '1.20.4',
    });

    // 磁盘：旧 jar 本体唯一且内容=备份旧内容；错位副本（新名 jar）已删
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jar'))).toEqual([
      'server-1.20.4.jar',
    ]);
    expect(fs.readFileSync(OLD_JAR(), 'utf8')).toBe('OLD_JAR_CONTENT');
    // 临时回滚源副本清零（await 语义：reject 时已不在磁盘）
    expect(fs.readdirSync(tmpDir).some((f) => f.startsWith('._upgrade_backup_'))).toBe(false);

    // 内存：实例字段与 DB/磁盘一致（再次启动可找到 jar 文件）
    expect(manager._instance.jarFile).toBe('server-1.20.4.jar');
    expect(manager._instance.mcVersion).toBe('1.20.4');

    // 终态 failed（非 rollback 中途吞错）
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
  });
});

// ── ② 阶段 3 前失败：同名守卫 + 幂等回写 ──

describe('阶段 3 前失败：jarFile 未切换', () => {
  it('下载中断回滚：同名守卫不误删旧 jar 本体，DB 幂等恢复旧名旧版本', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_CONTENT');
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink');
    // 下载流报错：阶段 2 失败，阶段 3（jarFile 切换）未发生
    streamImpl.current = () => {
      const stream = makeFakeStream();
      queueMicrotask(() => stream._emit('error', new Error('download failed (mocked)')));
      return stream;
    };

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      /download failed/
    );

    // 旧 jar 本体原样保留（未被错位清理波及）
    expect(fs.readFileSync(OLD_JAR(), 'utf8')).toBe('OLD_JAR_CONTENT');
    // DB 回写：仅回滚一次（replace 未发生），恢复旧名旧版本
    expect(InstanceModel.update).toHaveBeenCalledTimes(1);
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.20.4.jar',
      mcVersion: '1.20.4',
    });
    // promises unlink 仅用于临时副本清理兜底（旧名不存在 ._upgrade_backup_ 文件，
    // ENOENT 被吞）；无错位副本删除目标（新名不在 promises unlink 调用参数中）
    const unlinkTargets = unlinkSpy.mock.calls.map((c) => c[0]);
    expect(unlinkTargets.every((p) => !p.endsWith('server-1.21.4.jar'))).toBe(true);
  });
});

// ── ③ 清理失败不阻塞回滚主流程 ──

describe('错位副本删除失败容忍', () => {
  it('unlink 拒绝时回滚核心语义照常完成：DB 回写 + 内存同步 + 原错误上抛', async () => {
    const manager = createMockServerManager({ start: startEmitsCrash() });
    const service = new UpgradeService(manager);
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_CONTENT');
    vi.spyOn(fs.promises, 'unlink').mockRejectedValue(new Error('EBUSY: resource busy'));

    await expect(service.upgrade('inst-1', '1.21.4', 'purpur')).rejects.toThrow(
      'Server crashed during startup verification'
    );

    // 删除失败被吞掉（错位副本/临时副本可能残留），但回滚核心语义完成
    expect(InstanceModel.update).toHaveBeenLastCalledWith('inst-1', {
      jarFile: 'server-1.20.4.jar',
      mcVersion: '1.20.4',
    });
    expect(manager._instance.jarFile).toBe('server-1.20.4.jar');
    expect(manager._instance.mcVersion).toBe('1.20.4');
    const stages = progressStages(manager);
    expect(stages[stages.length - 1]).toBe(UPGRADE_STAGES.FAILED);
  });
});

// ── ④ 直调 _doRollback：恢复目标与清理行为 ──

describe('_doRollback 直调（阶段 3 已切换模拟）', () => {
  it('恢复复制目标为旧 jar 本体路径，错位副本删除，DB/内存回写旧名旧版本', async () => {
    const manager = createMockServerManager();
    const service = new UpgradeService(manager);
    manager._instance._originalMcVersion = '1.20.4';
    // 模拟阶段 3 已切换：内存视角 jarFile 为新名，磁盘存在错位副本与旧本体
    manager._instance.jarFile = 'server-1.21.4.jar';
    fs.writeFileSync(NEW_JAR(), 'MISPLACED_NEW_CONTENT');
    fs.writeFileSync(OLD_JAR(), 'OLD_JAR_BODY');
    const backupPath = path.join(tmpDir, '._upgrade_backup_server-1.20.4.jar');
    fs.writeFileSync(backupPath, 'OLD_JAR_BODY');
    const asyncCopySpy = vi.spyOn(fs.promises, 'copyFile');

    await service._doRollback('inst-1', backupPath, null, 'server-1.20.4.jar');

    // 恢复复制：备份 → 旧 jar 本体路径（非新名，#539）
    expect(asyncCopySpy).toHaveBeenCalledWith(backupPath, OLD_JAR());
    expect(fs.readFileSync(OLD_JAR(), 'utf8')).toBe('OLD_JAR_BODY');
    // 错位副本删除：新名 jar 不复存在
    expect(fs.existsSync(NEW_JAR())).toBe(false);
    // DB 回写旧名旧版本
    expect(InstanceModel.update).toHaveBeenCalledWith('inst-1', {
      jarFile: 'server-1.20.4.jar',
      mcVersion: '1.20.4',
    });
    // 内存同步
    expect(manager._instance.jarFile).toBe('server-1.20.4.jar');
    // 临时副本清零（await 语义）
    expect(fs.existsSync(backupPath)).toBe(false);
  });
});
