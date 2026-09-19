import { getDb } from './index.js';

/**
 * 分钟级主机指标历史（metrics_history 表，metrics 采样器每 60s 写一行）。
 * 与 notification_events 的「广播伴生落库」不同，这是纯观测数据面：
 * 只有采样器与 GET /api/v1/metrics 两个访问方。
 */
export const MetricsModel = {
  /** 写入一条分钟样本（时间戳由 DB CURRENT_TIMESTAMP 生成，UTC「YYYY-MM-DD HH:MM:SS」） */
  record({ cpuUsage, memoryUsedGb, memoryTotalGb, memoryPercent, playersOnline }) {
    const db = getDb();
    db.prepare(
      `INSERT INTO metrics_history (cpu_usage, memory_used_gb, memory_total_gb, memory_percent, players_online)
       VALUES (?, ?, ?, ?, ?)`
    ).run(cpuUsage, memoryUsedGb, memoryTotalGb, memoryPercent, playersOnline);
  },

  /** 查询最近 hours 小时内的样本（时间升序，供时序消费方直接绘图） */
  list(hours = 24) {
    const db = getDb();
    return db
      .prepare(
        `SELECT captured_at, cpu_usage, memory_used_gb, memory_total_gb, memory_percent, players_online
         FROM metrics_history
         WHERE captured_at >= datetime('now', ?)
         ORDER BY captured_at ASC`
      )
      .all(`-${Math.max(1, Math.min(hours, 72))} hours`)
      .map((row) => ({
        capturedAt: row.captured_at,
        cpuUsage: row.cpu_usage,
        memoryUsedGb: row.memory_used_gb,
        memoryTotalGb: row.memory_total_gb,
        memoryPercent: row.memory_percent,
        playersOnline: row.players_online,
      }));
  },

  /** 删除保留期外的样本（采样器每日调用一次）；返回删除行数 */
  deleteOlderThan(hours = 24) {
    const db = getDb();
    const result = db
      .prepare(`DELETE FROM metrics_history WHERE captured_at < datetime('now', ?)`)
      .run(`-${hours} hours`);
    return result.changes;
  },
};
