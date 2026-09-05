import { describe, it, expect, vi, beforeEach } from 'vitest';

// 仅 mock database 模块（不 mock task_run_history.model.js 本身），捕获
// prepare 收到的 SQL 与参数做断言，不触真实 DB / 不写入任何真实数据。
// prepareLog 与执行序对齐：prepare 时记录 {sql}，run/all 时回填结果。
const { fakeDb, prepareLog, setRows } = vi.hoisted(() => {
  const prepareLog = [];
  let rows = [];
  const fakeDb = {
    prepare: vi.fn((sql) => {
      const entry = { sql, params: undefined };
      prepareLog.push(entry);
      return {
        all: (...args) => { entry.params = args; return rows; },
        get: () => ({ count: 0 }),
        run: (...params) => {
          entry.params = params;
          return { lastInsertRowid: 1, changes: 1 };
        },
      };
    }),
  };
  return { fakeDb, prepareLog, setRows: (r) => { rows = r; } };
});
vi.mock('../db/database.js', () => ({ getDb: () => fakeDb }));

import { TaskRunHistoryModel } from '../db/task_run_history.model.js';

const findSqlIndex = (fragment) =>
  prepareLog.reduce((acc, e, i) => (e.sql.includes(fragment) ? i : acc), -1);

describe('TaskRunHistoryModel（issue #299）', () => {
  beforeEach(() => {
    prepareLog.length = 0;
    setRows([]);
  });

  it('_toCamel 映射 snake_case 行，缺省 error/durationMs 回退 null', () => {
    expect(TaskRunHistoryModel._toCamel({
      id: 1, task_id: 9, run_at: '2026-09-02 12:00:00',
      status: 'failed', error: 'boom', duration_ms: 1500,
    })).toEqual({
      id: 1, taskId: 9, runAt: '2026-09-02 12:00:00',
      status: 'failed', error: 'boom', durationMs: 1500,
    });
    expect(TaskRunHistoryModel._toCamel({
      id: 2, task_id: 9, run_at: '2026-09-02 12:05:00', status: 'success',
    }).durationMs).toBeNull();
  });

  it('record 插入触发时刻与结果字段，error/durationMs 可空', () => {
    TaskRunHistoryModel.record({
      taskId: 9, status: 'success', error: null, durationMs: 800,
      runAt: '2026-09-02 12:00:00',
    });

    const i = findSqlIndex('INSERT INTO task_run_history');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(prepareLog[i].params).toEqual([9, '2026-09-02 12:00:00', 'success', null, 800]);
  });

  it('record runAt 缺省时传 null（SQL COALESCE 回退 CURRENT_TIMESTAMP）', () => {
    TaskRunHistoryModel.record({ taskId: 9, status: 'failed', error: 'boom' });

    const i = findSqlIndex('INSERT INTO task_run_history');
    expect(prepareLog[i].params[1]).toBeNull();
    expect(prepareLog[i].params[3]).toBe('boom');
  });

  it('record 后执行保留策略裁剪：仅保留每任务最近 N 条', () => {
    TaskRunHistoryModel.record({ taskId: 9, status: 'success' });

    const i = findSqlIndex('DELETE FROM task_run_history');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(prepareLog[i].sql).toContain('ORDER BY id DESC LIMIT ?');
    // 参数：task_id（WHERE）、task_id（子查询）、保留条数（20~50 区间）
    const retention = prepareLog[i].params[2];
    expect(retention).toBeGreaterThanOrEqual(20);
    expect(retention).toBeLessThanOrEqual(50);
    expect(prepareLog[i].params[0]).toBe(9);
    expect(prepareLog[i].params[1]).toBe(9);
  });

  it('findByTask 倒序返回（ORDER BY id DESC）并映射 camelCase', () => {
    setRows([
      { id: 2, task_id: 9, run_at: '2026-09-02 12:05:00', status: 'success', error: null, duration_ms: 900 },
      { id: 1, task_id: 9, run_at: '2026-09-02 12:00:00', status: 'failed', error: 'boom', duration_ms: 1500 },
    ]);

    const runs = TaskRunHistoryModel.findByTask(9, 20);

    const i = findSqlIndex('SELECT * FROM task_run_history');
    expect(prepareLog[i].sql).toContain('ORDER BY id DESC');
    expect(prepareLog[i].params).toEqual([9, 20]);
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe('success');
    expect(runs[1].status).toBe('failed');
  });
});
