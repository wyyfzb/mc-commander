import { describe, it, expect, vi, afterAll, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// config 指向临时目录：restoreBackup 会校验实例目录存在性，
// 真实 ./servers 在开发机可能有残留（测试通过）而 CI 全新检出没有（测试失败）
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsp = (await import('fs')).default;
  const osp = (await import('os')).default;
  const p = (await import('path')).default;
  const root = fsp.mkdtempSync(p.join(osp.tmpdir(), 'backup-cfg-'));
  return {
    default: {
      ...actual.default,
      serversDir: p.join(root, 'servers'),
      backupsDir: p.join(root, 'backups'),
    },
  };
});

import config from '../config.js';

// ---------- 服务层 mock（不触真实 DB / 不写入任何真实数据） ----------
vi.mock('../db/backup.model.js', () => ({
  BackupModel: {
    findAll: vi.fn(() => ({ total: 0 })),
    create: vi.fn(),
    update: vi.fn(),
    findByIdWithPath: vi.fn(),
    delete: vi.fn(() => true),
    resetStaleInProgress: vi.fn(),
  },
}));

import { EventEmitter } from 'events';
import {
  BackupService,
  resolveContained,
  buildRsyncArgs,
  buildRobocopyArgs,
} from '../services/backup.service.js';
import { BackupModel as MockBackupModel } from '../db/backup.model.js';

describe('resolveContained 路径包含校验（收敛到 fs-utils 解析面后的错误形态翻译层）', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-resolve-'));
  const base = path.join(tmpBase, 'base');
  fs.mkdirSync(base);

  it('合法目标路径通过并返回归一化路径', () => {
    const result = resolveContained(base, path.join(base, 'world'));
    expect(result).toBe(path.join(base, 'world'));
  });

  it('../ 越界目标抛 PATH_TRAVERSAL_DETECTED', () => {
    expect(() => resolveContained(base, path.join(base, '..', 'evil')))
      .toThrowError(/escapes instance root/);
  });

  it('绝对路径逃逸抛 PATH_TRAVERSAL_DETECTED', () => {
    expect(() => resolveContained(base, path.join(tmpBase, 'outside')))
      .toThrowError(/escapes instance root/);
  });

  it('目标等于 base 本身被拒绝（相等排除）', () => {
    expect(() => resolveContained(base, base)).toThrowError(/resolves to instance root/);
  });

  it('前缀陷阱（/base-evil 非 /base 子路径）被拒绝', () => {
    const evil = path.join(tmpBase, 'base-evil');
    fs.mkdirSync(evil);
    try {
      expect(() => resolveContained(base, evil)).toThrowError(/escapes instance root/);
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });

  it('symlink 指向 base 外时被拒绝（realpath 复检，无法创建链接时跳过）', () => {
    const outside = path.join(tmpBase, 'outside');
    fs.mkdirSync(outside);
    let linkCreated = true;
    try {
      fs.symlinkSync(outside, path.join(base, 'world'), 'junction');
    } catch {
      linkCreated = false;
    }
    if (linkCreated) {
      expect(() => resolveContained(base, path.join(base, 'world')))
        .toThrowError(/via symlink/);
    }
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('基座目录不存在时容忍（存在性由后续业务步骤判定，不在此报 ENOENT）', () => {
    const missing = path.join(tmpBase, 'no-such-base');
    expect(resolveContained(missing, path.join(missing, 'world')))
      .toBe(path.join(missing, 'world'));
  });

  afterAll(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
});

describe('createBackup 对 worldName 强制校验', () => {
  it('显式传入 ../ 恶意 worldName 拒绝创建（白名单）', async () => {
    const service = new BackupService(null);
    await expect(
      service.createBackup('s1', { worldName: '../../etc' })
    ).rejects.toThrow('Invalid world name');
  });

  it('显式传入反斜杠穿越 worldName 拒绝创建（白名单）', async () => {
    const service = new BackupService(null);
    await expect(
      service.createBackup('s1', { worldName: '..\\..\\evil' })
    ).rejects.toThrow('Invalid world name');
  });

  it('实例 properties 中的恶意 level-name 同样被拒绝', async () => {
    const manager = new EventEmitter();
    manager.getInstance = vi.fn(() => ({ properties: { 'level-name': '../evil' } }));
    const service = new BackupService(manager);
    await expect(service.createBackup('s1', {})).rejects.toThrow('Invalid world name');
  });

  it('恶意 worldName 同步抛错路径也发 backupFailed 事件', async () => {
    const manager = new EventEmitter();
    manager.getInstance = vi.fn(() => null);
    const failedEvents = [];
    manager.on('instance:backupFailed', (d) => failedEvents.push(d));
    const service = new BackupService(manager);
    await expect(service.createBackup('s1', { worldName: '../evil' })).rejects.toThrow();
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].phase).toBe('setup');
  });

  it('合法 worldName 不误拒（目录不存在时走原有 World directory not found 路径）', async () => {
    const service = new BackupService(null);
    await expect(
      service.createBackup('nonexistent-instance', { name: 'x', worldName: 'world' })
    ).rejects.toThrow('World directory not found');
  });
});

describe('restoreBackup 路径与状态校验（实例级恢复）', () => {
  // restoreBackup 先校验实例目录存在性：统一预置 s1 实例目录
  beforeAll(() => {
    fs.mkdirSync(path.join(config.serversDir, 's1'), { recursive: true });
  });

  it('file_path 越界（DB 被篡改）拒绝恢复', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'completed',
      world_name: 'world',
      file_path: 'D:/evil/outside',
    });
    const service = new BackupService(null);
    await expect(service.restoreBackup(1)).rejects.toThrow('escapes instance root');
  });

  it('file_path 指向另一个实例的合法快照 → 拒绝（归属校验，防跨实例灌数据）', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'completed',
      world_name: 'world',
      file_path: path.join(config.backupsDir, 's2', 'other-instance-snapshot'),
    });
    const service = new BackupService(null);
    // 只校验「在 backupsDir 内」会放行这条记录：恢复会把 s2 的世界数据灌进 s1
    await expect(service.restoreBackup(1)).rejects.toThrow('escapes instance root');
  });

  it('file_path 在备份目录内但快照目录不存在时报原错误', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'completed',
      world_name: 'world',
      file_path: path.join(config.backupsDir, 's1', 'nonexistent-snapshot'),
    });
    const service = new BackupService(null);
    await expect(service.restoreBackup(1)).rejects.toThrow('Snapshot directory not found');
  });

  it('未完成备份仍拒绝恢复（状态检查不受影响）', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'creating',
      world_name: 'world',
      file_path: null,
    });
    const service = new BackupService(null);
    await expect(service.restoreBackup(1)).rejects.toThrow('Only completed backups can be restored');
  });

  it('同实例已有恢复进行中（restoring）时拒绝新的恢复', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'completed',
      world_name: 'world',
      file_path: path.join(config.backupsDir, 's1', 'ok-snapshot'),
    });
    // 服务层互斥兜底：findAll 命中另一条 restoring 记录
    MockBackupModel.findAll.mockReturnValueOnce({ total: 0 }); // creating
    MockBackupModel.findAll.mockReturnValueOnce({ total: 1 }); // restoring
    const service = new BackupService(null);
    await expect(service.restoreBackup(1)).rejects.toThrow('Restore already in progress');
  });

  it('实例运行中拒绝恢复', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'completed',
      world_name: 'world',
      file_path: path.join(config.backupsDir, 's1', 'ok-snapshot'),
    });
    const manager = new EventEmitter();
    manager.getInstance = vi.fn(() => ({ isRunning: true, jarFile: null }));
    const service = new BackupService(manager);
    await expect(service.restoreBackup(1)).rejects.toThrow('请先停止服务器');
  });
});

