import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';

// 将 dataDir 指向临时目录，避免迁移初始化读写真实 data/ 目录
vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-db-v5-migration-'));
  return { default: { dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/database.js';

describe('数据库 v5 迁移 - scheduled_tasks.last_run_status', () => {
  let db;

  beforeAll(() => {
    db = initDatabase();
  });

  afterAll(() => {
    db.close();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it('user_version 升到 15（v5→v6→…→v12→v13 连续）', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(15);
  });

  it('v10：task_run_history 表存在且随任务级联删除', () => {
    const info = db
      .prepare(
        "INSERT INTO scheduled_tasks (name, type, cron_expression) VALUES ('历史任务', 'command', '0 3 * * *')",
      )
      .run();
    db.prepare(
      "INSERT INTO task_run_history (task_id, status, error, duration_ms) VALUES (?, 'failed', 'boom', 100)",
    ).run(info.lastInsertRowid);
    expect(db.prepare('SELECT COUNT(*) AS c FROM task_run_history').get().c).toBe(1);

    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(info.lastInsertRowid);
    expect(db.prepare('SELECT COUNT(*) AS c FROM task_run_history').get().c).toBe(0);
  });

  it('新插入任务 last_run_status 默认 never', () => {
    db.prepare(
      "INSERT INTO scheduled_tasks (name, type, cron_expression) VALUES ('测试任务', 'command', '0 3 * * *')",
    ).run();
    const row = db
      .prepare('SELECT last_run_status FROM scheduled_tasks ORDER BY id DESC LIMIT 1')
      .get();
    expect(row.last_run_status).toBe('never');
  });
});
