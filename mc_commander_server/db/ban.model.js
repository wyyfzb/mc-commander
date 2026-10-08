import { getDb } from './database.js';
import { toIsoUtc } from '../utils/db-time.js';

/**
 * 临时封禁记录模型（temp_bans 表）。
 *
 * 服务端自实现的时长效禁：执行原版 `ban`/`ban-ip` 立即封禁，
 * 记录到期时间，由 TaskScheduler 轮询到期记录自动执行 `pardon`/`pardon-ip`。
 *
 * **为什么 MSMP 之后仍然保留它**（曾评估「官方条目带 expires ⇒ 本表可退役」，结论是不行）：
 * ① 命令通道回退时原版 `ban` 不接受时长，**时长只能记在这里**（MSMP 不可用时唯一载体）；
 * ② 面板的封禁历史（含「提前解封」与「到期」的区分）取自本表；
 * ③ 审计表当不了替代品——它按 `AUDIT_LOG_RETENTION_DAYS`（默认 90 天）定期 prune，
 *    超长封禁会在到期前失去记录，清扫就再也解不开，玩家被永久挡在门外。
 * 官方条目那一侧只承担「有效期内把它挡在门外」，与本表的职责不重叠。
 */
export class BanModel {
  static _toCamel(row) {
    if (!row) return null;
    return {
      id: row.id,
      instanceId: row.instance_id,
      targetType: row.target_type,
      target: row.target,
      reason: row.reason,
      expiresAt: row.expires_at,
      isActive: !!row.is_active,
      // created_at 为无时区 UTC 串（expires_at 是 epoch 整数，无需转换）
      createdAt: toIsoUtc(row.created_at),
    };
  }

  static create(data) {
    const db = getDb();
    // 同一目标的新封禁会覆盖旧的未到期记录，避免到期时重复 pardon
    db.prepare(`
      UPDATE temp_bans SET is_active = 0
      WHERE instance_id = ? AND target_type = ? AND target = ? AND is_active = 1
    `).run(data.instanceId, data.targetType, data.target);

    const result = db
      .prepare(`
      INSERT INTO temp_bans (instance_id, target_type, target, reason, expires_at, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `)
      .run(data.instanceId, data.targetType, data.target, data.reason || null, data.expiresAt);
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM temp_bans WHERE id = ?').get(id);
    return row ? this._toCamel(row) : null;
  }

  /** 查询某实例所有生效中的临时封禁记录（含已过期的，供玩家列表展示剩余时间） */
  static findActiveByInstance(instanceId) {
    const db = getDb();
    const rows = db
      .prepare(`
      SELECT * FROM temp_bans
      WHERE instance_id = ? AND is_active = 1
      ORDER BY id DESC
    `)
      .all(instanceId);
    return rows.map((r) => this._toCamel(r));
  }

  /** 查询某实例全部临时封禁记录（含已解封/到期的历史，供封禁记录界面展示） */
  static findAllByInstance(instanceId) {
    const db = getDb();
    const rows = db
      .prepare(`
      SELECT * FROM temp_bans
      WHERE instance_id = ?
      ORDER BY is_active DESC, expires_at ASC, id DESC
    `)
      .all(instanceId);
    return rows.map((r) => this._toCamel(r));
  }

  /** 查询已到期且生效中的记录（定时器到期解封用） */
  static findExpiredActive(now = Date.now()) {
    const db = getDb();
    const rows = db
      .prepare(`
      SELECT * FROM temp_bans
      WHERE is_active = 1 AND expires_at <= ?
      ORDER BY id ASC
    `)
      .all(now);
    return rows.map((r) => this._toCamel(r));
  }

  static deactivate(id) {
    const db = getDb();
    db.prepare('UPDATE temp_bans SET is_active = 0 WHERE id = ?').run(id);
  }

  /** 解封玩家时同步清理其玩家型临时封禁记录（IP 型记录由到期或 IP 解封处理） */
  static deactivateByPlayer(instanceId, playerName) {
    const db = getDb();
    db.prepare(`
      UPDATE temp_bans SET is_active = 0
      WHERE instance_id = ? AND target_type = 'player' AND target = ? AND is_active = 1
    `).run(instanceId, playerName);
  }

  /** 解封 IP 时同步清理其 IP 型临时封禁记录，避免手动 pardon-ip 后残留生效记录 */
  static deactivateByIp(instanceId, ip) {
    const db = getDb();
    db.prepare(`
      UPDATE temp_bans SET is_active = 0
      WHERE instance_id = ? AND target_type = 'ip' AND target = ? AND is_active = 1
    `).run(instanceId, ip);
  }
}

export default BanModel;