describe('deleteBackup 对 file_path 校验（异步化）', () => {
  let tmpRoot;
  let backupsDir;
  let serversDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-del-guard-'));
    backupsDir = path.join(tmpRoot, 'backups');
    serversDir = path.join(tmpRoot, 'servers');
    fs.mkdirSync(backupsDir, { recursive: true });
    fs.mkdirSync(serversDir, { recursive: true });
    config.backupsDir = backupsDir;
    config.serversDir = serversDir;
  });
  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('file_path 越界（DB 被篡改）拒绝删除', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      file_path: 'D:/evil/outside',
    });
    const service = new BackupService(null);
    // deleteBackup 为异步（rm 大目录不阻塞事件循环），同步 throw 改为
    // Promise rejection
    await expect(service.deleteBackup(1)).rejects.toThrowError(/escapes instance root/);
  });

  it('实例 id 缺失的异常记录：拒绝删除并给明确错误（不是裸 TypeError）', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      file_path: path.join(backupsDir, 's1', 'snap'),
    });
    const service = new BackupService(null);
    await expect(service.deleteBackup(1)).rejects.toThrowError(/Path traversal detected/);
  });

  it('常规行指向另一个实例的快照 → 拒绝删除（记录被篡改不得 rm -rf 别人的副本）', async () => {
    const victimDir = path.join(backupsDir, 'paper-1a2b3c4d', 'snap');
    fs.mkdirSync(path.join(victimDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(victimDir, 'world', 'level.dat'), 'other-instance-world');
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'completed',
      file_path: victimDir,
      source_archive_id: null,
    });
    const service = new BackupService(null);
    await expect(service.deleteBackup(1)).rejects.toThrowError(/escapes instance root/);
    // 别人的快照原样保留
    expect(fs.existsSync(path.join(victimDir, 'world', 'level.dat'))).toBe(true);
    expect(MockBackupModel.delete).not.toHaveBeenCalled();
  });

  it('挂载行删除照常放行（基准放宽到它声明的归档目录）', async () => {
    const archivedSnap = path.join(backupsDir, 'paper-1a2b3c4d', 'snap');
    fs.mkdirSync(path.join(archivedSnap, 'world'), { recursive: true });
    fs.writeFileSync(path.join(archivedSnap, 'world', 'level.dat'), 'archived');
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 'fabric-99999999',
      status: 'completed',
      file_path: archivedSnap,
      source_archive_id: 'paper-1a2b3c4d',
    });
    const service = new BackupService(null);
    await expect(service.deleteBackup(1)).resolves.toBe(true);
    expect(fs.existsSync(archivedSnap)).toBe(false);
    expect(MockBackupModel.delete).toHaveBeenCalledWith(1);
  });

  it('恢复中（restoring）的备份拒绝删除（互斥状态机）', async () => {
    MockBackupModel.findByIdWithPath.mockReturnValue({
      id: 1,
      instance_id: 's1',
      status: 'restoring',
      file_path: path.join(config.backupsDir, 's1', 'ok-snapshot'),
    });
    const service = new BackupService(null);
    // 删除与恢复可并发竞争快照目录（恢复已开始读取时目录被删）
    await expect(service.deleteBackup(1)).rejects.toThrow('in progress');
  });
});

