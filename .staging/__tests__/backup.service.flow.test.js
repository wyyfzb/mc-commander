import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import config from '../config.js';

// ---------- 主流程集成测试：真实文件系统 + 真实快照命令 ----------
// 备份/恢复的核心数据安全逻辑（save 序列、实例级快照边界、恢复替换与
// 回滚、level.dat 校验）用临时目录 + 真实命令走完整流程：
//   Windows：robocopy（系统自带；服务代码 rsync ENOENT 自动降级）
//   Linux：rsync（--link-dest 硬链接增量；缺失时整体跳过）
// 命令参数构造的单元断言在 security.backup.test.js 覆盖，本文件断言
// 文件系统结果（快照目录内容/排除边界/恢复回滚）。
// mock DB 层（不触真实数据库），文件操作全部真实。

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

import { EventEmitter } from 'events';
import { BackupService } from '../services/backup.service.js';
import { BackupModel as MockBackupModel } from '../db/backup.model.js';

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// 探测快照工具可用性：Windows 必带 robocopy；Linux 需要 rsync
// （Ubuntu 24.04 默认未装，deploy 脚本负责安装——CI 缺失时整体跳过）
function hasCommand(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasRsync = hasCommand('rsync');
const snapshotTool = isWindows ? 'robocopy' : hasRsync ? 'rsync' : null;

// 等待事件（fire-and-forget 的备份/恢复流程以事件作为完成信号）
function waitForEvent(emitter, eventName, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs);
    emitter.on(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// 构造真实实例目录（实例级备份边界：世界/配置/插件/白名单应打包，
// 日志/依赖/jar 应排除；含旧版 Bukkit 顶层维度目录 world_nether）
function createTestInstance(serversDir, instanceId = 's1') {
  const dir = path.join(serversDir, instanceId);
  fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'world-data');
  fs.writeFileSync(path.join(dir, 'world', 'region', 'r.0.0.mca'), 'region-data');
  // 旧版 Bukkit 布局：Nether/End 为实例根目录顶层目录（26.1 前）
  fs.mkdirSync(path.join(dir, 'world_nether'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world_nether', 'level.dat'), 'nether-data');
  // 配置/插件/白名单
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(dir, 'whitelist.json'), '[]');
  fs.mkdirSync(path.join(dir, 'plugins', 'example'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'example', 'plugin.yml'), 'name: example\n');
  // 运行时产物（应排除）
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), 'log-data');
  fs.mkdirSync(path.join(dir, 'crash-reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'crash-reports', 'crash-1.txt'), 'crash');
  fs.mkdirSync(path.join(dir, 'libraries'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'libraries', 'dep.jar'), 'dep');
  fs.writeFileSync(path.join(dir, 'server.jar'), 'jar-data');
  fs.writeFileSync(path.join(dir, 'server.pid'), '12345');
  // JVM 崩溃日志（hs_err_pid<pid>.log，可重建运行时产物，应排除）
  fs.writeFileSync(path.join(dir, 'hs_err_pid999.log'), 'jvm-crash');
  return dir;
}

// 取该实例唯一的快照目录（备份目录下第一个子目录）
function getOnlySnapshot(backupsDir, instanceId) {
  const dir = path.join(backupsDir, instanceId);
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
  return names.length === 1 ? path.join(dir, names[0]) : null;
}

describe.skipIf(!snapshotTool)(
  `BackupService 主流程（真实文件系统 + ${snapshotTool}，${process.platform}）`,
  () => {
  let tmpRoot;
  let serversDir;
  let backupsDir;
  let manager;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-flow-'));
    serversDir = path.join(tmpRoot, 'servers');
    backupsDir = path.join(tmpRoot, 'backups');
    fs.mkdirSync(serversDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    config.serversDir = serversDir;
    config.backupsDir = backupsDir;

    manager = new EventEmitter();
    manager.getInstance = vi.fn(() => ({
      isRunning: false,
      isRconConnected: false,
      properties: { 'level-name': 'world' },
      jarFile: 'server.jar',
    }));

    vi.clearAllMocks();
    MockBackupModel.findAll.mockReturnValue({ total: 0, backups: [] });
    MockBackupModel.create.mockReturnValue({ id: 1, instanceId: 's1', name: 'Backup test' });
    MockBackupModel.update.mockImplementation((id, data) => ({ id, ...data }));
  });

  afterAll(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('createBackup 完整流程：实例级快照（排除日志/jar/pid/依赖，含旧版 Bukkit 维度与配置）', async () => {
    createTestInstance(serversDir);
    const service = new BackupService(manager);
    const completeEvent = waitForEvent(manager, 'instance:backupComplete');

    const record = await service.createBackup('s1', { name: '测试备份' });

    expect(record.id).toBe(1);
    // 记录创建为 creating + snapshot 格式（互斥状态机入口 + 快照格式契约）
    expect(MockBackupModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'creating', worldName: 'world', format: 'snapshot' })
    );

    const done = await completeEvent;
    const snapshotDir = getOnlySnapshot(backupsDir, 's1');
    expect(snapshotDir).not.toBeNull();
    // 快照 = 目录树（非压缩包），命名含用户名称与时间戳
    expect(path.basename(snapshotDir)).toMatch(/^测试备份-/);

    // 打包范围：世界（含旧版 Bukkit 维度）/配置/插件/白名单必须在内
    expect(fs.readFileSync(path.join(snapshotDir, 'world', 'level.dat'), 'utf8')).toBe('world-data');
    expect(fs.readFileSync(path.join(snapshotDir, 'world', 'region', 'r.0.0.mca'), 'utf8')).toBe('region-data');
    expect(fs.existsSync(path.join(snapshotDir, 'world_nether', 'level.dat'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'server.properties'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'whitelist.json'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'plugins', 'example', 'plugin.yml'))).toBe(true);
    // 排除：日志/崩溃报告/加载器依赖/jar/pid/JVM 崩溃日志
    expect(fs.existsSync(path.join(snapshotDir, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'crash-reports'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'libraries'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'server.jar'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'server.pid'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'hs_err_pid999.log'))).toBe(false);

    // 状态与事件：completed + size 已统计 + content 携带名称/大小
    expect(MockBackupModel.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'completed', size: expect.any(Number) })
    );
    expect(done.content).toContain('备份完成');
    expect(done.content).toContain('测试备份');
    expect(done.content).toContain('MB');
  });

  it('备份完成路径接线自动清理（cleanupOldBackups 被调用，保留策略来自配置）', async () => {
    createTestInstance(serversDir);
    const service = new BackupService(manager);
    const cleanupSpy = vi.spyOn(service, 'cleanupOldBackups').mockResolvedValue(2);
    const completeEvent = waitForEvent(manager, 'instance:backupComplete');

    await service.createBackup('s1', {});
    await completeEvent;

    expect(cleanupSpy).toHaveBeenCalledWith('s1', config.backupRetention);
  });

  it('快照失败：状态置 failed、半成品快照目录清理、backupFailed 携带失败原因', async () => {
    createTestInstance(serversDir);
    const service = new BackupService(manager);
    // 模拟快照已创建但完整性校验失败（空快照/无世界数据路径）
    vi.spyOn(service, '_verifySnapshot').mockRejectedValue(new Error('Snapshot has no level.dat'));
    const failedEvent = waitForEvent(manager, 'instance:backupFailed');

    await service.createBackup('s1', {});
    const failed = await failedEvent;

    expect(MockBackupModel.update).toHaveBeenCalledWith(1, { status: 'failed' });
    expect(failed.content).toContain('备份失败');
    expect(failed.content).toContain('level.dat');
    // 失败快照目录清理（不残留半成品）
    const snapshots = fs.readdirSync(path.join(backupsDir, 's1'));
    expect(snapshots).toEqual([]);
  });

  it('运行中 + RCON 不可用：拒绝在线备份（40902），不再静默直备运行中世界', async () => {
    createTestInstance(serversDir);
    manager.getInstance.mockReturnValue({
      isRunning: true,
      isRconConnected: false,
      properties: { 'level-name': 'world' },
      jarFile: 'server.jar',
    });
    const service = new BackupService(manager);

    await expect(service.createBackup('s1', {})).rejects.toMatchObject({ code: 40902 });
    expect(MockBackupModel.create).not.toHaveBeenCalled();
  });

  it('磁盘剩余空间不足：预检拒绝创建（磁盘满截断是世界损坏第一大诱因）', async () => {
    createTestInstance(serversDir);
    const service = new BackupService(manager);
    const statfsSpy = vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0, bsize: 4096 });
    try {
      await expect(service.createBackup('s1', {})).rejects.toThrow('磁盘剩余空间不足');
      expect(MockBackupModel.create).not.toHaveBeenCalled();
    } finally {
      statfsSpy.mockRestore();
    }
  });

  it('restoreBackup 完整流程：实例目录整体替换 + jar 复制回 + level.dat 校验 + 事件', async () => {
    createTestInstance(serversDir);
    // 先造一个真实快照（复用服务自身流程，保证快照结构与生产一致）
    const service = new BackupService(manager);
    const completeEvent = waitForEvent(manager, 'instance:backupComplete');
    await service.createBackup('s1', { name: '恢复源' });
    await completeEvent;
    const snapshotDir = getOnlySnapshot(backupsDir, 's1');

    // 篡改实例目录：模拟恢复前的最新状态（与快照不同）
    fs.writeFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'MUTATED');

    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'completed',
      world_name: 'world',
      name: '恢复源',
      format: 'snapshot',
      file_path: snapshotDir,
    });
    const restoreComplete = waitForEvent(manager, 'instance:restoreComplete');

    // 恢复入口同步段快速返回（路由可立即 202）
    const result = await service.restoreBackup(1);
    expect(result).toBe(true);
    // 互斥锁先置位：restoring（此后的创建/恢复/删除入口全部命中互斥）
    expect(MockBackupModel.update).toHaveBeenCalledWith(1, { status: 'restoring' });

    const done = await restoreComplete;
    // 恢复完成：世界数据回到快照时状态（level.dat 覆盖被篡改的值）
    expect(fs.readFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'utf8'))
      .toBe('world-data');
    // jar 复制回（快照排除 jar，恢复后实例仍可启动）
    expect(fs.existsSync(path.join(serversDir, 's1', 'server.jar'))).toBe(true);
    // 恢复为复制而非移动：快照链不受污染（快照内文件内容保持不变）
    expect(fs.readFileSync(path.join(snapshotDir, 'world', 'level.dat'), 'utf8')).toBe('world-data');
    // pre_restore 暂存目录清理
    const leftovers = fs.readdirSync(serversDir).filter((n) => n.includes('_pre_restore_'));
    expect(leftovers).toEqual([]);
    // 状态还原 completed（快照完好，可继续用于未来恢复）
    expect(MockBackupModel.update).toHaveBeenCalledWith(1, { status: 'completed' });
    expect(done.content).toContain('已恢复');
    expect(done.content).toContain('启动服务器');
  });

  it('恢复坏快照（无 level.dat）：预检拦截（不触碰原实例目录），原世界不丢', async () => {
    // 构造"内容为空/无世界数据"的坏快照目录（模拟世界被清空时创建的
    // 快照——旧实现解压 exit 0 即删 pre_restore，原世界不可逆丢失；
    // 快照方案在 rename 之前预检，原实例目录根本不被触碰）
    createTestInstance(serversDir);
    const badSnapshot = path.join(backupsDir, 's1', 'bad-snapshot');
    fs.mkdirSync(path.join(badSnapshot, 'world'), { recursive: true });
    fs.writeFileSync(path.join(badSnapshot, 'server.properties'), 'level-name=world\n');

    // 恢复目标实例当前是有世界的（模拟用户想恢复但快照坏了）
    fs.writeFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'CURRENT-WORLD');

    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 2,
      instance_id: 's1',
      status: 'completed',
      world_name: 'world',
      name: '坏快照',
      format: 'snapshot',
      file_path: badSnapshot,
    });
    const service = new BackupService(manager);
    const restoreFailed = waitForEvent(manager, 'instance:restoreFailed');

    await service.restoreBackup(2);
    const failed = await restoreFailed;

    expect(failed.content).toContain('level.dat');
    // 预检失败于 rename 之前：原世界完好保留（未经过任何替换）
    expect(fs.readFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'utf8')).toBe('CURRENT-WORLD');
    // 无 pre_restore 残留
    expect(fs.readdirSync(serversDir).filter((n) => n.includes('_pre_restore_'))).toEqual([]);
  });

  it('restoreBackup 拒绝恢复不存在的快照目录（同步段抛错，原实例不受影响）', async () => {
    createTestInstance(serversDir);
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 3,
      instance_id: 's1',
      status: 'completed',
      world_name: 'world',
      name: '幽灵快照',
      format: 'snapshot',
      file_path: path.join(backupsDir, 's1', 'ghost-snapshot'),
    });
    const service = new BackupService(manager);

    // 入口同步段校验失败即抛错（恢复从未开始，无 restoreFailed 事件，
    // HTTP 直接错误响应）——原实例目录不被触碰
    await expect(service.restoreBackup(3)).rejects.toThrow('Snapshot directory not found');
    expect(fs.readFileSync(path.join(serversDir, 's1', 'world', 'level.dat'), 'utf8')).toBe('world-data');
    expect(fs.readdirSync(serversDir).filter((n) => n.includes('_pre_restore_'))).toEqual([]);
  });

  it('cleanupOldBackups：按数量上限清理最旧备份（10 保留 15 删 5）', async () => {
    const service = new BackupService(manager);
    // createdAt 用相对今天（最近 15 天，均未超过 maxAgeDays=30）：
    // 只触发数量清理，隔离"数量上限"分支
    const backups = Array.from({ length: 15 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (14 - i));
      return { id: i + 1, createdAt: d.toISOString() };
    });
    MockBackupModel.findAll.mockReturnValue({ total: 15, backups });
    const deleteSpy = vi.spyOn(service, 'deleteBackup').mockResolvedValue(true);

    const deleted = await service.cleanupOldBackups('s1', { maxBackups: 10, maxAgeDays: 30 });

    expect(deleted).toBe(5);
    // 只删最旧的 5 条（id 1-5）
    const deletedIds = deleteSpy.mock.calls.map((c) => c[0]);
    expect(deletedIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('deleteBackup：删除快照目录（rm -rf 语义，目录整体移除）', async () => {
    createTestInstance(serversDir);
    const service = new BackupService(manager);
    const completeEvent = waitForEvent(manager, 'instance:backupComplete');
    await service.createBackup('s1', { name: '待删' });
    await completeEvent;
    const snapshotDir = getOnlySnapshot(backupsDir, 's1');
    expect(snapshotDir).not.toBeNull();

    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'completed',
      file_path: snapshotDir,
    });
    MockBackupModel.delete.mockReturnValue(true);

    await service.deleteBackup(1);
    // 快照目录整体删除（含全部文件与子目录）
    expect(fs.existsSync(snapshotDir)).toBe(false);
    expect(fs.readdirSync(path.join(backupsDir, 's1'))).toEqual([]);
  });
  },
  120000, // 快照复制/校验流程（robocopy/rsync 冷启动）
);

