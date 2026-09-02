import crypto from 'crypto';
import { getDb } from './database.js';

/**
 * 管理员账号 + 会话模型（安全主线：单管理员密码登录）
 *
 * - admin_account：单行表（id 恒为 1），存 scrypt 密码哈希；totp_secret 预留
 *   两步验证挂靠（roadmap：TOTP 挂靠于本主线）。
 * - admin_sessions：Bearer 会话，仅存令牌 SHA-256 摘要；滑动续期（每次认证
 *   触达刷新 expires_at）；「踢单设备」= 删除对应行。
 * - 时间统一 ISO UTC 字符串存储，SQLite 字符串比较对 ISO 天然有序。
 */

export class AdminAccountModel {
  /** 单行记录；未设密码返回 null */
  static get() {
    const row = getDb().prepare('SELECT * FROM admin_account WHERE id = 1').get();
    return row || null;
  }

  static isConfigured() {
    return Boolean(this.get()?.password_hash);
  }

  static setPassword(passwordHash) {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO admin_account (id, password_hash, updated_at)
         VALUES (1, ?, CURRENT_TIMESTAMP)`,
      )
      .run(passwordHash);
  }

  static setTotpSecret(secret) {
    // 预留：TOTP 两步验证挂靠点（roadmap 安全主线后续项）
    getDb()
      .prepare('UPDATE admin_account SET totp_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
      .run(secret);
  }
}

export class AdminSessionModel {
  /** 创建会话；tokenHash 由调用方以 sha256(明文令牌) 传入（明文不落库） */
  static create({ tokenHash, userAgent = null, ip = null, expiresAt }) {
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO admin_sessions (id, token_hash, user_agent, ip, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, tokenHash, userAgent, ip, expiresAt);
    return this.getById(id);
  }

  static getById(id) {
    return getDb().prepare('SELECT * FROM admin_sessions WHERE id = ?').get(id) || null;
  }

  static findByTokenHash(tokenHash) {
    return (
      getDb().prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(tokenHash) || null
    );
  }

  /** 滑动续期：刷新 last_seen_at 与 expires_at */
  static touch(id, expiresAt) {
    getDb()
      .prepare(
        `UPDATE admin_sessions
         SET last_seen_at = CURRENT_TIMESTAMP, expires_at = ?
         WHERE id = ?`,
      )
      .run(expiresAt, id);
  }

  static deleteById(id) {
    const res = getDb().prepare('DELETE FROM admin_sessions WHERE id = ?').run(id);
    return res.changes > 0;
  }

  /** 改密后踢单设备例外：踢掉除 keepId 外的全部会话 */
  static deleteAllExcept(keepId) {
    const res = getDb()
      .prepare('DELETE FROM admin_sessions WHERE id != ?')
      .run(keepId);
    return res.changes;
  }

  static deleteExpired() {
    const res = getDb()
      .prepare('DELETE FROM admin_sessions WHERE expires_at <= ?')
      .run(new Date().toISOString());
    return res.changes;
  }

  /**
   * 会话数上限收口（P2-11）：先惰性清理过期行，再按最近活跃排序保留前
   * maxSessions 条，其余删除（新登录挤掉最旧会话）。
   * 排序用 COALESCE(last_seen_at, created_at)：存量行两列均有默认值，
   * COALESCE 兼容未来可能引入的 NULL。
   * @param {number} maxSessions
   * @returns {number} 被挤掉的会话数
   */
  static enforceLimit(maxSessions) {
    this.deleteExpired();
    if (!maxSessions || maxSessions < 1) return 0;
    const rows = getDb()
      .prepare(
        `SELECT id FROM admin_sessions
         ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC`,
      )
      .all();
    if (rows.length <= maxSessions) return 0;
    const del = getDb().prepare('DELETE FROM admin_sessions WHERE id = ?');
    let evicted = 0;
    for (const row of rows.slice(maxSessions)) {
      evicted += del.run(row.id).changes;
    }
    return evicted;
  }

  /** 活跃会话列表（踢单设备 UI 数据源）；过期行先惰性清理 */
  static listActive() {
    this.deleteExpired();
    return getDb()
      .prepare(
        `SELECT id, user_agent, ip, created_at, last_seen_at, expires_at
         FROM admin_sessions
         WHERE expires_at > ?
         ORDER BY last_seen_at DESC`,
      )
      .all(new Date().toISOString());
  }
}
