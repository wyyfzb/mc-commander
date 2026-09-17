import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { EventEmitter } from 'events';

// ---------- BackupService 编排层错误路径防护网（issue 500） ----------
// 与 flow.test.js（真实文件系统 + 真实快照命令的主流程集成）互补：
// 本文件专注错误分支与平台/工具分支——spawn 子进程行为全部 mock（平台无关，
// 不依赖 rsync 安装），文件操作保持真实（断言回滚/清理的真实落盘结果）。
// spawn mock 采用 importOriginal 语义级替换（#419 范式）：仅替换 spawn 导出，
// 其余 child_process 能力保持原实现。

vi.mock('../db/backup.model.js', () => ({
  BackupModel: {
    findAll: vi.fn(() => ({ total: 0, backups: [] })),
    create: vi.fn(),
    update: vi.fn(),
    findByIdWithPath: vi.fn(),
    delete: vi.fn(() => true),
    resetStaleInProgress: vi.fn(),
  },
}));

vi.mock('../db/scheduled_task.model.js', () => ({
  ScheduledTaskModel: {
    updateLastRunStatus: vi.fn(),
  },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

import config from '../config.js';
import { BackupService, getBackupService, sanitizeFileName, estimateDirSize } from '../services/backup.service.js';
import { BackupModel as MockBackupModel } from '../db/backup.model.js';
import { spawn as mockSpawn } from 'child_process';
import { ErrorCodes, AppError } from '../utils/response.js';

// 等待事件（fire-and-forget 流程以事件作为完成信号）
function waitForEvent(emitter, eventName, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs);
    emitter.on(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// spawn mock 辅助：返回 EventEmitter，微任务中按指定方式结束
function spawnEmits(emitFn) {
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter();
    queueMicrotask(() => emitFn(proc));
    return proc;
  });
}

const realPlatform = process.platform;
function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

// 默认 spawn 行为：close 0（成功）。各用例按需覆盖——vi.clearAllMocks 不清
// implementation，统一在 beforeEach 重设默认值防跨 describe 污染
function spawnSucceeds() {
  spawnEmits((proc) => proc.emit('close', 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

function createTestInstance(serversDir, instanceId = 's1') {
  const dir = path.join(serversDir, instanceId);
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'world-data');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(dir, 'server.jar'), 'jar-data');
  return dir;
}

/** 目录树逐字节快照：相对路径 + sha256，用于断言「原目录未动」 */
function snapshotTree(dir) {
  const out = [];
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push([path.relative(dir, full), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  };
  walk(dir);
  return out;
}

function makeManager(instanceStub = null) {
  const manager = new EventEmitter();
  manager.getInstance = vi.fn(() => instanceStub);
  return manager;
}

describe('spawnProcess 封装：退出码白名单与 ENOENT 转译', () => {
  let service;
  beforeEach(() => {
    vi.clearAllMocks();
    MockBackupModel.findAll.mockReturnValue({ total: 0, backups: [] });
    service = new BackupService(null);
  });

  it('退出码不在 okCodes：reject Exit code N（rsync 快照命令失败）', async () => {
    spawnEmits((proc) => proc.emit('close', 1));
    await expect(service._rsyncSnapshot('s1', path.join(config.backupsDir, 's1', 'snap'), {}))
      .rejects.toThrow('Exit code 1');
  });

  it('rsync exit 24（源文件传输中消失）容忍为成功（okCodes [0,24] 语义）', async () => {
    spawnEmits((proc) => proc.emit('close', 24));
    await expect(service._rsyncSnapshot('s1', path.join(config.backupsDir, 's1', 'snap'), {}))
      .resolves.toBeUndefined();
  });

  it('命令缺失：ENOENT 转译为可操作提示并保留 code（供降级分支判定）', async () => {
    spawnEmits((proc) => proc.emit('error', Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' })));
    const err = await service._rsyncSnapshot('s1', path.join(config.backupsDir, 's1', 'snap'), {}).catch((e) => e);
    expect(err.message).toContain('Command not found: rsync');
    expect(err.code).toBe('ENOENT');
  });
});

describe('_createSnapshot 平台分支：win32 降级与 Linux 主路径', () => {
  let service;
  beforeEach(() => {
    vi.clearAllMocks();
    MockBackupModel.findAll.mockReturnValue({ total: 0, backups: [] });
    spawnSucceeds();
    service = new BackupService(null);
  });
  afterEach(() => setPlatform(realPlatform));

  it('win32：rsync 可用（MSYS2）直接使用，返回 rsync', async () => {
    setPlatform('win32');
    spawnEmits((proc) => proc.emit('close', 0));
    const tool = await service._createSnapshot('s1', '/snap', {});
    expect(tool).toBe('rsync');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe('rsync');
  });

  it('win32：rsync ENOENT 自动降级 robocopy 全量镜像（位标志 1 亦为成功）', async () => {
    setPlatform('win32');
    mockSpawn.mockImplementation((cmd) => {
      const proc = new EventEmitter();
      if (cmd === 'rsync') {
        queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' })));
      } else {
        queueMicrotask(() => proc.emit('close', 1));
      }
      return proc;
    });
    const tool = await service._createSnapshot('s1', '/snap', {});
    expect(tool).toBe('robocopy');
    const robocopyCall = mockSpawn.mock.calls.find((c) => c[0] === 'robocopy');
    expect(robocopyCall[1]).toContain('/MIR');
    // robocopy close 1（位标志：有文件复制）未报错 = okCodes 0-7 容忍语义生效
  });

  it('win32：rsync 命令执行失败（非 ENOENT）原样上抛，不降级', async () => {
    setPlatform('win32');
    spawnEmits((proc) => proc.emit('close', 23));
    await expect(service._createSnapshot('s1', '/snap', {})).rejects.toThrow('Exit code 23');
    expect(mockSpawn.mock.calls.every((c) => c[0] === 'rsync')).toBe(true);
  });

  it('Linux：固定 rsync 主路径，不做降级探测', async () => {
    spawnEmits((proc) => proc.emit('close', 0));
    const tool = await service._createSnapshot('s1', '/snap', {});
    expect(tool).toBe('rsync');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe('_restoreFromSnapshot 平台分支：恢复降级路径', () => {
  let service;
  beforeEach(() => {
    vi.clearAllMocks();
    spawnSucceeds();
    service = new BackupService(null);
  });
  afterEach(() => setPlatform(realPlatform));

  it('win32：rsync ENOENT 降级 robocopy /MIR（镜像语义等价 --delete）', async () => {
    setPlatform('win32');
    mockSpawn.mockImplementation((cmd) => {
      const proc = new EventEmitter();
      if (cmd === 'rsync') {
        queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT' })));
      } else {
        queueMicrotask(() => proc.emit('close', 0));
      }
      return proc;
    });
    await expect(service._restoreFromSnapshot('/snap', '/inst', {})).resolves.toBeUndefined();
    const robocopyCall = mockSpawn.mock.calls.find((c) => c[0] === 'robocopy');
    expect(robocopyCall[1]).toContain('/MIR');
  });

  it('Linux：rsync -a --delete（--delete 仅恢复场景使用）', async () => {
    spawnEmits((proc) => proc.emit('close', 0));
    await service._restoreFromSnapshot('/snap', '/inst', {});
    expect(mockSpawn.mock.calls[0][0]).toBe('rsync');
    expect(mockSpawn.mock.calls[0][1]).toEqual(['-a', '--delete', '/snap/', '/inst/']);
  });

  it('win32：rsync 非 ENOENT 失败原样上抛（不降级 robocopy）', async () => {
    setPlatform('win32');
    spawnEmits((proc) => proc.emit('close', 5));
    await expect(service._restoreFromSnapshot('/snap', '/inst', {})).rejects.toThrow('Exit code 5');
    expect(mockSpawn.mock.calls.every((c) => c[0] === 'rsync')).toBe(true);
  });
});

describe('_verifySnapshot 完整性边界', () => {
  let service;
  let tmpRoot;
  beforeEach(() => {
    vi.clearAllMocks();
    service = new BackupService(null);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-verify-'));
  });
  afterEach(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('快照目录不存在：明确报错（与 restoreBackup 同步段双保险）', async () => {
    await expect(service._verifySnapshot(path.join(tmpRoot, 'ghost')))
      .rejects.toThrow('Snapshot directory not found');
  });

  it('空快照目录：拒绝（空快照恢复会毁掉原世界）', async () => {
    const dir = path.join(tmpRoot, 'empty-snap');
    fs.mkdirSync(dir);
    await expect(service._verifySnapshot(dir)).rejects.toThrow('Snapshot is empty');
  });

  it('非空但无 level.dat：拒绝（备份可能损坏）', async () => {
    const dir = path.join(tmpRoot, 'no-world');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'server.properties'), 'x');
    await expect(service._verifySnapshot(dir)).rejects.toThrow('no level.dat');
  });
});

describe('executeBackup：RCON 保存序列与对称恢复', () => {
  let tmpRoot;
  let serversDir;
  let backupsDir;
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    MockBackupModel.findAll.mockReturnValue({ total: 0, backups: [] });
    MockBackupModel.create.mockReturnValue({ id: 1, instanceId: 's1', name: 'x' });
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-rcon-'));
    serversDir = path.join(tmpRoot, 'servers');
    backupsDir = path.join(tmpRoot, 'backups');
    fs.mkdirSync(serversDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    config.serversDir = serversDir;
    config.backupsDir = backupsDir;
    manager = makeManager();
  });
  afterEach(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  function snapshotWithWorld() {
    const snapshotDir = path.join(backupsDir, 's1', 'snap');
    vi.spyOn(BackupService.prototype, '_createSnapshot').mockImplementation(async (_id, dir) => {
      fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'x');
    });
    return snapshotDir;
  }

  it('RCON 可用实例：save-off → save-all flush → 完成后 finally 补发 save-on（成对保证）', async () => {
    createTestInstance(serversDir);
    const snapshotDir = snapshotWithWorld();
    const send = vi.fn().mockResolvedValue('ok');
    manager.getInstance = vi.fn(() => ({ isRunning: true, isRconConnected: true, sendCommandWithResponse: send, jarFile: 'server.jar' }));
    const service = new BackupService(manager);

    const done = waitForEvent(manager, 'instance:backupComplete');
    await service.executeBackup('s1', 1, snapshotDir, {});
    await done;

    expect(send).toHaveBeenCalledWith('save-off', { timeout: 3000 });
    expect(send).toHaveBeenCalledWith('save-all flush', { timeout: 5000 });
    expect(send).toHaveBeenCalledWith('save-on', { timeout: 3000 });
    expect(send.mock.calls.indexOf(send.mock.calls.find((c) => c[0] === 'save-off')))
      .toBeLessThan(send.mock.calls.indexOf(send.mock.calls.find((c) => c[0] === 'save-all flush')));
  });

  it('save 序列 RCON 失败非致命：快照继续完成，save-on 仍在 finally 补发', async () => {
    createTestInstance(serversDir);
    const snapshotDir = snapshotWithWorld();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('RCON timeout'))   // save-off 失败
      .mockRejectedValueOnce(new Error('RCON timeout'));  // save-all flush 失败
    manager.getInstance = vi.fn(() => ({ isRunning: true, isRconConnected: true, sendCommandWithResponse: send, jarFile: 'server.jar' }));
    const service = new BackupService(manager);

    const done = waitForEvent(manager, 'instance:backupComplete');
    await expect(service.executeBackup('s1', 1, snapshotDir, {})).resolves.toBeUndefined();
    await done;

    expect(MockBackupModel.update).toHaveBeenCalledWith(1, { status: 'completed', size: expect.any(Number) });
    expect(send).toHaveBeenCalledWith('save-on', { timeout: 3000 });
  });

  it('save-on 失败：backupFailed 事件（phase=save-on）暴露给用户（防永久停写）', async () => {
    createTestInstance(serversDir);
    const snapshotDir = snapshotWithWorld();
    const send = vi.fn()
      .mockResolvedValueOnce('ok')                         // save-off
      .mockResolvedValueOnce('ok')                         // save-all flush
      .mockRejectedValueOnce(new Error('connection lost')); // save-on（finally 中）
    manager.getInstance = vi.fn(() => ({ isRunning: true, isRconConnected: true, sendCommandWithResponse: send, jarFile: 'server.jar' }));
    const service = new BackupService(manager);

    const done = waitForEvent(manager, 'instance:backupComplete');
    const saveOnFailed = waitForEvent(manager, 'instance:backupFailed');
    await service.executeBackup('s1', 1, snapshotDir, {});
    await done;
    const failed = await saveOnFailed;

    expect(failed.phase).toBe('save-on');
    expect(failed.error).toContain('connection lost');
    expect(failed.content).toContain('恢复自动保存失败');
  });

  it('_restoreSaveOn 早退：无 serverManager / 实例不存在 / RCON 不可用均静默返回', async () => {
    const bare = new BackupService(null);
    await expect(bare._restoreSaveOn('s1')).resolves.toBeUndefined();

    manager.getInstance = vi.fn(() => null);
    const noInstance = new BackupService(manager);
    await expect(noInstance._restoreSaveOn('s1')).resolves.toBeUndefined();

    manager.getInstance = vi.fn(() => ({ isRconConnected: false, sendCommandWithResponse: vi.fn() }));
    const noRcon = new BackupService(manager);
    await expect(noRcon._restoreSaveOn('s1')).resolves.toBeUndefined();
  });
});

describe('executeRestore 安全网：后台竞态放弃与中段失败回滚', () => {
  let tmpRoot;
  let serversDir;
  let backupsDir;
  let manager;
  let service;

  beforeEach(() => {
    vi.clearAllMocks();
    MockBackupModel.findAll.mockReturnValue({ total: 0, backups: [] });
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-restore-'));
    serversDir = path.join(tmpRoot, 'servers');
    backupsDir = path.join(tmpRoot, 'backups');
    fs.mkdirSync(serversDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    config.serversDir = serversDir;
    config.backupsDir = backupsDir;
    manager = makeManager();
    service = new BackupService(manager);
  });
  afterEach(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  function goodSnapshot() {
    const snapshotDir = path.join(backupsDir, 's1', 'snap-good');
    fs.mkdirSync(path.join(snapshotDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'world', 'level.dat'), 'SNAP-DATA');
    fs.writeFileSync(path.join(snapshotDir, 'server.properties'), 'level-name=world\n');
    return snapshotDir;
  }

  const backup = { id: 1, instance_id: 's1', name: '恢复源' };

  it('后台执行期间实例被启动：放弃恢复（pre_restore 未创建，原目录不受影响）', async () => {
    createTestInstance(serversDir);
    const snapshotDir = goodSnapshot();
    spawnSucceeds();
    // 后台执行期二次检查发现实例已被启动（同步段检查之后的竞态）
    manager.getInstance = vi.fn(() => ({ isRunning: true, isRconConnected: false }));
    const failed = waitForEvent(manager, 'instance:restoreFailed');

    await expect(
      service.executeRestore(1, backup, path.join(serversDir, 's1'), snapshotDir, {})
    ).rejects.toThrow('实例正在运行');
    await failed;

    // 二次运行检查发生在 rename 之前：原实例目录完好，无暂存残留
    expect(fs.readFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'utf8')).toBe('world-data');
    expect(fs.readdirSync(serversDir).filter((n) => n.includes('_pre_restore_'))).toEqual([]);
    expect(MockBackupModel.update).toHaveBeenCalledWith(1, { status: 'completed' });
  });

  it('复制结果缺世界数据：删除半成品新目录 + pre_restore 原样回归（原世界不丢）', async () => {
    createTestInstance(serversDir);
    const snapshotDir = goodSnapshot();
    manager.getInstance = vi.fn(() => ({ isRunning: false, isRconConnected: false }));
    // 模拟复制只写回部分文件（无 level.dat）：⑤ 校验失败触发完整回滚
    vi.spyOn(service, '_restoreFromSnapshot').mockImplementation(async () => {
      fs.mkdirSync(path.join(serversDir, 's1'), { recursive: true });
      fs.writeFileSync(path.join(serversDir, 's1', 'server.properties'), 'partial-copy');
    });
    const failed = waitForEvent(manager, 'instance:restoreFailed');

    await expect(
      service.executeRestore(1, backup, path.join(serversDir, 's1'), snapshotDir, {})
    ).rejects.toThrow('no level.dat');
    await failed;

    // 回滚后：原实例目录（含原始世界数据）从 pre_restore rename 回来
    expect(fs.readFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'utf8')).toBe('world-data');
    expect(fs.readFileSync(path.join(serversDir, 's1', 'server.properties'), 'utf8')).toBe('level-name=world\n');
    expect(fs.readdirSync(serversDir).filter((n) => n.includes('_pre_restore_'))).toEqual([]);
    expect(fs.existsSync(snapshotDir)).toBe(true); // 快照本身不受影响
    expect(MockBackupModel.update).toHaveBeenCalledWith(1, { status: 'completed' });
  });

  it('回滚中状态回写失败：不吞原错误（原恢复失败原因上抛）', async () => {
    createTestInstance(serversDir);
    const snapshotDir = goodSnapshot();
    manager.getInstance = vi.fn(() => ({ isRunning: false, isRconConnected: false }));
    vi.spyOn(service, '_restoreFromSnapshot').mockImplementation(async () => {
      fs.mkdirSync(path.join(serversDir, 's1'), { recursive: true });
      fs.writeFileSync(path.join(serversDir, 's1', 'server.properties'), 'partial-copy');
    });
    MockBackupModel.update.mockImplementation(() => { throw new Error('db locked'); });

    await expect(
      service.executeRestore(1, backup, path.join(serversDir, 's1'), snapshotDir, {})
    ).rejects.toThrow('no level.dat');
    // 回滚的文件系统动作不受状态回写失败影响：原世界已还原
    expect(fs.readFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'utf8')).toBe('world-data');
  });

  // 状态位复位回归守卫（审查 M1）：pre_restore 在步骤⑥被删掉之后，「回滚能力」已消失，
  // 此后（DB 回写/日志/事件派发）失败必须保留**已恢复成功**的实例目录。判据若是「本次
  // 是否换过目录」这个状态位而不复位，就会把一次成功的恢复反向销毁（删掉新目录 +
  // rename 已不存在的 pre_restore → 实例目录彻底消失）
  it('恢复已成功后置步骤（状态回写）失败：保留已恢复目录，不得反向销毁', async () => {
    createTestInstance(serversDir);
    const snapshotDir = goodSnapshot();
    manager.getInstance = vi.fn(() => ({ isRunning: false, isRconConnected: false }));
    // 复制成功且带世界数据：⑤ 校验通过，流程走到 ⑥（删 pre_restore → 回写状态）
    vi.spyOn(service, '_restoreFromSnapshot').mockImplementation(async (_snap, target) => {
      fs.mkdirSync(path.join(target, 'world'), { recursive: true });
      fs.writeFileSync(path.join(target, 'world', 'level.dat'), 'RESTORED');
    });
    MockBackupModel.update.mockImplementation(() => { throw new Error('db locked'); });
    const failed = waitForEvent(manager, 'instance:restoreFailed');

    await expect(
      service.executeRestore(1, backup, path.join(serversDir, 's1'), snapshotDir, {})
    ).rejects.toThrow('db locked');
    await failed;

    // 已恢复的实例目录必须原样保留（内容是新世界，不是被回滚掉的旧数据）
    expect(fs.readFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'utf8')).toBe('RESTORED');
    // 且没有把 pre_restore 又搬回来（旧目录在 ⑥ 已按设计删除）
    expect(fs.readdirSync(serversDir).filter((n) => n.includes('_pre_restore_'))).toEqual([]);
    expect(fs.existsSync(snapshotDir)).toBe(true);
  });

  it('_copyBackJarFiles：配置 jar 与扫描 *.jar 均复制回；单文件复制失败不中断', async () => {
    const preRestore = path.join(serversDir, 'pre');
    const newInstance = path.join(serversDir, 'new');
    fs.mkdirSync(preRestore, { recursive: true });
    fs.mkdirSync(newInstance, { recursive: true });
    fs.writeFileSync(path.join(preRestore, 'server.jar'), 'preferred');
    fs.writeFileSync(path.join(preRestore, 'other.jar'), 'scanned');
    fs.writeFileSync(path.join(preRestore, 'notes.txt'), 'not-jar');

    const realCopy = fs.copyFileSync.bind(fs);
    const copied = [];
    vi.spyOn(fs, 'copyFileSync').mockImplementation((src, dst) => {
      if (String(dst).endsWith('server.jar')) throw new Error('EBUSY: locked');
      copied.push(String(dst));
      return realCopy(src, dst);
    });
    service._copyBackJarFiles(preRestore, newInstance, 'server.jar');
    vi.restoreAllMocks();

    // 优先配置的 server.jar 复制失败：仅警告，扫描到的 other.jar 仍复制成功
    expect(fs.existsSync(path.join(newInstance, 'other.jar'))).toBe(true);
    expect(fs.existsSync(path.join(newInstance, 'notes.txt'))).toBe(false);
    expect(copied.some((d) => d.endsWith('other.jar'))).toBe(true);
  });

  it('_copyBackJarFiles：pre_restore 不可读时按配置 jarFile 兜底（不抛错）', () => {
    const newInstance = path.join(serversDir, 'new');
    fs.mkdirSync(newInstance, { recursive: true });
    expect(() => service._copyBackJarFiles(path.join(serversDir, 'ghost-pre'), newInstance, 'server.jar')).not.toThrow();
    expect(fs.existsSync(path.join(newInstance, 'server.jar'))).toBe(false);
  });

  it('_hasLevelData：目录不可读返回 false（恢复结果校验据此走回滚）', () => {
    expect(service._hasLevelData(path.join(serversDir, 'ghost-inst'))).toBe(false);
  });
});

describe('createBackup / restoreBackup / deleteBackup 入口校验缺口收口', () => {
  let tmpRoot;
  let serversDir;
  let backupsDir;
  let manager;
  let service;

  beforeEach(() => {
    vi.clearAllMocks();
    // vi.restoreAllMocks 只恢复 spyOn，对 vi.fn 模块 mock 的 implementation 不清除
    // （前组「回滚中状态回写失败」的 update→throw 遗留会污染本组）——显式重置
    MockBackupModel.update.mockReset().mockImplementation((id, data) => ({ id, ...data }));
    MockBackupModel.findAll.mockReturnValue({ total: 0, backups: [] });
    MockBackupModel.create.mockReturnValue({ id: 1, instanceId: 's1', name: 'x' });
    MockBackupModel.findByIdWithPath.mockReturnValue(null);
    MockBackupModel.delete.mockReturnValue(true);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-entry-'));
    serversDir = path.join(tmpRoot, 'servers');
    backupsDir = path.join(tmpRoot, 'backups');
    fs.mkdirSync(serversDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    config.serversDir = serversDir;
    config.backupsDir = backupsDir;
    manager = makeManager();
    service = new BackupService(manager);
  });
  afterEach(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('同实例已有 creating 中：互斥拒绝（BACKUP_IN_PROGRESS，覆盖调度器入口）', async () => {
    MockBackupModel.findAll.mockImplementation((q) =>
      q.status === 'creating' ? { total: 1, backups: [] } : { total: 0, backups: [] });
    await expect(service.createBackup('s1', {}))
      .rejects.toMatchObject({ code: ErrorCodes.BACKUP_IN_PROGRESS.code });
    expect(MockBackupModel.create).not.toHaveBeenCalled();
  });

  it('statfs 不可用（罕见平台）：跳过磁盘预检不阻断备份（非 AppError 被吞）', async () => {
    createTestInstance(serversDir);
    const statfsSpy = vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
      throw new Error('statfs unsupported on this platform');
    });
    vi.spyOn(BackupService.prototype, '_createSnapshot').mockImplementation(async (_id, dir) => {
      fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'x');
    });
    const done = waitForEvent(manager, 'instance:backupComplete');
    try {
      await expect(service.createBackup('s1', {})).resolves.toBeTruthy();
      await done;
    } finally {
      statfsSpy.mockRestore();
    }
  });

  it('restoreBackup：备份不存在 → BACKUP_NOT_FOUND', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue(null);
    await expect(service.restoreBackup(404))
      .rejects.toMatchObject({ code: ErrorCodes.BACKUP_NOT_FOUND.code });
  });

  it('restoreBackup：实例目录不存在 → 明确报错（同步段拦截）', async () => {
    const snapshotDir = path.join(backupsDir, 'gone', 'snap');
    fs.mkdirSync(snapshotDir, { recursive: true });
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 2, instance_id: 'gone', status: 'completed', file_path: snapshotDir,
    });
    await expect(service.restoreBackup(2)).rejects.toThrow('Instance directory not found');
  });

  it('restoreBackup：file_path 指向文件而非目录 → 4xx（VALIDATION_ERROR，与下载侧同码）且原实例目录未动', async () => {
    const instanceDir = createTestInstance(serversDir);
    // 哨兵：恢复若在任何阶段触碰实例目录，下面的逐字节快照必然变化
    fs.writeFileSync(path.join(instanceDir, 'SENTINEL.txt'), 'DO-NOT-TOUCH');
    const before = snapshotTree(instanceDir);

    const filePath = path.join(backupsDir, 's1', 'not-a-dir');
    fs.mkdirSync(path.join(backupsDir, 's1'), { recursive: true });
    fs.writeFileSync(filePath, 'stray file bytes');
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 3, instance_id: 's1', status: 'completed', file_path: filePath,
    });

    const err = await service.restoreBackup(3).then(() => null, (e) => e);
    // 钉住错误形状：4xx 语义的 AppError，不是普通 Error（500）
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
    expect(err.status).toBe(ErrorCodes.VALIDATION_ERROR.status);
    expect(err.message).toBe('Snapshot path is not a directory');
    // 同步段拦截：未置 restoring、未开后台恢复
    expect(MockBackupModel.update).not.toHaveBeenCalled();
    // 原实例目录逐字节未动（含 sentinel），且无 pre_restore 暂存残留
    expect(snapshotTree(instanceDir)).toEqual(before);
    expect(fs.readdirSync(serversDir).filter((n) => n.includes('_pre_restore_'))).toEqual([]);
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace-only', '   '],
    ['non-string', 12345],
  ])('restoreBackup：file_path 为 %s → BACKUP_NOT_FOUND（不被当作 cwd，也不抛普通 Error）', async (_label, filePath) => {
    createTestInstance(serversDir);
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 4, instance_id: 's1', status: 'completed', file_path: filePath,
    });
    await expect(service.restoreBackup(4))
      .rejects.toMatchObject({ code: ErrorCodes.BACKUP_NOT_FOUND.code });
  });

  it('restoreBackup：快照目录在磁盘上不存在 → BACKUP_NOT_FOUND（与下载侧同码，不再落 500）', async () => {
    const instanceDir = createTestInstance(serversDir);
    const before = snapshotTree(instanceDir);
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 5, instance_id: 's1', status: 'completed',
      file_path: path.join(service.backupsDir, 's1', 'ghost-snapshot'),
    });
    const err = await service.restoreBackup(5).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCodes.BACKUP_NOT_FOUND.code);
    expect(err.status).toBe(ErrorCodes.BACKUP_NOT_FOUND.status);
    expect(MockBackupModel.update).not.toHaveBeenCalled();
    expect(snapshotTree(instanceDir)).toEqual(before);
  });

  it('deleteBackup：备份不存在 → BACKUP_NOT_FOUND', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue(null);
    await expect(service.deleteBackup(404))
      .rejects.toMatchObject({ code: ErrorCodes.BACKUP_NOT_FOUND.code });
  });

  it('deleteBackup：creating 状态互斥（与 restoring 同一拒绝分支）', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 5, instance_id: 's1', status: 'creating', file_path: null,
    });
    await expect(service.deleteBackup(5))
      .rejects.toMatchObject({ code: ErrorCodes.BACKUP_IN_PROGRESS.code });
    expect(MockBackupModel.delete).not.toHaveBeenCalled();
  });
});

