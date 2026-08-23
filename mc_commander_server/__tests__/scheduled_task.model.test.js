import { describe, it, expect, vi } from 'vitest';

// 仅 mock database 模块（不 mock scheduled_task.model.js 本身），捕获
// prepare 收到的 SQL 与参数做断言，不触真实 DB / 不写入任何真实数据
const { fakeDb, sqlLog, paramLog } = vi.hoisted(() => {
  const sqlLog = [];
  const paramLog = [];
  const fakeDb = {
    prepare: vi.fn((sql) => {
      sqlLog.push(sql);
      return {
        all: () => [],
        get: () => ({ count: 0 }),
        run: (...params) => {
          paramLog.push(params);
          return { lastInsertRowid: 1, changes: 1 };
        },
      };
    }),
  };
  return { fakeDb, sqlLog, paramLog };
});
vi.mock('../db/database.js', () => ({ getDb: () => fakeDb }));

import { ScheduledTaskModel } from '../db/scheduled_task.model.js';

describe('ScheduledTaskModel - lastRunStatus', () => {
  it('_toCamel 映射 last_run_status → lastRunStatus，缺省回退 never', () => {
    expect(ScheduledTaskModel._toCamel({ last_run_status: 'failed' }).lastRunStatus).toBe('failed');
    expect(ScheduledTaskModel._toCamel({}).lastRunStatus).toBe('never');
  });

  it('updateLastRun 传 status 时一并 SET last_run_status', () => {
    ScheduledTaskModel.updateLastRun(1, '2026-08-16T00:00:00Z', 'success');

    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).toContain('last_run_status = ?');
    expect(paramLog[paramLog.length - 1]).toEqual(['2026-08-16T00:00:00Z', 'success', 1]);
  });

  it('updateLastRun 不传 status 时不写 last_run_status（兼容旧调用）', () => {
    ScheduledTaskModel.updateLastRun(2, '2026-08-16T00:00:00Z');

    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).not.toContain('last_run_status');
  });

  it('updateLastRunStatus 仅更新 last_run_status，不刷新 last_run_at', () => {
    ScheduledTaskModel.updateLastRunStatus(3, 'skipped');

    const sql = sqlLog[sqlLog.length - 1];
    expect(sql).toContain('last_run_status = ?');
    expect(sql).not.toContain('last_run_at');
  });
});
