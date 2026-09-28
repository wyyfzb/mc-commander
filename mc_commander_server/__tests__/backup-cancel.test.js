import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { EventEmitter } from 'events';

// ---------- 备份/恢复取消与进度（清单 #16） ----------
// 与 errors.test.js 同范式：spawn 子进程全部 mock（平台无关），文件操作保持
// 真实（断言取消路径的半成品清理与回滚真实落盘）。取消通道的核心断言点：
// requestCancelBackup 命中注册表 → abort → spawn 以 CANCELLED 上抛 →
// executeBackup 删除记录 + 发 backupCancelled；executeRestore 走既有回滚 +
// 发 restoreCancelled，两条路径的注册表项都被清理。

vi.mock('../db/backup.model.js', () => ({
  BackupModel: {
    findAll: vi.fn(() => ({ total: 0, backups: [] })),
    create: vi.fn(() => ({ id: 77 })),
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

import {
  BackupService,
  requestCancelBackup,
  createRsyncProgressParser,
} from '../services/backup.service.js';
import { BackupModel as MockBackupModel } from '../db/backup.model.js';
import { ScheduledTaskModel as MockScheduledTaskModel } from '../db/scheduled_task.model.js';
import { spawn as mockSpawn } from 'child_process';
import config from '../config.js';

const realPlatform = process.platform;
function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** spawn mock：返回带 kill/stdout 的 EventEmitter，用例自控结束时机 */
function spawnControlled() {
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.kill = vi.fn(() => {
      queueMicrotask(() => proc.emit('close', null, 'SIGTERM'));
      return true;
    });
    return proc;
  });
}

function waitForEvent(emitter, eventName, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${eventName}`)),
      timeoutMs,
    );
    emitter.on(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

const originalServersDir = config.serversDir;
const originalBackupsDir = config.backupsDir;
afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(realPlatform);
  config.serversDir = originalServersDir;
  config.backupsDir = originalBackupsDir;
});

describe('createRsyncProgressParser（纯解析器）', () => {
  it('从 progress2 刷新流解析最后一段百分比', () => {
    const seen = [];
    const parse = createRsyncProgressParser((p) => seen.push(p));
    parse(' 1,234  12.5%  3MB/s 0:00:01\r 2,345  45%  3MB/s 0:00:02\r');
    expect(seen).toEqual([45]);
  });

  it('chunk 边界截断百分比数字时留待下一 chunk 拼接（不丢、不误解析）', () => {
    const seen = [];
    const parse = createRsyncProgressParser((p) => seen.push(p));
    parse('  1,000  3');
    parse('7.5%  1MB/s\r');
    expect(seen).toEqual([37.5]);
  });

  it('无百分比输出（robocopy/ditto 路径）恒为 no-op', () => {
    const seen = [];
    const parse = createRsyncProgressParser((p) => seen.push(p));
    parse('some log line without percent\n');
    expect(seen).toEqual([]);
  });
});

describe('备份取消（executeBackup 取消分支）', () => {
  let service;
  let tmpRoot;
  let snapshotDir;
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('linux');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cancel-'));
    fs.mkdirSync(path.join(tmpRoot, 'servers', 's1', 'world'), { recursive: true });
    snapshotDir = path.join(tmpRoot, 'snapshots', 's1', 'snap-1');
    manager = new EventEmitter();
    manager.getInstance = () => null;
    service = new BackupService(manager);
    // config.serversDir/backupsDir 指向临时目录（共享单例逐字段覆盖，afterEach 还原）——
    // executeRestore 的 pre_restore 目录取自 config.serversDir，仅覆盖 service 实例字段不够
    config.serversDir = path.join(tmpRoot, 'servers');
    config.backupsDir = path.join(tmpRoot, 'snapshots');
    service.serversDir = config.serversDir;
    service.backupsDir = config.backupsDir;
    spawnControlled();
  });

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('取消命中注册表 → CANCELLED 分支：删除记录 + backupCancelled 事件 + 半成品清理', async () => {
    const cancelledEvt = waitForEvent(manager, 'instance:backupCancelled');
    const failedEvents = [];
    manager.on('instance:backupFailed', (d) => failedEvents.push(d));

    const done = service
      .executeBackup('s1', 77, snapshotDir, { estimateBytes: 1024, jarFile: null, taskId: null })
      .catch((e) => e);

    // executeBackup 启动即注册；取消 API 命中并 abort → spawn mock 收到 kill
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    // 模拟 rsync 已写入的半成品（取消清理断言的对象）
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'partial.dat'), 'half');
    const hit = requestCancelBackup('s1');
    expect(hit).toEqual({ kind: 'create', backupId: 77 });

    const err = await done;
    expect(err.code).toBe('CANCELLED');
    const evt = await cancelledEvt;
    expect(evt).toMatchObject({ instanceId: 's1', backupId: 77 });

    // 主动取消不留 failed 记录：删记录而非置状态；不发 backupFailed
    expect(MockBackupModel.delete).toHaveBeenCalledWith(77);
    expect(MockBackupModel.update).not.toHaveBeenCalled();
    expect(failedEvents).toEqual([]);

    // 半成品快照目录被清理
    expect(fs.existsSync(snapshotDir)).toBe(false);

    // 注册表项清理：再次请求取消为空
    expect(requestCancelBackup('s1')).toBeNull();
  });

  it('定时任务取消按失败回写（原因「已取消」）', async () => {
    manager.on('instance:backupCancelled', () => {});
    const done = service
      .executeBackup('s1', 77, snapshotDir, { estimateBytes: 1024, jarFile: null, taskId: 5 })
      .catch((e) => e);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    requestCancelBackup('s1');
    await done;
    expect(MockScheduledTaskModel.updateLastRunStatus).toHaveBeenCalledWith(
      5,
      'failed',
      '已取消',
      expect.any(Number),
    );
  });
});

describe('恢复取消（executeRestore 取消分支）', () => {
  let service;
  let tmpRoot;
  let instanceDir;
  let snapshotDir;
  let manager;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('linux');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-rcancel-'));
    // 实例目录与快照都带世界数据（预检与恢复校验要求 level.dat）
    instanceDir = path.join(tmpRoot, 'servers', 's1');
    fs.mkdirSync(path.join(instanceDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'world', 'level.dat'), 'dat');
    snapshotDir = path.join(tmpRoot, 'snapshots', 's1', 'snap-1');
    fs.mkdirSync(path.join(snapshotDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, 'world', 'level.dat'), 'dat');
    manager = new EventEmitter();
    manager.getInstance = () => null;
    service = new BackupService(manager);
    config.serversDir = path.join(tmpRoot, 'servers');
    config.backupsDir = path.join(tmpRoot, 'snapshots');
    service.serversDir = config.serversDir;
    service.backupsDir = config.backupsDir;
    spawnControlled();
  });

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('恢复取消 → 走既有回滚（pre_restore rename 回来）+ restoreCancelled 事件 + status 回 completed', async () => {
    const cancelledEvt = waitForEvent(manager, 'instance:restoreCancelled');
    const failedEvents = [];
    manager.on('instance:restoreFailed', (d) => failedEvents.push(d));

    const backup = { instance_id: 's1', name: '备份 A' };
    const done = service
      .executeRestore(77, backup, instanceDir, snapshotDir, { jarFile: null })
      .catch((e) => e);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    expect(requestCancelBackup('s1')).toEqual({ kind: 'restore', backupId: 77 });
    const err = await done;
    expect(err.code).toBe('CANCELLED');

    const evt = await cancelledEvt;
    expect(evt).toMatchObject({ instanceId: 's1', backupId: 77 });

    // 回滚：原实例目录回来了（含世界数据），pre_restore 不残留
    expect(fs.existsSync(path.join(instanceDir, 'world', 'level.dat'))).toBe(true);
    const leftovers = fs
      .readdirSync(path.join(tmpRoot, 'servers'))
      .filter((n) => n.includes('_pre_restore_'));
    expect(leftovers).toEqual([]);

    // 备份记录回 completed（快照完好可再恢复），不发 restoreFailed
    expect(MockBackupModel.update).toHaveBeenCalledWith(77, { status: 'completed' });
    expect(failedEvents).toEqual([]);
    expect(requestCancelBackup('s1')).toBeNull();
  });

  it('回滚失败时取消文案如实（不谎报已还原）', async () => {
    // 只拦回滚方向（pre_restore → 实例目录）的 rename，放行换出方向（步骤②）——
    // 直接复现「取消后回滚 rename 失败」的最坏路径，断言文案不谎报已还原
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!String(to).includes('_pre_restore_')) {
        throw Object.assign(new Error('rename busy'), { code: 'EBUSY' });
      }
      return realRename(from, to);
    });
    const cancelledEvt = waitForEvent(manager, 'instance:restoreCancelled');
    const backup = { instance_id: 's1', name: '备份 A' };
    const done = service
      .executeRestore(77, backup, instanceDir, snapshotDir, { jarFile: null })
      .catch((e) => e);

    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    expect(requestCancelBackup('s1')).toEqual({ kind: 'restore', backupId: 77 });
    const evt = await cancelledEvt;
    expect(evt.content).toContain('回滚失败');
    await done;
    expect(renameSpy).toHaveBeenCalled();
  });
});
