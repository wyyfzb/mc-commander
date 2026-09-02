import { getDb } from './database.js';

/**
 * 定时任务执行历史模型（task_run_history 表，append-only）。
 *
 * 行数上界由保留策略保证：每任务仅保留最近 RUN_RETENTION_PER_TASK 条，
 * 记录路径在同一同步调用内完成「插入 + 裁剪」，无需后台清理任务。
 */
const RUN_RETENTION_PER_TASK = 50;

export class TaskRunHistoryModel {
  /**
   * 记录一次执行结果（success/failed/skipped）并按保留策略裁剪。
   * runAt 为触发时刻（调度器 last_run_at 口径）；缺省回退当前时间。
   * durationMs：命令/备份等可测时长路径传实际毫秒，触发型结果传 null。
   */
  static record({ taskId, status, error = null, durationMs = null, runAt = null }) {
    const db = getDb();
    db.prepare(`
      INSERT INTO task_run_history (task_id, run_at, status, error, duration_ms)
      VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?)
    `).run(taskId, runAt, status, error, durationMs);
    // 保留策略：仅保留每任务最近 N 条（id 单调递增即时间序）
    db.prepare(`
      DELETE FROM task_run_history
      WHERE task_id = ? AND id NOT IN (
        SELECT id FROM task_run_history WHERE task_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(taskId, taskId, RUN_RETENTION_PER_TASK);
  }

  /** 某任务的最近执行记录，倒序（最新在前） */
  static findByTask(taskId, limit = 20) {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM task_run_history
      WHERE task_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(taskId, limit);
    return rows.map(r => this._toCamel(r));
  }

  static _toCamel(row) {
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      runAt: row.run_at,
      status: row.status,
      error: row.error ?? null,
      durationMs: row.duration_ms ?? null,
    };
  }
}

export default TaskRunHistoryModel;
