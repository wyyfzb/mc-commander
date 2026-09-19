import crypto from 'crypto';
import { getDb } from './database.js';
import { hashRecoveryCode } from '../utils/recovery-codes.js';

/**
 * 管理员账号 + 会话模型（安全主线：单管理员密码登录）
 *
 * - admin_account：单行表（id 恒为 1），存 scrypt 密码哈希与 TOTP 两因素状态。
 *   全部写入都是**窄列 UPDATE**：整行覆盖（INSERT OR REPLACE）会静默清掉未列出
 *   的列（曾导致升级后首次登录把 totp_secret 抹掉），新方法一律不得引入该形态。
 * - admin_recovery_codes：一次性恢复码，只存 SHA-256 摘要。
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
    // REPLACE 冲突时先删后插，未列出的 totp_secret/created_at 会被清空/重置，故必须 upsert
    getDb()
      .prepare(
        `INSERT INTO admin_account (id, password_hash, updated_at)
         VALUES (1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           password_hash = excluded.password_hash,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(passwordHash);
  }

  static setTotpSecret(secret) {
    getDb()
      .prepare(
        'UPDATE admin_account SET totp_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      )
      .run(secret);
  }

  /**
   * TOTP 状态快照（status 接口与登录第二因子判定的唯一读取点）。
   * enabled 由 totp_enabled 位决定，与 totp_secret 是否存在解耦：enroll 只写
   * secret 不置位，confirm 才置位。
   */
  static getTotpState() {
    const row = getDb()
      .prepare(
        `SELECT totp_secret, totp_enabled, totp_confirmed_at, totp_last_step
         FROM admin_account WHERE id = 1`,
      )
      .get();
    if (!row) return { secret: null, enabled: false, confirmedAt: null, lastStep: null };
    return {
      secret: row.totp_secret || null,
      enabled: row.totp_enabled === 1,
      confirmedAt: row.totp_confirmed_at || null,
      lastStep:
        row.totp_last_step === null || row.totp_last_step === undefined
          ? null
          : Number(row.totp_last_step),
    };
  }

  /**
   * 开始（或重开）挂靠：写入候选 secret 并把启用态整体复位。
   * 未确认前重开是被允许的（扫码后没输码就离开，回来必须能重新开始）；
   * 已启用时由路由层先行拒绝，不走这里。
   */
  static beginTotpEnrollment(secret) {
    getDb()
      .prepare(
        `UPDATE admin_account
         SET totp_secret = ?, totp_enabled = 0, totp_confirmed_at = NULL,
             totp_last_step = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
      )
      .run(secret);
  }

  /** confirm 通过：置启用位与确认时刻（secret 由 beginTotpEnrollment 写入，此处不动） */
  static confirmTotp() {
    getDb()
      .prepare(
        `UPDATE admin_account
         SET totp_enabled = 1, totp_confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
      )
      .run();
  }

  /** 记录最后一次被接受的步长（重放防护基线） */
  static setTotpLastStep(step) {
    getDb()
      .prepare(
        'UPDATE admin_account SET totp_last_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      )
      .run(step);
  }

  /**
   * 关闭两步验证：secret / 启用位 / 确认时刻 / 重放基线一并清空。
   * 四列必须同一次 UPDATE 清掉——留下任何一处都会让下一次 enroll 撞上
   * 过期的重放基线（新 secret 的步长与旧基线比较会误判为重放）。
   */
  static disableTotp() {
    getDb()
      .prepare(
        `UPDATE admin_account
         SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL,
             totp_last_step = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
      )
      .run();
  }
}

/**
 * 一次性恢复码模型。
 *
 * 明文永不落库：入参是已算好的 SHA-256 摘要（utils/recovery-codes.js）。
 * 表内行数即恢复码池大小；used_at 置位 = 该码作废（一次性）。
 */
export class AdminRecoveryCodeModel {
  /**
   * 全量替换恢复码池（确认挂靠时生成、关闭挂靠时清空后的重新生成）。
   * 事务保证「删旧 + 插新」原子：中途失败不会留下半池（用户拿到的清单必须
   * 与实际可用的码完全一致）。
   */
  static replaceAll(codeHashes) {
    const db = getDb();
    const run = db.transaction((hashes) => {
      db.prepare('DELETE FROM admin_recovery_codes').run();
      const insert = db.prepare('INSERT INTO admin_recovery_codes (code_hash) VALUES (?)');
      for (const hash of hashes) insert.run(hash);
    });
    run(codeHashes);
    return codeHashes.length;
  }

  /** 剩余未用恢复码数（status 接口只暴露这个计数，永不暴露码本身） */
  static countRemaining() {
    return getDb()
      .prepare('SELECT COUNT(*) AS n FROM admin_recovery_codes WHERE used_at IS NULL')
      .get().n;
  }

  static deleteAll() {
    return getDb().prepare('DELETE FROM admin_recovery_codes').run().changes;
  }

  /**
   * 校验并消费一枚恢复码（一次性）：命中即置 used_at，返回是否成功。
   *
   * 比对刻意不写成 `WHERE code_hash = ?`：那是一次普通的（可能提前返回的）
   * 索引等值查询，命中位置会通过耗时泄漏「前缀猜对了几位」。这里取出全部
   * 未用行，对每行摘要做定长（32B）crypto.timingSafeEqual 且**不提前返回**，
   * 最后才按命中 id 做条件更新——`AND used_at IS NULL` 让并发的两次同一码
   * 请求只有一次能成功（第二次 changes=0），避免 TOCTOU 双消费。
   */
  static verifyAndConsume(code) {
    const candidate = hashRecoveryCode(code);
    if (candidate === null) return false;
    const candidateBuf = Buffer.from(candidate, 'hex');
    const rows = getDb()
      .prepare('SELECT id, code_hash FROM admin_recovery_codes WHERE used_at IS NULL')
      .all();
    let matchedId = null;
    for (const row of rows) {
      const storedBuf = Buffer.from(String(row.code_hash), 'hex');
      if (storedBuf.length !== candidateBuf.length) continue;
      if (crypto.timingSafeEqual(storedBuf, candidateBuf)) matchedId = row.id;
    }
    if (matchedId === null) return false;
    const res = getDb()
      .prepare(
        'UPDATE admin_recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL',
      )
      .run(matchedId);
    return res.changes > 0;
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
    const res = getDb().prepare('DELETE FROM admin_sessions WHERE id != ?').run(keepId);
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