describe('cleanupOldBackups：时间上限与失败容忍', () => {
  let manager;
  let service;
  beforeEach(() => {
    vi.clearAllMocks();
    manager = makeManager();
    service = new BackupService(manager);
  });

  it('超过 maxAgeDays 的备份被清理（数量上限内仍按时间删除）', async () => {
    const backups = Array.from({ length: 3 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (40 - i));
      return { id: i + 1, createdAt: d.toISOString() };
    });
    MockBackupModel.findAll.mockReturnValue({ total: 3, backups });
    const deleteSpy = vi.spyOn(service, 'deleteBackup').mockResolvedValue(true);

    const deleted = await service.cleanupOldBackups('s1', { maxBackups: 10, maxAgeDays: 30 });
    expect(deleted).toBe(3);
    expect(deleteSpy.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('单条删除失败：记日志继续（deletedCount 只计成功，不中断清理循环）', async () => {
    const backups = Array.from({ length: 3 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (40 - i));
      return { id: i + 1, createdAt: d.toISOString() };
    });
    MockBackupModel.findAll.mockReturnValue({ total: 3, backups });
    const deleteSpy = vi.spyOn(service, 'deleteBackup')
      .mockRejectedValueOnce(new Error('rm failed'))
      .mockResolvedValue(true);

    const deleted = await service.cleanupOldBackups('s1', { maxBackups: 10, maxAgeDays: 30 });
    expect(deleted).toBe(2);
    expect(deleteSpy).toHaveBeenCalledTimes(3);
  });
});

describe('detectOrphanedPreRestoreDirs：崩溃残留检测', () => {
  let tmpRoot;
  let serversDir;
  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-orphan-'));
    serversDir = path.join(tmpRoot, 'servers');
    fs.mkdirSync(serversDir, { recursive: true });
    config.serversDir = serversDir;
  });
  afterEach(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('残留 pre_restore 目录检出并告警；正常实例目录不计入', () => {
    fs.mkdirSync(path.join(serversDir, 's1_pre_restore_2026-09-05T10-00-00-000Z'));
    fs.mkdirSync(path.join(serversDir, 's1'));
    const service = new BackupService(null);
    expect(service.detectOrphanedPreRestoreDirs()).toBe(1);
  });

  it('无残留 / serversDir 不可读均返回 0', () => {
    const service = new BackupService(null);
    expect(service.detectOrphanedPreRestoreDirs()).toBe(0);
    config.serversDir = path.join(tmpRoot, 'ghost-servers');
    expect(service.detectOrphanedPreRestoreDirs()).toBe(0);
  });
});

