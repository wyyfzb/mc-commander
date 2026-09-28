import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// 独立临时 dataDir：本文件模拟「存量 v3 库升级到 v5」，需避开其它迁移测试的目录
vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-db-v3tov5-'));
  return { default: { dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/database.js';

describe('数据库 v3→v5 升级迁移（存量库 + 存量行）', () => {
  const dbPath = path.join(config.dataDir, 'mc_commander.db');
  let db;

  beforeAll(() => {
    // 手工构造 v3 库：scheduled_tasks 无 last_run_status 列 + 存量行 + user_version=3
    fs.mkdirSync(config.dataDir, { recursive: true });
    const raw = new Database(dbPath);
    raw.pragma('user_version = 3');
    raw.exec(`
      CREATE TABLE scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        command TEXT,
        is_enabled INTEGER DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    raw
      .prepare(
        "INSERT INTO scheduled_tasks (name, type, cron_expression, last_run_at) VALUES ('存量任务', 'backup', '0 3 * * *', '2026-08-01 00:00:00')",
      )
      .run();
    raw.close();

    // 触发迁移（createTables 的 v5 块 ALTER 加列，存量行由 DEFAULT 'never' 回填）
    db = initDatabase();
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it('user_version 升到 14（v3 起经 v5→…→v12→v13 连续）', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(14);
  });

  it('存量行 last_run_status 回填 never（ALTER 默认值）', () => {
    const row = db
      .prepare("SELECT last_run_status FROM scheduled_tasks WHERE name = '存量任务'")
      .get();
    expect(row.last_run_status).toBe('never');
  });

  it('新建 backups 表不含 format 列', () => {
    const columns = db
      .prepare('PRAGMA table_info(backups)')
      .all()
      .map((c) => c.name);
    expect(columns).not.toContain('format');
    expect(columns).toContain('file_path');
    expect(columns).toContain('world_name');
  });
});
