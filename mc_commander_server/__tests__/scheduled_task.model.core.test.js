import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ScheduledTaskModel 持久层语义补测（issue #424，真实 SQLite）。
// 既有 scheduled_task.model.test.js 以 fakeDb 断言 SQL 形状（lastRunStatus
// 与执行历史收口），本文件补真实库语义：findAll 动态过滤与分页偏移、
// create 默认值链、update fieldMap 白名单（lastRunStatus 防篡改）、
// updateLastRun/updateLastRunStatus 的错误清空链路与历史落库行为。
// db 层用真实 SQLite 实例，仅替身 database.js 的连接管理（#421 范式）。

const TEST_DIR = path.join(os.tmpdir(), `mcs-scheduled-task-model-${process.pid}-${Date.now()}`);

let db;
let ScheduledTaskModel;
let TaskRunHistoryModel;

// 替身 database.js 的连接管理，SUT 的 SQL 全部落在真实库上
// （工厂惰性解引用：db 在 beforeAll 才赋值，get 第一次调用时已就绪）
vi.mock('../db/database.js', () => ({ getDb: () => db }));

beforeAll(async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 与 database.js createTables 精简一致：scheduled_tasks.task_history 仅
  // 被 TaskRunHistoryModel.record 触达（_recordHistory 依赖），三表同库
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      command TEXT,
      is_enabled INTEGER DEFAULT 1,
      last_run_at TEXT,
      last_run_status TEXT DEFAULT 'never',
      last_run_error TEXT,
      next_run_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_run_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      run_at TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    )
  `);

  // scheduled_tasks.instance_id 带 FK 约束，预置实例行（#416 教训）
  db.prepare('INSERT INTO instances (id, name) VALUES (?, ?)').run('s1', 'Instance 1');
  db.prepare('INSERT INTO instances (id, name) VALUES (?, ?)').run('s2', 'Instance 2');

  ({ ScheduledTaskModel } = await import('../db/scheduled_task.model.js'));
  ({ TaskRunHistoryModel } = await import('../db/task_run_history.model.js'));
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const baseTask = {
  instanceId: 's1',
  name: '每日重启',
  type: 'restart',
  cronExpression: '0 0 * * *',
};

beforeEach(() => {
  db.prepare('DELETE FROM task_run_history').run();
  db.prepare('DELETE FROM scheduled_tasks').run();
});

describe('ScheduledTaskModel - create 默认值链', () => {
  it('全字段：落库并返回 camelCase 行（isEnabled true、lastRunStatus never）', () => {
    const task = ScheduledTaskModel.create({ ...baseTask, command: 'say hi', isEnabled: true });

    expect(task.id).toBeGreaterThan(0);
    expect(task).toMatchObject({
      instanceId: 's1',
      name: '每日重启',
      type: 'restart',
      cronExpression: '0 0 * * *',
      command: 'say hi',
      isEnabled: true,
      lastRunStatus: 'never',
    });
    expect(task.createdAt).toBeTruthy();
    expect(task.updatedAt).toBeTruthy();
  });

  it('instanceId 缺省 → instance_id 落 NULL（FK 可空，全服任务）', () => {
    const task = ScheduledTaskModel.create({ name: 't', type: 'command', cronExpression: '* * * * *' });
    expect(task.instanceId).toBeNull();
  });

  it('command 缺省 → 落 NULL', () => {
    const task = ScheduledTaskModel.create({ ...baseTask });
    expect(task.command).toBeNull();
  });

  it('isEnabled 缺省 → 启用（is_enabled 1）；isEnabled=false → 停用', () => {
    const on = ScheduledTaskModel.create({ ...baseTask, name: 'on' });
    const off = ScheduledTaskModel.create({ ...baseTask, name: 'off', isEnabled: false });
    expect(on.isEnabled).toBe(true);
    expect(off.isEnabled).toBe(false);
  });
});

describe('ScheduledTaskModel - findAll 动态过滤与分页', () => {
  beforeEach(() => {
    ScheduledTaskModel.create({ ...baseTask, name: 'a', instanceId: 's1', type: 'restart', isEnabled: true });
    ScheduledTaskModel.create({ ...baseTask, name: 'b', instanceId: 's1', type: 'backup', isEnabled: false });
    ScheduledTaskModel.create({ ...baseTask, name: 'c', instanceId: 's2', type: 'restart', isEnabled: true });
    ScheduledTaskModel.create({ ...baseTask, name: 'd', instanceId: null, type: 'backup', isEnabled: false });
  });

  it('无过滤：全量 + total，按 id DESC 排序', () => {
    const r = ScheduledTaskModel.findAll();
    expect(r.total).toBe(4);
    expect(r.tasks.map(t => t.name)).toEqual(['d', 'c', 'b', 'a']);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
  });

  it('instanceId 过滤（全服任务 instanceId null 不命中非空过滤）', () => {
    const r = ScheduledTaskModel.findAll({ instanceId: 's1' });
    expect(r.total).toBe(2);
    expect(r.tasks.map(t => t.name).sort()).toEqual(['a', 'b']);
  });

  it('type 过滤', () => {
    const r = ScheduledTaskModel.findAll({ type: 'backup' });
    expect(r.total).toBe(2);
    expect(r.tasks.map(t => t.name).sort()).toEqual(['b', 'd']);
  });

  it('isEnabled=true / false 分支（boolean → 1/0 落 SQL）', () => {
    const enabled = ScheduledTaskModel.findAll({ isEnabled: true });
    const disabled = ScheduledTaskModel.findAll({ isEnabled: false });
    expect(enabled.total).toBe(2);
    expect(disabled.total).toBe(2);
    expect(enabled.tasks.every(t => t.isEnabled)).toBe(true);
    expect(disabled.tasks.every(t => !t.isEnabled)).toBe(true);
  });

  it('分页：page=2&pageSize=2 返回第二页 + total 不变', () => {
    const r = ScheduledTaskModel.findAll({ page: 2, pageSize: 2 });
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(2);
    expect(r.total).toBe(4);
    expect(r.tasks.map(t => t.name)).toEqual(['b', 'a']);
  });

  it('组合过滤：instanceId + type（AND 连接）', () => {
    const r = ScheduledTaskModel.findAll({ instanceId: 's1', type: 'backup' });
    expect(r.total).toBe(1);
    expect(r.tasks[0].name).toBe('b');
  });
});

describe('ScheduledTaskModel - findById 与 _toCamel', () => {
  it('命中返回 camelCase 全字段；未命中返回 null', () => {
    const created = ScheduledTaskModel.create({ ...baseTask, command: 'cmd' });
    const found = ScheduledTaskModel.findById(created.id);
    expect(found.cronExpression).toBe('0 0 * * *');
    expect(found.isEnabled).toBe(true);
    expect(ScheduledTaskModel.findById(99999)).toBeNull();
  });

  it('_toCamel(null) → null 防御；is_enabled 0 → false；status 缺省 never', () => {
    expect(ScheduledTaskModel._toCamel(null)).toBeNull();
    const camel = ScheduledTaskModel._toCamel({ id: 1, instance_id: null, name: 'n', type: 'restart', cron_expression: 'c', is_enabled: 0 });
    expect(camel.isEnabled).toBe(false);
    expect(camel.lastRunStatus).toBe('never');
    expect(camel.lastRunError).toBeNull();
    expect(camel.instanceId).toBeNull();
  });
});

describe('ScheduledTaskModel - update 白名单与布尔转换', () => {
  let taskId;
  beforeEach(() => {
    taskId = ScheduledTaskModel.create({ ...baseTask, name: 'orig', isEnabled: true }).id;
  });

  it('name/cronExpression/command 更新生效', () => {
    const updated = ScheduledTaskModel.update(taskId, {
      name: 'renamed',
      cronExpression: '30 1 * * *',
      command: 'new-cmd',
    });
    expect(updated.name).toBe('renamed');
    expect(updated.cronExpression).toBe('30 1 * * *');
    expect(updated.command).toBe('new-cmd');
  });

  it('isEnabled boolean → 0/1 落库（false 分支）', () => {
    expect(ScheduledTaskModel.update(taskId, { isEnabled: false }).isEnabled).toBe(false);
    expect(ScheduledTaskModel.update(taskId, { isEnabled: true }).isEnabled).toBe(true);
  });

  it('lastRunStatus/lastRunError 不在白名单：传入被忽略（防客户端篡改执行结果）', () => {
    const before = ScheduledTaskModel.findById(taskId);
    const updated = ScheduledTaskModel.update(taskId, { lastRunStatus: 'success', lastRunError: 'x' });
    expect(updated.lastRunStatus).toBe(before.lastRunStatus);
    expect(updated.lastRunError).toBe(before.lastRunError);
  });

  it('空 data（无白名单命中）→ 不执行 UPDATE，返回原行', () => {
    const before = ScheduledTaskModel.findById(taskId);
    const updated = ScheduledTaskModel.update(taskId, {});
    expect(updated).toMatchObject({ id: taskId, name: 'orig' });
    expect(updated.updatedAt).toBe(before.updatedAt);
  });

  it('lastRunAt/nextRunAt 可更新（调度器时间戳口径）', () => {
    const updated = ScheduledTaskModel.update(taskId, {
      lastRunAt: '2026-09-04T06:00:00.000Z',
      nextRunAt: '2026-09-04T07:00:00.000Z',
    });
    expect(updated.lastRunAt).toBe('2026-09-04T06:00:00.000Z');
    expect(updated.nextRunAt).toBe('2026-09-04T07:00:00.000Z');
  });
});

describe('ScheduledTaskModel - delete 与 getEnabledTasks', () => {
  it('delete：存在 → true 且行消失；不存在 → false', () => {
    const id = ScheduledTaskModel.create(baseTask).id;
    expect(ScheduledTaskModel.delete(id)).toBe(true);
    expect(ScheduledTaskModel.findById(id)).toBeNull();
    expect(ScheduledTaskModel.delete(id)).toBe(false);
  });

  it('getEnabledTasks 只返回启用任务（disabled 不出）', () => {
    ScheduledTaskModel.create({ ...baseTask, name: 'on', isEnabled: true });
    ScheduledTaskModel.create({ ...baseTask, name: 'off', isEnabled: false });
    const rows = ScheduledTaskModel.getEnabledTasks();
    expect(rows.map(t => t.name)).toEqual(['on']);
  });
});

describe('ScheduledTaskModel - updateLastRun 状态链与历史落库', () => {
  let taskId;
  beforeEach(() => {
    taskId = ScheduledTaskModel.create({ ...baseTask, name: 't' }).id;
  });

  it('带 status=success：last_run_at 刷新、next_run_at 写入、错误清空、历史落 1 条（runAt=last_run_at）', () => {
    ScheduledTaskModel.update(taskId, { lastRunError: 'stale' });
    ScheduledTaskModel.updateLastRun(taskId, '2026-09-04T08:00:00.000Z', 'success');

    const row = ScheduledTaskModel.findById(taskId);
    expect(row.lastRunAt).toBeTruthy();
    expect(row.nextRunAt).toBe('2026-09-04T08:00:00.000Z');
    expect(row.lastRunStatus).toBe('success');
    expect(row.lastRunError).toBeNull();

    const history = TaskRunHistoryModel.findByTask(taskId);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('success');
    expect(history[0].error).toBeNull();
    expect(history[0].runAt).toBe(row.lastRunAt);
  });

  it('status=failed + error + durationMs：错误文案入库，历史完整落', () => {
    ScheduledTaskModel.updateLastRun(taskId, '2026-09-04T08:00:00.000Z', 'failed', 'EULA 未接受', 120);

    const row = ScheduledTaskModel.findById(taskId);
    expect(row.lastRunStatus).toBe('failed');
    expect(row.lastRunError).toBe('EULA 未接受');

    const history = TaskRunHistoryModel.findByTask(taskId);
    expect(history[0].status).toBe('failed');
    expect(history[0].error).toBe('EULA 未接受');
    expect(history[0].durationMs).toBe(120);
  });

  it('status=skipped 且无 error：清空上次错误（success/skipped 同一清空分支）', () => {
    ScheduledTaskModel.update(taskId, { lastRunError: 'old' });
    ScheduledTaskModel.updateLastRun(taskId, '2026-09-04T08:00:00.000Z', 'skipped');
    expect(ScheduledTaskModel.findById(taskId).lastRunError).toBeNull();
  });

  it('不带 status（异步触发占位）：刷新时间但不写状态、不落历史', () => {
    ScheduledTaskModel.updateLastRun(taskId, '2026-09-04T09:00:00.000Z');
    const row = ScheduledTaskModel.findById(taskId);
    expect(row.lastRunStatus).toBe('never');
    expect(row.nextRunAt).toBe('2026-09-04T09:00:00.000Z');
    expect(TaskRunHistoryModel.findByTask(taskId)).toHaveLength(0);
  });

  it('历史写入异常仅告警：主更新不反噬（catch 分支真实触达）', () => {
    const spy = vi.spyOn(TaskRunHistoryModel, 'record').mockImplementation(() => {
      throw new Error('history boom');
    });
    expect(() =>
      ScheduledTaskModel.updateLastRun(taskId, '2026-09-04T08:00:00.000Z', 'success')
    ).not.toThrow();
    // 主更新已生效（异常发生在 history 段，不影响 UPDATE 已提交）
    expect(ScheduledTaskModel.findById(taskId).lastRunStatus).toBe('success');
    spy.mockRestore();
  });
});

describe('ScheduledTaskModel - updateLastRunStatus 异步回填', () => {
  let taskId;
  beforeEach(() => {
    taskId = ScheduledTaskModel.create({ ...baseTask, name: 't' }).id;
    ScheduledTaskModel.update(taskId, { lastRunAt: '2026-09-04T06:00:00.000Z' });
  });

  it('仅写状态不刷新 last_run_at（触发时刻口径保持）+ 历史落库', () => {
    ScheduledTaskModel.updateLastRunStatus(taskId, 'failed', 'RCON 不可用', 3000);

    const row = ScheduledTaskModel.findById(taskId);
    expect(row.lastRunAt).toBe('2026-09-04T06:00:00.000Z');
    expect(row.lastRunStatus).toBe('failed');
    expect(row.lastRunError).toBe('RCON 不可用');

    const history = TaskRunHistoryModel.findByTask(taskId);
    expect(history).toHaveLength(1);
    expect(history[0].durationMs).toBe(3000);
  });

  it('success 回填（error 缺省 null）：清空旧错误', () => {
    ScheduledTaskModel.update(taskId, { lastRunError: 'stale' });
    ScheduledTaskModel.updateLastRunStatus(taskId, 'success');
    const row = ScheduledTaskModel.findById(taskId);
    expect(row.lastRunStatus).toBe('success');
    expect(row.lastRunError).toBeNull();
    expect(TaskRunHistoryModel.findByTask(taskId)).toHaveLength(1);
  });
});