describe('命令参数构造（目录快照：rsync --link-dest / robocopy /MIR）', () => {
  it('rsync 参数：排除日志/依赖目录与 jar/pid（快照不备份运行时产物）', () => {
    const args = buildRsyncArgs('s1', 'C:/backups/s1/snap-1', {
      linkDest: 'C:/backups/s1/snap-0',
      jarFile: 'server.jar',
    });
    expect(args[0]).toBe('-a');
    expect(args).toContain('--link-dest=C:/backups/s1/snap-0');
    // 排除清单：目录名任意层级匹配（尾 / 表示匹配目录）
    expect(args).toContain('--exclude=logs/');
    expect(args).toContain('--exclude=crash-reports/');
    expect(args).toContain('--exclude=libraries/');
    expect(args).toContain('--exclude=versions/');
    expect(args).toContain('--exclude=cache/');
    expect(args).toContain('--exclude=backups/');
    expect(args).toContain('--exclude=server.jar');
    expect(args).toContain('--exclude=*.pid');
    expect(args).toContain('--exclude=*.lock');
    expect(args).toContain('--exclude=hs_err_pid*.log');
    // 源尾带 / 复制目录内容（目标直接成为实例镜像）
    expect(args).toContain('s1/');
    // 快照模式严禁 --delete（仅恢复覆盖场景使用）
    expect(args).not.toContain('--delete');
  });

  it('rsync 参数：未配置 linkDest（首次全量）时不含 --link-dest；未配置 jarFile 时不排除 jar', () => {
    const args = buildRsyncArgs('s1', 'C:/backups/s1/snap-1');
    expect(args.some((a) => a.startsWith('--link-dest='))).toBe(false);
    expect(args.join(' ')).not.toContain('--exclude=server.jar');
  });

  it('robocopy 参数：/MIR 镜像 + 排除清单 + 收紧重试（降级路径）', () => {
    const args = buildRobocopyArgs('s1', 'C:/backups/s1/snap-1', { jarFile: 'server.jar' });
    // 源 = 实例目录绝对路径、目标 = 快照目录绝对路径
    expect(args[0]).toBe(path.join(config.serversDir, 's1'));
    expect(args[1]).toBe('C:/backups/s1/snap-1');
    expect(args).toContain('/MIR');
    expect(args).toContain('/E');
    expect(args).toContain('/MT:16');
    // 显式收紧重试（默认 /R:1000000 /W:30 坏文件会卡数天）
    expect(args).toContain('/R:2');
    expect(args).toContain('/W:5');
    // /XD 目录排除清单
    const xdIdx = args.indexOf('/XD');
    expect(xdIdx).toBeGreaterThan(-1);
    for (const dir of ['logs', 'crash-reports', 'libraries', 'versions', 'cache', 'backups']) {
      expect(args.slice(xdIdx + 1, args.indexOf('/XF'))).toContain(dir);
    }
    // /XF 文件排除（jar + pid/lock + JVM 崩溃日志）
    const xfIdx = args.indexOf('/XF');
    expect(args.slice(xfIdx + 1)).toEqual(
      expect.arrayContaining(['server.jar', '*.pid', '*.lock', 'hs_err_pid*.log'])
    );
  });

  it('robocopy 参数：未配置 jarFile 时 /XF 仅 pid/lock/hs_err', () => {
    const args = buildRobocopyArgs('s1', 'C:/backups/s1/snap-1');
    const xfIdx = args.indexOf('/XF');
    expect(args.slice(xfIdx + 1)).toEqual(['*.pid', '*.lock', 'hs_err_pid*.log']);
  });
});
