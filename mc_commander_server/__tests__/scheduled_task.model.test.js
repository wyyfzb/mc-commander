import { describe, it, expect, vi, beforeEach } from 'vitest';

// 仅 mock database 模块（不 mock scheduled_task.model.js 本身），捕获
// prepare 收到的 SQL 与参数做断言，不触真实 DB / 不写入任何真实数据。
// prepareLog 与执行序对齐：prepare 时记录 {sql}，run 时回填 params。
const { fakeDb, prepareLog } = vi.hoisted(() => {
  const prepareLog = [];
  const fakeDb = {
    prepare: vi.fn((sql) => {
      const entry = { sql, params: undefined };
      prepareLog.push(entry);
      return {
        all: () => [],
        get: () => ({ count: 0 }),
        run: (...params) => {
          entry.params = params;
          return { lastInsertRowid: 1, changes: 1 };
        },
      };
    }),
  };
  return { fakeDb, prepareLog };
});
vi.mock('../db/database.js', () => ({ getDb: () => fakeDb }));

import { ScheduledTaskModel } from '../db/scheduled_task.model.js';

const findSqlIndex = (fragment) =>
  prepareLog.reduce((acc, e, i) => (e.sql.includes(fragment) ? i : acc), -1);

describe('ScheduledTaskModel - lastRunStatus', () => {
  beforeEach(() => {
    prepareLog.length = 0;
  });

  it('_toCamel 映射 last_run_status → lastRunStatus，缺省回退 never', () => {
    expect(ScheduledTaskModel._toCamel({ last_run_status: 'failed' }).lastRunStatus).toBe('failed');
    expect(ScheduledTaskModel._toCamel({}).lastRunStatus).toBe('never');
  });

  it('updateLastRun 传 status 时一并 SET last_run_status', () => {
    ScheduledTaskModel.updateLastRun(1, '2026-08-16T00:00:00Z', 'success');

    const i = findSqlIndex('UPDATE scheduled_tasks');
    expect(prepareLog[i].sql).toContain('last_run_status = ?');
    expect(prepareLog[i].params).toEqual(['2026-08-16T00:00:00Z', 'success', 1]);
  });

  it('updateLastRun 不传 status 时不写 last_run_status（兼容旧调用）', () => {
    ScheduledTaskModel.updateLastRun(2, '2026-08-16T00:00:00Z');

    const i = findSqlIndex('UPDATE scheduled_tasks');
    expect(prepareLog[i].sql).not.toContain('last_run_status');
  });

  it('updateLastRunStatus 仅更新 last_run_status，不刷新 last_run_at', () => {
    ScheduledTaskModel.updateLastRunStatus(3, 'skipped');

    const i = findSqlIndex('UPDATE scheduled_tasks');
    expect(prepareLog[i].sql).toContain('last_run_status = ?');
    expect(prepareLog[i].sql).not.toContain('last_run_at');
  });
});

describe('ScheduledTaskModel - 执行历史单点收口（issue #299）', () => {
  beforeEach(() => {
    prepareLog.length = 0;
  });

  it('updateLastRun 带 status → 追加 INSERT task_run_history（success 不带 error）', () => {
    ScheduledTaskModel.updateLastRun(11, '2026-08-16T00:00:00Z', 'success');

    const i = findSqlIndex('INSERT INTO task_run_history');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(prepareLog[i].params[0]).toBe(11);
    expect(prepareLog[i].params[2]).toBe('success');
    expect(prepareLog[i].params[3]).toBeNull();
  });

  it('updateLastRun 带 status=failed → error 文案完整入历史', () => {
    ScheduledTaskModel.updateLastRun(12, '2026-08-16T00:00:00Z', 'failed', 'EULA 未接受', 120);

    const i = findSqlIndex('INSERT INTO task_run_history');
    expect(prepareLog[i].params[2]).toBe('failed');
    expect(prepareLog[i].params[3]).toBe('EULA 未接受');
    expect(prepareLog[i].params[4]).toBe(120);
  });

  it('updateLastRun 不带 status（异步触发占位）→ 不落历史', () => {
    ScheduledTaskModel.updateLastRun(13, '2026-08-16T00:00:00Z');

    expect(findSqlIndex('INSERT INTO task_run_history')).toBe(-1);
  });

  it('updateLastRunStatus（异步结果回填）→ 追加执行历史', () => {
    ScheduledTaskModel.updateLastRunStatus(14, 'failed', 'RCON 不可用', 3000);

    const i = findSqlIndex('INSERT INTO task_run_history');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(prepareLog[i].params[0]).toBe(14);
    expect(prepareLog[i].params[2]).toBe('failed');
    expect(prepareLog[i].params[3]).toBe('RCON 不可用');
    expect(prepareLog[i].params[4]).toBe(3000);
  });

  it('历史写入失败仅告警，不反噬主更新流程', () => {
    // INSERT 注入异常：验证 updateLastRun 不向外抛（历史缺失不阻断调度）
    const origPrepare = fakeDb.prepare;
    fakeDb.prepare = vi.fn((sql) => {
      if (sql.includes('INSERT INTO task_run_history')) {
        throw new Error('history insert boom');
      }
      return origPrepare(sql);
    });

    expect(() =>
      ScheduledTaskModel.updateLastRun(15, '2026-08-16T00:00:00Z', 'success')
    ).not.toThrow();

    fakeDb.prepare = origPrepare;
  });
});
