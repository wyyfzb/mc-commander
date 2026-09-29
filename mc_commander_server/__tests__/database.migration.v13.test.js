import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// 独立临时 dataDir：本文件模拟「存量 v12 库（backups 表无 source_archive_id）升级到 v13」
vi.mock('../config.js', async () => {
  const fsMod = await import('fs');
  const os = await import('os');
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mc-db-v13-'));
  return { default: { dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/database.js';

const dbPath = path.join(config.dataDir, 'mc_commander.db');

/** 存量 v12 库：backups 表为 v12 形态（无 source_archive_id、无 file_path 唯一索引），带两行真实数据 */
function buildLegacyV12Db() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('user_version = 12');
  raw.exec(`
    CREATE TABLE backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'manual',
      size INTEGER DEFAULT 0,
      status TEXT DEFAULT 'creating',
      file_path TEXT,
      world_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw
    .prepare(
      `INSERT INTO backups (instance_id, name, status, file_path, world_name, created_at, updated_at)
     VALUES ('paper-1a2b3c4d', '每日备份', 'completed', ?, 'world', '2026-01-01 00:00:00', '2026-01-01 00:05:00')`,
    )
    .run(path.join('backups', 'paper-1a2b3c4d', 'snap-a'));
  // 进行中记录：file_path 为空（唯一索引必须放行多行空路径）
  raw
    .prepare(
      `INSERT INTO backups (instance_id, name, status, file_path, world_name)
     VALUES ('paper-1a2b3c4d', '创建中', 'creating', NULL, 'world')`,
    )
    .run();
  raw.close();
}

function columnsOf(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

describe('数据库 v12→v13 迁移（存量库 + 存量行）', () => {
  let db;

  beforeAll(() => {
    buildLegacyV12Db();
    db = initDatabase();
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it('user_version 升到 15（v12→v13 连续）', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(15);
  });

  it('backups 表新增 source_archive_id 列（可空，存量行保持 NULL）', () => {
    expect(columnsOf(db, 'backups')).toContain('source_archive_id');
    const rows = db.prepare('SELECT id, source_archive_id FROM backups ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source_archive_id === null)).toBe(true);
  });

  it('存量行内容逐字节保留（迁移不动数据）', () => {
    const row = db
      .prepare('SELECT name, status, file_path, world_name FROM backups WHERE id = 1')
      .get();
    expect(row).toMatchObject({
      name: '每日备份',
      status: 'completed',
      file_path: path.join('backups', 'paper-1a2b3c4d', 'snap-a'),
      world_name: 'world',
    });
  });

  it('file_path 唯一索引：同一快照目录的第二条索引行被拒（并发挂载不再插重复行）', () => {
    const insert = db.prepare(
      `INSERT INTO backups (instance_id, name, status, file_path, world_name, source_archive_id)
       VALUES ('fabric-99999999', '挂载快照', 'completed', ?, 'world', 'paper-1a2b3c4d')`,
    );
    expect(() => insert.run(path.join('backups', 'paper-1a2b3c4d', 'snap-a'))).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('唯一索引是部分索引：file_path 为空的行可有多条（creating/失败记录不受约束）', () => {
    const count = db
      .prepare(
        `INSERT INTO backups (instance_id, name, status, file_path, world_name)
       VALUES ('fabric-99999999', '另一个创建中', 'creating', NULL, 'world')`,
      )
      .run();
    expect(count.changes).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM backups WHERE file_path IS NULL').get().c).toBe(2);
  });

  it('挂载标记可写入并可被服务层读出（source_archive_id 非空 = 跨实例挂载行）', () => {
    const filePath = path.join('backups', 'paper-1a2b3c4d', 'snap-b');
    db.prepare(
      `INSERT INTO backups (instance_id, name, status, file_path, world_name, source_archive_id)
       VALUES ('fabric-99999999', '挂载快照 B', 'completed', ?, 'world', 'paper-1a2b3c4d')`,
    ).run(filePath);
    const row = db
      .prepare('SELECT instance_id, source_archive_id FROM backups WHERE file_path = ?')
      .get(filePath);
    expect(row).toEqual({ instance_id: 'fabric-99999999', source_archive_id: 'paper-1a2b3c4d' });
  });
});