describe('estimateDirSize 边界：目录缺失 / 排除清单 / 统计竞态', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-size-'));
  });
  afterEach(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('目录不存在：返回 0（由后续备份/恢复路径报错）', async () => {
    await expect(estimateDirSize(path.join(tmpRoot, 'ghost'))).resolves.toBe(0);
  });

  it('排除清单：logs/pid/lock/hs_err/jarFile 不计入，世界数据计入', async () => {
    const dir = path.join(tmpRoot, 'inst');
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), 'x'.repeat(100));
    fs.writeFileSync(path.join(dir, 'server.pid'), 'x'.repeat(10));
    fs.writeFileSync(path.join(dir, 'run.lock'), 'x'.repeat(10));
    fs.writeFileSync(path.join(dir, 'hs_err_pid1.log'), 'x'.repeat(10));
    fs.writeFileSync(path.join(dir, 'server.jar'), 'x'.repeat(50));
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'x'.repeat(70));
    const size = await estimateDirSize(dir, { jarFile: 'server.jar' });
    expect(size).toBe(70);
  });

  it('文件在统计间隙被删除（运行中实例竞态）：跳过不抛错', async () => {
    const dir = path.join(tmpRoot, 'inst');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.bin'), 'x'.repeat(30));
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
      if (String(p).endsWith('a.bin')) throw new Error('file vanished mid-scan');
      return realStat(p);
    });
    try {
      await expect(estimateDirSize(dir)).resolves.toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('工具函数与单例', () => {
  it('sanitizeFileName：Windows 非法字符与控制字符替换，中文/Unicode 保留', () => {
    expect(sanitizeFileName('a<b>:"/d\\e|f?*g')).toBe('a_b____d_e_f__g');
    expect(sanitizeFileName('name\u0001with\u001fctrl')).toBe('name_with_ctrl');
    expect(sanitizeFileName('每日备份')).toBe('每日备份');
    expect(sanitizeFileName(42)).toBe('42');
  });

  it('getBackupService：模块级单例（多次调用同一实例）', () => {
    const a = getBackupService();
    const b = getBackupService();
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(BackupService);
  });
});
