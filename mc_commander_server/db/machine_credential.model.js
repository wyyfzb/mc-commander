import crypto from 'crypto';
import { getDb } from './database.js';
import { parseScopes, serializeScopes } from '../utils/scopes.js';
import { toIsoUtc } from '../utils/db-time.js';

/**
 * 机器凭据台账（可作用域化的多 Key 体系）。
 *
 * 与 `.env` 两把哈希的关系：`.env` 的 `API_KEY_HASH` / `READONLY_API_KEY_HASH` 仍是
 * **既有的两条固定通道**（部署方自填、行为逐字不变）；本表是**用户自建的、可命名、
 * 可作用域化、可停用/吊销**的委托身份。解析顺序上先查本表（按摘要），未命中再落到
 * `.env` 两条——这样新增能力不影响既有部署。
 *
 * 存的是**摘要**（SHA-256），明文只在创建那一次响应里出现，与 `.env` 通道同款。
 * 时间统一 UTC 字符串（SQLite 字符串比较对 ISO 天然有序，与 admin.model 一致）。
 */

/** 机器凭据 id 前缀（与 admin 会话 id 的命名空间区分，便于日志辨认） */
const CREDENTIAL_ID_PREFIX = 'mck_';

export class MachineCredentialModel {
  /**
   * 新建凭据。tokenHash 由调用方算好（明文不进入本层，避免明文在本模块流转）。
   * scopes 接受数组或字符串，落库前经 parseScopes 规范化并序列化。
   */
  static create({ name, tokenHash, tokenPrefix, scopes }) {
    const db = getDb();
    const id = `${CREDENTIAL_ID_PREFIX}${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO machine_credentials (id, name, token_hash, token_prefix, scopes)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name, tokenHash, tokenPrefix, serializeScopes(scopes));
    return this.findById(id);
  }

  static findById(id) {
    const row = getDb().prepare('SELECT * FROM machine_credentials WHERE id = ?').get(id);
    return row ? this._toCamel(row) : null;
  }

  /**
   * 按摘要查找**启用且未吊销**的凭据——每个请求的热路径入口。
   *
   * 停用/吊销的判定放在 SQL 里而不是查回来再判：查回来再判会让「已吊销」的凭据
   * 也能走到调用方，任何一处忘了判就变成越权；写成查询条件则漏判无从发生。
   * `revoked_at IS NULL` 与 `is_enabled = 1` 两个条件都必须在这里。
   */
  static findActiveByTokenHash(tokenHash) {
    const row = getDb()
      .prepare(
        `SELECT * FROM machine_credentials
         WHERE token_hash = ? AND is_enabled = 1 AND revoked_at IS NULL`,
      )
      .get(tokenHash);
    return row ? this._toCamel(row) : null;
  }

  /** 列表（不含摘要——摘要不可外泄，连管理员界面也不需要）。默认不含已吊销。 */
  static list({ includeRevoked = false } = {}) {
    const sql = includeRevoked
      ? `SELECT id, name, token_prefix, scopes, is_enabled, revoked_at, last_used_at, created_at
         FROM machine_credentials ORDER BY created_at DESC`
      : `SELECT id, name, token_prefix, scopes, is_enabled, revoked_at, last_used_at, created_at
         FROM machine_credentials WHERE revoked_at IS NULL ORDER BY created_at DESC`;
    return getDb()
      .prepare(sql)
      .all()
      .map((row) => this._toCamel(row));
  }

  /** 启停（可恢复）。返回是否命中了行，供调用方区分 404。 */
  static setEnabled(id, enabled) {
    const result = getDb()
      .prepare(
        `UPDATE machine_credentials SET is_enabled = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(enabled ? 1 : 0, id);
    return result.changes > 0;
  }

  /**
   * 吊销（不可逆）。保留行：吊销后仍要能回答「这把 Key 曾经是谁」，
   * 删行会丢审计线索。已吊销的行重复吊销返回 false（调用方报 404 语义）。
   */
  static revoke(id) {
    const result = getDb()
      .prepare(
        `UPDATE machine_credentials SET revoked_at = CURRENT_TIMESTAMP, is_enabled = 0
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(id);
    return result.changes > 0;
  }

  /**
   * 记录最近使用时刻（节流写库，与 admin 会话的 60s 滑动续期同款理由：热路径上
   * 每个请求都写会放大写放大）。只在距上次记录超过 intervalMs 时写。
   */
  static touchLastUsed(id, intervalMs = 60_000) {
    const db = getDb();
    // 用 SQL 侧比较决定是否写：把判定留在 DB 可以避免「读-判-写」的并发窗口
    db.prepare(
      `UPDATE machine_credentials SET last_used_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND (last_used_at IS NULL OR last_used_at <= datetime('now', ?))`,
    ).run(id, `-${Math.max(1, Math.ceil(intervalMs / 1000))} seconds`);
  }

  /**
   * 行 → camelCase 领域对象。
   *
   * **不返回 tokenHash**：摘要是凭据本体的一份等价物（持有它即可比对，且它落库的唯一
   * 用途是热路径查找），任何出参都不需要它——连管理员界面也不需要。放在 _toCamel 里
   * 剔除而不是让每个调用点自己记得删，是因为「新增一个出参就泄漏一次摘要」这类漏洞
   * 靠调用点自觉必然复发（见本文件顶部「摘要不可外泄」的落点说明）。
   * `findActiveByTokenHash` 需要哈希做判定，故它单独返回原始行（见下方注释）。
   *
   * scopes 解析回数组：字符串形态只在存储层存在，出了本层一律是数组（否则每个消费点
   * 都要记得 split）。
   */
  static _toCamel(row) {
    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      scopes: parseScopes(row.scopes).scopes,
      isEnabled: row.is_enabled === 1,
      revokedAt: row.revoked_at ? toIsoUtc(row.revoked_at) : null,
      lastUsedAt: row.last_used_at ? toIsoUtc(row.last_used_at) : null,
      createdAt: row.created_at ? toIsoUtc(row.created_at) : null,
    };
  }
}

export default { MachineCredentialModel };