// Linux 专属：硬链接增量语义（rsync --link-dest 的真实行为验证）
describe.skipIf(!isLinux || !hasRsync)('硬链接增量（Linux rsync --link-dest）', () => {
  let tmpRoot;
  let serversDir;
  let backupsDir;
  let manager;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-link-'));
    serversDir = path.join(tmpRoot, 'servers');
    backupsDir = path.join(tmpRoot, 'backups');
    fs.mkdirSync(serversDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    config.serversDir = serversDir;
    config.backupsDir = backupsDir;

    manager = new EventEmitter();
    manager.getInstance = vi.fn(() => ({
      isRunning: false,
      isRconConnected: false,
      properties: { 'level-name': 'world' },
      jarFile: 'server.jar',
    }));

    vi.clearAllMocks();
    MockBackupModel.findAll.mockReturnValue({ total: 0, backups: [] });
    MockBackupModel.create.mockReturnValue({ id: 1, instanceId: 's1', name: 'Backup test' });
    MockBackupModel.update.mockImplementation((id, data) => ({ id, ...data }));
  });

  afterAll(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('二次备份：未变化文件硬链接共享 inode，变化文件新 inode（零拷贝增量）', async () => {
    createTestInstance(serversDir);
    const service = new BackupService(manager);

    // 第一次备份（全量）
    let done = waitForEvent(manager, 'instance:backupComplete');
    await service.createBackup('s1', { name: '快照一' });
    await done;
    const first = getOnlySnapshot(backupsDir, 's1');

    // 修改一个文件（模拟服务器运行产生新数据），其余保持不动
    fs.writeFileSync(path.join(serversDir, 's1', 'world', 'region', 'r.0.0.mca'), 'CHANGED');

    // 第二次备份（增量）
    done = waitForEvent(manager, 'instance:backupComplete');
    await service.createBackup('s1', { name: '快照二' });
    await done;
    const dir = path.join(backupsDir, 's1');
    const names = fs.readdirSync(dir)
      .filter((n) => fs.statSync(path.join(dir, n)).isDirectory())
      .sort();
    expect(names.length).toBe(2);
    const second = path.join(dir, names[1]);

    // 未变化文件（level.dat）：两快照共享同一 inode（硬链接）
    const a = fs.statSync(path.join(first, 'world', 'level.dat'));
    const b = fs.statSync(path.join(second, 'world', 'level.dat'));
    expect(a.ino).toBe(b.ino);
    expect(a.nlink).toBeGreaterThanOrEqual(2);

    // 变化文件（region）：新 inode（整文件复制）
    const ra = fs.statSync(path.join(first, 'world', 'region', 'r.0.0.mca'));
    const rb = fs.statSync(path.join(second, 'world', 'region', 'r.0.0.mca'));
    expect(ra.ino).not.toBe(rb.ino);
    expect(fs.readFileSync(path.join(second, 'world', 'region', 'r.0.0.mca'), 'utf8')).toBe('CHANGED');

    // 删除旧快照不影响新快照（硬链接引用计数）
    fs.rmSync(first, { recursive: true, force: true });
    expect(fs.readFileSync(path.join(second, 'world', 'level.dat'), 'utf8')).toBe('world-data');
  });
});
