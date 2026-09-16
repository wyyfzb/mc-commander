import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 孤儿快照清扫 + 备份清单清点（真实文件系统 + 系统临时目录）
//
// 只替身 DB 读取（InstanceModel.getById）：清扫的删除动作、保守期与命名形态
// 判定全部走真实 fs，工作区的 backups/ 与 servers/ 全程零参与。

vi.mock('../db/index.js', () => ({
  InstanceModel: { getById: vi.fn(() => null) },
}));

import { listInstanceSnapshotDirs, pruneOrphanBackupDirs } from '../services/backup-snapshot.service.js';
import { InstanceModel } from '../db/index.js';
import config from '../config.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-orphan-backup-'));
const SERVERS_DIR = path.join(TMP_ROOT, 'servers');
const BACKUPS_DIR = path.join(TMP_ROOT, 'backups');

const ORIGINAL = { serversDir: config.serversDir, backupsDir: config.backupsDir };
config.serversDir = SERVERS_DIR;
config.backupsDir = BACKUPS_DIR;

const DAY = 24 * 60 * 60 * 1000;
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const age = (p, days) => {
  const t = (Date.now() - days * DAY) / 1000;
  fs.utimesSync(p, t, t);
};

afterAll(() => {
  Object.assign(config, ORIGINAL);
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('listInstanceSnapshotDirs · 备份清单清点', () => {
  beforeEach(() => {
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    mk(BACKUPS_DIR);
  });

  it('目录不存在/不可读 → 空清单（不抛 ENOENT）', () => {
    expect(listInstanceSnapshotDirs('paper-1a2b3c4d')).toEqual([]);
    // 同名文件而非目录（ENOTDIR）同样视为空清单
    fs.writeFileSync(path.join(BACKUPS_DIR, 'paper-deadbeef'), 'not-a-dir');
    expect(listInstanceSnapshotDirs('paper-deadbeef')).toEqual([]);
  });

  it('只计快照目录（散落文件不算），按修改时间倒序（最近在前）', () => {
    const dir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    mk(path.join(dir, '旧快照'));
    mk(path.join(dir, '新快照'));
    age(path.join(dir, '旧快照'), 10);
    fs.writeFileSync(path.join(dir, 'README.txt'), 'x');

    expect(listInstanceSnapshotDirs('paper-1a2b3c4d')).toEqual(['新快照', '旧快照']);
  });
});

describe('pruneOrphanBackupDirs · 全局孤儿快照清扫', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    InstanceModel.getById.mockReturnValue(null);
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    fs.rmSync(SERVERS_DIR, { recursive: true, force: true });
    mk(BACKUPS_DIR);
    mk(SERVERS_DIR);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('孤儿目录且早于保守期 → 删除（目录与其内容一并清理）', () => {
    const dir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    mk(path.join(dir, 'snap-1'));
    fs.writeFileSync(path.join(dir, 'snap-1', 'level.dat'), 'x');
    age(dir, 40);

    expect(pruneOrphanBackupDirs(30)).toEqual({ deleted: 1, failed: 0 });
    expect(fs.existsSync(dir)).toBe(false);
    // backupsDir 本身绝不在射程内
    expect(fs.existsSync(BACKUPS_DIR)).toBe(true);
  });

  it('孤儿目录但在保守期内（刚卸载又重建同 id）→ 保留', () => {
    const dir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    mk(path.join(dir, 'snap-1'));
    age(dir, 1);

    expect(pruneOrphanBackupDirs(30)).toEqual({ deleted: 0, failed: 0 });
    expect(fs.existsSync(path.join(dir, 'snap-1'))).toBe(true);
  });

  it('DB 仍有该实例记录 → 保留（无论多旧）', () => {
    const dir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    mk(path.join(dir, 'snap-1'));
    age(dir, 400);
    InstanceModel.getById.mockImplementation((id) => (id === 'paper-1a2b3c4d' ? { id } : null));

    expect(pruneOrphanBackupDirs(30)).toEqual({ deleted: 0, failed: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('实例目录仍在 serversDir（DB 已无记录）→ 保留', () => {
    const dir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    mk(path.join(dir, 'snap-1'));
    age(dir, 400);
    mk(path.join(SERVERS_DIR, 'paper-1a2b3c4d'));

    expect(pruneOrphanBackupDirs(30)).toEqual({ deleted: 0, failed: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('DB 读取异常 → 保守不删', () => {
    const dir = path.join(BACKUPS_DIR, 'paper-1a2b3c4d');
    mk(path.join(dir, 'snap-1'));
    age(dir, 400);
    InstanceModel.getById.mockImplementation(() => {
      throw new Error('db down');
    });

    expect(pruneOrphanBackupDirs(30)).toEqual({ deleted: 0, failed: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('非实例 id 形态的目录（面板快照命名空间 panel/ 与人工目录）永不进入射程', () => {
    const keep = ['panel', 'my-backup', 'backup_2026', 'paper-1A2B3C4D', '备份目录'];
    for (const name of keep) {
      const dir = path.join(BACKUPS_DIR, name);
      mk(path.join(dir, 'inner'));
      age(dir, 400);
    }

    expect(pruneOrphanBackupDirs(30)).toEqual({ deleted: 0, failed: 0 });
    for (const name of keep) expect(fs.existsSync(path.join(BACKUPS_DIR, name))).toBe(true);
  });

  it('backupsDir 不存在 → 视为无可清扫对象（非失败）', () => {
    fs.rmSync(BACKUPS_DIR, { recursive: true, force: true });
    expect(pruneOrphanBackupDirs(30)).toEqual({ deleted: 0, failed: 0 });
  });

  it('单目录清理失败不中断整轮：failed 计数 + 其余目录继续清理', () => {
    const bad = path.join(BACKUPS_DIR, 'paper-00000000');
    const good = path.join(BACKUPS_DIR, 'paper-11111111');
    mk(path.join(bad, 'snap'));
    mk(path.join(good, 'snap'));
    age(bad, 40);
    age(good, 40);
    const realRmSync = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((p, opts) => {
      if (p === bad) throw new Error('EPERM');
      return realRmSync(p, opts);
    });

    expect(pruneOrphanBackupDirs(30)).toEqual({ deleted: 1, failed: 1 });
    expect(fs.existsSync(good)).toBe(false);
    expect(fs.existsSync(bad)).toBe(true);
  });
});
