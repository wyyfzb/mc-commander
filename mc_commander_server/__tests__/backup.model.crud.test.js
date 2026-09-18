import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// BackupModel 持久层语义补测（真实 SQLite，backup.model.js 语义锁定）。
// 覆盖：CRUD 与默认值链 / 分页过滤 / _toCamel 时间归一 / resetStaleInProgress
// 卡死恢复（creating→failed / restoring→completed / 新鲜记录不动 / 实例过滤）/
// 聚合统计。SQL 白名单（file_path 不泄露）已由 security.backup.model.test.js
// 锁定，本文件聚焦行为语义。db 层用真实 SQLite 实例，仅替身 database.js
// 的连接管理（getDb 指向本文件创建的临时库），SQL 语义真实。

const TEST_DIR = path.join(os.tmpdir(), `mcs-backup-crud-${process.pid}-${Date.now()}`);

let db;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 与 database.js createTables 的 instances/backups 表结构一致
  // （镜像 DDL：database.js 每加一列这里要同步——漏了会以「no such column」的
  //   500 暴露，不会静默走偏）
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'manual',
      size INTEGER DEFAULT 0,
      status TEXT DEFAULT 'creating',
      file_path TEXT,
      world_name TEXT,
      source_archive_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
    )
  `);
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// 替身 database.js 的连接管理，SUT 的 SQL 全部落在真实库上
vi.mock('../db/database.js', () => ({
  getDb: () => db,
}));

const { BackupModel } = await import('../db/backup.model.js');

describe('BackupModel.create / findById 默认值链', () => {
  beforeAll(() => {
    db.prepare("INSERT INTO instances (id, name) VALUES ('s1', 'One')").run();
    db.prepare("INSERT INTO instances (id, name) VALUES ('s2', 'Two')").run();
  });

  it('create 缺省字段兜底（manual/creating/0）', () => {
    const b = BackupModel.create({ instanceId: 's1', name: 'b-default' });
    expect(b.id).toBeGreaterThan(0);
    expect(b.type).toBe('manual');
    expect(b.status).toBe('creating');
    expect(b.size).toBe(0);
    expect(b.description).toBeNull();
    expect(b.worldName).toBeNull();
  });

  it('create 显式全字段落库且 createdAt 归一为 ISO 带 Z', () => {
    const b = BackupModel.create({
      instanceId: 's1', name: 'b-full', description: 'nightly',
      type: 'scheduled', size: 12345, status: 'completed',
      filePath: '/data/backups/b-full', worldName: 'world',
    });
    expect(b.type).toBe('scheduled');
    expect(b.size).toBe(12345);
    expect(b.status).toBe('completed');
    expect(b.worldName).toBe('world');
    expect(b.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('findById 缺失返回 null', () => {
    expect(BackupModel.findById(999999)).toBeNull();
  });

  it('findByIdWithPath 返回含 file_path 的 snake_case 原始行（服务层专用）', () => {
    const created = BackupModel.create({ instanceId: 's1', name: 'b-path', filePath: '/data/backups/b-path' });
    const raw = BackupModel.findByIdWithPath(created.id);
    expect(raw.file_path).toBe('/data/backups/b-path');
    expect(raw.instance_id).toBe('s1');
    expect(raw.world_name).toBeNull();
  });
});

describe('BackupModel._toCamel 时间归一', () => {
  it('CURRENT_TIMESTAMP 格式补 Z 转 ISO；空值转 null；非标准格式原样返回', () => {
    const row = {
      id: 1, instance_id: 's1', name: 'n', description: null, type: 'manual',
      size: 0, status: 'creating', world_name: null,
      created_at: '2026-01-02 03:04:05', updated_at: '2026-01-02T03:04:05',
    };
    const camel = BackupModel._toCamel(row);
    expect(camel.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(camel.updatedAt).toBe('2026-01-02T03:04:05.000Z'); // 带 T 同样识别
  });

  it('空时间戳转 null，异常格式原样透传', () => {
    const row = {
      id: 2, instance_id: 's1', name: 'n', description: null, type: 'manual',
      size: 0, status: 'creating', world_name: null,
      created_at: null, updated_at: 'not-a-date',
    };
    const camel = BackupModel._toCamel(row);
    expect(camel.createdAt).toBeNull();
    expect(camel.updatedAt).toBe('not-a-date');
  });

  it('_toCamel(null) 返回 null', () => {
    expect(BackupModel._toCamel(null)).toBeNull();
  });
});

describe('BackupModel.findAll 分页与过滤', () => {
  beforeAll(() => {
    // 独立实例 s30 限定作用域，与其他 describe 的数据互不干扰
    db.prepare("INSERT INTO instances (id, name) VALUES ('s30', 'FindAll')").run();
    BackupModel.create({ instanceId: 's30', name: 'f1', status: 'completed', type: 'manual' });
    BackupModel.create({ instanceId: 's30', name: 'f2', status: 'creating', type: 'scheduled' });
    BackupModel.create({ instanceId: 's30', name: 'f3', status: 'completed', type: 'manual' });
  });

  it('同实例无附加过滤返回全部并按 id DESC + 分页元信息', () => {
    const r = BackupModel.findAll({ instanceId: 's30', page: 1, pageSize: 10 });
    expect(r.total).toBe(3);
    expect(r.backups.map((b) => b.name)).toEqual(['f3', 'f2', 'f1']);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(10);
  });

  it('按 instanceId + status 组合过滤', () => {
    const r = BackupModel.findAll({ instanceId: 's30', status: 'completed' });
    expect(r.total).toBe(2);
    expect(r.backups.every((b) => b.status === 'completed')).toBe(true);
  });

  it('按 type 过滤', () => {
    const r = BackupModel.findAll({ instanceId: 's30', type: 'scheduled' });
    expect(r.total).toBe(1);
    expect(r.backups[0].name).toBe('f2');
  });

  it('OFFSET 翻页取第二页', () => {
    const r = BackupModel.findAll({ instanceId: 's30', page: 2, pageSize: 2 });
    expect(r.total).toBe(3);
    expect(r.backups).toHaveLength(1);
    expect(r.backups[0].name).toBe('f1');
  });

  it('不存在的过滤组合返回空集', () => {
    const r = BackupModel.findAll({ instanceId: 'no-such' });
    expect(r.total).toBe(0);
    expect(r.backups).toEqual([]);
  });
});

describe('BackupModel.update', () => {
  it('字段映射更新并刷新 updated_at', () => {
    const b = BackupModel.create({ instanceId: 's1', name: 'u1' });
    const updated = BackupModel.update(b.id, {
      name: 'u1-renamed',
      description: 'd',
      status: 'completed',
      size: 999,
      filePath: '/data/backups/u1',
      worldName: 'world_nether',
    });
    expect(updated.name).toBe('u1-renamed');
    expect(updated.status).toBe('completed');
    expect(updated.size).toBe(999);
    expect(updated.worldName).toBe('world_nether');
  });

  it('空 data 不执行 UPDATE，返回当前行', () => {
    const b = BackupModel.create({ instanceId: 's1', name: 'u2' });
    const after = BackupModel.update(b.id, {});
    expect(after.name).toBe('u2');
    expect(after.status).toBe('creating');
  });

  it('更新缺失记录返回 null', () => {
    expect(BackupModel.update(999999, { name: 'x' })).toBeNull();
  });
});

describe('BackupModel.resetStaleInProgress 卡死恢复', () => {
  beforeAll(() => {
    db.prepare("INSERT INTO instances (id, name) VALUES ('s9', 'Stale')").run();
    // creating 陈旧（2020）→ failed
    const c = BackupModel.create({ instanceId: 's9', name: 'stale-creating', status: 'creating' });
    db.prepare("UPDATE backups SET updated_at = '2020-01-01T00:00:00' WHERE id = ?").run(c.id);
    // restoring 陈旧（2020）→ completed
    const r = BackupModel.create({ instanceId: 's9', name: 'stale-restoring', status: 'restoring' });
    db.prepare("UPDATE backups SET updated_at = '2020-01-01T00:00:00' WHERE id = ?").run(r.id);
    // creating 新鲜 → 不动
    BackupModel.create({ instanceId: 's9', name: 'fresh-creating', status: 'creating' });
    // completed 陈旧 → 不动（非进行中状态）
    const d = BackupModel.create({ instanceId: 's9', name: 'stale-completed', status: 'completed' });
    db.prepare("UPDATE backups SET updated_at = '2020-01-01T00:00:00' WHERE id = ?").run(d.id);
  });

  it('陈旧 creating→failed、restoring→completed，新鲜/终态不动，返回重置数', () => {
    const reset = BackupModel.resetStaleInProgress({ maxAgeMs: 60 * 60 * 1000 });
    expect(reset).toBeGreaterThanOrEqual(2);
    const byName = Object.fromEntries(
      db.prepare("SELECT name, status FROM backups WHERE instance_id = 's9'").all().map((r) => [r.name, r.status]),
    );
    expect(byName['stale-creating']).toBe('failed');
    expect(byName['stale-restoring']).toBe('completed');
    expect(byName['fresh-creating']).toBe('creating');
    expect(byName['stale-completed']).toBe('completed');
  });

  it('instanceId 过滤只重置目标实例', () => {
    // 新实例制造一条陈旧 creating；限制 instanceId 后只有它被重置
    db.prepare("INSERT INTO instances (id, name) VALUES ('s10', 'Ten')").run();
    const only = BackupModel.create({ instanceId: 's10', name: 'stale-only', status: 'creating' });
    db.prepare("UPDATE backups SET updated_at = '2020-01-01T00:00:00' WHERE id = ?").run(only.id);
    const reset = BackupModel.resetStaleInProgress({ maxAgeMs: 1000, instanceId: 's10' });
    expect(reset).toBe(1);
    expect(BackupModel.findById(only.id).status).toBe('failed');
    // s9 的新鲜 creating 依然不动
    const s9 = db.prepare("SELECT status FROM backups WHERE instance_id = 's9' AND name = 'fresh-creating'").get();
    expect(s9.status).toBe('creating');
  });

  it('updated_at 为 NULL 时回退 created_at 判断年龄', () => {
    db.prepare("INSERT INTO instances (id, name) VALUES ('s11', 'Eleven')").run();
    const b = BackupModel.create({ instanceId: 's11', name: 'null-updated', status: 'restoring' });
    db.prepare("UPDATE backups SET updated_at = NULL, created_at = '2020-01-01T00:00:00' WHERE id = ?").run(b.id);
    const reset = BackupModel.resetStaleInProgress({ maxAgeMs: 60 * 60 * 1000, instanceId: 's11' });
    expect(reset).toBe(1);
    // restoring 卡死恢复为 completed（备份文件本身未动）
    expect(BackupModel.findById(b.id).status).toBe('completed');
  });
});

describe('BackupModel.delete / 聚合统计', () => {
  beforeAll(() => {
    db.prepare("INSERT INTO instances (id, name) VALUES ('s20', 'Agg')").run();
    BackupModel.create({ instanceId: 's20', name: 'a1', status: 'completed', size: 100 });
    BackupModel.create({ instanceId: 's20', name: 'a2', status: 'completed', size: 250 });
  });

  it('delete 存在返回 true，缺失返回 false', () => {
    const b = BackupModel.create({ instanceId: 's20', name: 'a3' });
    expect(BackupModel.delete(b.id)).toBe(true);
    expect(BackupModel.delete(b.id)).toBe(false);
  });

  it('deleteByInstance 清空该实例全部记录，无记录返回 false', () => {
    expect(BackupModel.deleteByInstance('s20')).toBe(true);
    expect(BackupModel.deleteByInstance('s20')).toBe(false);
    expect(BackupModel.getBackupCount('s20')).toBe(0);
  });

  it('getLatestBackup 返回最新 completed 快照，无则 null', () => {
    expect(BackupModel.getLatestBackup('s20')).toBeNull();
    BackupModel.create({ instanceId: 's20', name: 'old', status: 'completed', size: 5 });
    const latest = BackupModel.create({ instanceId: 's20', name: 'newest', status: 'completed', size: 7 });
    expect(BackupModel.getLatestBackup('s20').name).toBe('newest');
    expect(latest.createdAt).toMatch(/Z$/);
  });

  it('getLatestBackup 排除非 completed 状态', () => {
    BackupModel.create({ instanceId: 's20', name: 'failed-latest', status: 'failed', size: 9 });
    expect(BackupModel.getLatestBackup('s20').name).toBe('newest');
  });

  it('getBackupCount 计数（含非 completed）', () => {
    expect(BackupModel.getBackupCount('s20')).toBe(3);
    expect(BackupModel.getBackupCount('no-such')).toBe(0);
  });

  it('getTotalSize 汇总 size，空实例 COALESCE 兜底 0', () => {
    // 该 describe 上下文内 s20 存活记录：old(5) + newest(7) + failed-latest(9)
    expect(BackupModel.getTotalSize('s20')).toBe(21);
    expect(BackupModel.getTotalSize('no-such')).toBe(0);
  });
});
