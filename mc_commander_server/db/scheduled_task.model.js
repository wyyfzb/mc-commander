import { getDb } from './database.js';
import { TaskRunHistoryModel } from './task_run_history.model.js';

export class ScheduledTaskModel {
  static findAll(options = {}) {
    const db = getDb();
    const { page = 1, pageSize = 20, instanceId, type, isEnabled } = options;

    let where = [];
    let params = [];

    if (instanceId) {
      where.push('instance_id = ?');
      params.push(instanceId);
    }

    if (type) {
      where.push('type = ?');
      params.push(type);
    }

    if (isEnabled !== undefined) {
      where.push('is_enabled = ?');
      params.push(isEnabled ? 1 : 0);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const tasks = db.prepare(`
      SELECT * FROM scheduled_tasks
      ${whereClause}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM scheduled_tasks ${whereClause}
    `).get(...params).count;

    return { tasks: tasks.map(r => this._toCamel(r)), total, page, pageSize };
  }

  static findById(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
    return row ? this._toCamel(row) : null;
  }

  /** 将 DB 的 snake_case 行映射为前端/调度器期望的 camelCase 对象 */
  static _toCamel(row) {
    if (!row) return null;
    return {
      id: row.id,
      instanceId: row.instance_id,
      name: row.name,
      type: row.type,
      cronExpression: row.cron_expression,
      command: row.command,
      isEnabled: !!row.is_enabled,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status ?? 'never',
      lastRunError: row.last_run_error ?? null,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  static create(data) {
    const db = getDb();

    const result = db.prepare(`
      INSERT INTO scheduled_tasks (
        instance_id, name, type, cron_expression, command,
        is_enabled
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      data.instanceId || null,
      data.name,
      data.type,
      data.cronExpression,
      data.command || null,
      data.isEnabled !== false ? 1 : 0
    );

    return this.findById(result.lastInsertRowid);
  }

  static update(id, data) {
    const db = getDb();
    const updates = [];
    const params = [];

    // lastRunStatus 故意不在此映射：状态只由调度器经 updateLastRun/
    // updateLastRunStatus 写，PUT 通用更新不透传（防客户端篡改执行结果）
    const fieldMap = {
      name: 'name',
      type: 'type',
      cronExpression: 'cron_expression',
      command: 'command',
      isEnabled: 'is_enabled',
      lastRunAt: 'last_run_at',
      nextRunAt: 'next_run_at'
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        updates.push(`${column} = ?`);
        params.push(typeof data[key] === 'boolean' ? (data[key] ? 1 : 0) : data[key]);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);

      db.prepare(`
        UPDATE scheduled_tasks SET ${updates.join(', ')} WHERE id = ?
      `).run(...params);
    }

    return this.findById(id);
  }

  static delete(id) {
    const db = getDb();
    const result = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  static getEnabledTasks() {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM scheduled_tasks WHERE is_enabled = 1
    `).all();
    return rows.map(r => this._toCamel(r));
  }

  static updateLastRun(id, nextRunAt, status, error = null, durationMs = null) {
    const db = getDb();
    // status 可选：异步任务触发时先落时间戳，结果稍后由 updateLastRunStatus 回填
    // error 可选：失败原因文本，与 status='failed' 配合使用
    const clauses = ['last_run_at = CURRENT_TIMESTAMP', 'next_run_at = ?'];
    const params = [nextRunAt || null];
    if (status !== undefined) {
      clauses.push('last_run_status = ?');
      params.push(status);
    }
    if (error !== null) {
      clauses.push('last_run_error = ?');
      params.push(error);
    } else if (status === 'success' || status === 'skipped') {
      // 成功/跳过时清空上次错误
      clauses.push('last_run_error = NULL');
    }
    clauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    db.prepare(`
      UPDATE scheduled_tasks SET ${clauses.join(', ')} WHERE id = ?
    `).run(...params);

    // 带 status 的调用是真实执行结果：同步追加执行历史（单点收口，
    // 覆盖调度器所有执行路径；无 status 的触发调用不算结果不落历史）。
    // run_at 取刚写入的 last_run_at（触发时刻口径，与列表页一致）
    if (status !== undefined) {
      this._recordHistory(id, status, error, durationMs);
    }
  }

  /** 异步结果回填：仅写状态不刷新 last_run_at（时间戳已在触发时落库） */
  static updateLastRunStatus(id, status, error = null, durationMs = null) {
    const db = getDb();
    const clauses = ['last_run_status = ?'];
    const params = [status];
    if (error !== null) {
      clauses.push('last_run_error = ?');
      params.push(error);
    } else if (status === 'success' || status === 'skipped') {
      clauses.push('last_run_error = NULL');
    }
    clauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    db.prepare(
      `UPDATE scheduled_tasks SET ${clauses.join(', ')} WHERE id = ?`
    ).run(...params);

    // 异步结果同样是真实执行结果：追加历史，run_at 取触发时已落的 last_run_at
    this._recordHistory(id, status, error, durationMs);
  }

  /** 执行历史追加（失败仅告警不反噬主流程：历史缺失不应阻断任务调度） */
  static _recordHistory(taskId, status, error, durationMs) {
    try {
      const db = getDb();
      const row = db.prepare(
        'SELECT last_run_at FROM scheduled_tasks WHERE id = ?'
      ).get(taskId);
      TaskRunHistoryModel.record({
        taskId,
        status,
        error,
        durationMs,
        runAt: row?.last_run_at ?? null,
      });
    } catch (err) {
      console.warn(`[TaskRunHistory] record failed for task ${taskId}:`, err.message);
    }
  }
}

export default ScheduledTaskModel;
