import { describe, it, expect, vi } from 'vitest';

// find-021：backup.model 显式列查询，file_path 不出现在对外查询结果中。
// 仅 mock database 模块（不 mock backup.model.js 本身），捕获 prepare
// 收到的 SQL 做断言，不触真实 DB / 不写入任何真实数据。
const { fakeDb, sqlLog } = vi.hoisted(() => {
  const sqlLog = [];
  const fakeDb = {
    prepare: vi.fn((sql) => {
      sqlLog.push(sql);
      return {
        all: () => [],
        get: () => ({ count: 0 }),
        run: () => ({ lastInsertRowid: 1, changes: 1 }),
      };
    }),
  };
  return { fakeDb, sqlLog };
});
vi.mock('../db/database.js', () => ({ getDb: () => fakeDb }));

import { BackupModel } from '../db/backup.model.js';

describe('find-021: backup.model 显式列查询，不泄露 file_path', () => {
  it('findAll 主查询不含 file_path 与 SELECT *', () => {
    BackupModel.findAll({});
    const sql = sqlLog.find((s) => s.includes('ORDER BY id DESC'));
    expect(sql).not.toContain('file_path');
    expect(sql).not.toContain('SELECT *');
    expect(sql).toContain('world_name');
    expect(sql).toContain('created_at');
  });

  it('findById 显式列查询，不含 file_path（含 format 列契约）', () => {
    BackupModel.findById(1);
    const sql = sqlLog.find((s) => s.includes('WHERE id = ?'));
    expect(sql).not.toContain('file_path');
    expect(sql).not.toContain('SELECT *');
    // 快照/zip 格式契约列对外可见（前端据此区分旧格式备份）
    expect(sql).toContain('format');
  });

  it('getLatestBackup 显式列查询，不含 file_path', () => {
    BackupModel.getLatestBackup('s1');
    const sql = sqlLog.find((s) => s.includes("status = 'completed'"));
    expect(sql).not.toContain('file_path');
    expect(sql).not.toContain('SELECT *');
  });

  it('findByIdWithPath 服务层专用查询为完整行（SELECT *）', () => {
    BackupModel.findByIdWithPath(1);
    const sql = sqlLog.find((s) => s.includes('SELECT * FROM backups'));
    expect(sql).toMatch(/SELECT \* FROM backups/);
  });
});
