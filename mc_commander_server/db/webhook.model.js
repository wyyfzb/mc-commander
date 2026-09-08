/**
 * Webhook Model — CRUD + 投递日志
 * Secret 脱敏：API 返回 ********；findByIdInternal 返回原始 secret 供签名
 */
import { getDb } from './database.js';

export class WebhookModel {
  static create(data) {
    const db = getDb();
    const eventsJson = JSON.stringify(data.events || []);
    const result = db.prepare(`
      INSERT INTO webhooks (name, url, secret, events, instance_id, is_enabled, platform)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name,
      data.url,
      data.secret || null,
      eventsJson,
      data.instanceId || null,
      data.isEnabled !== undefined ? (data.isEnabled ? 1 : 0) : 1,
      data.platform || 'generic',
    );
    return this.findById(result.lastInsertRowid);
  }

  static update(id, data) {
    const db = getDb();
    const sets = [];
    const params = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.url !== undefined) { sets.push('url = ?'); params.push(data.url); }
    if (data.secret !== undefined) { sets.push('secret = ?'); params.push(data.secret); }
    if (data.platform !== undefined) { sets.push('platform = ?'); params.push(data.platform); }
    if (data.events !== undefined) { sets.push('events = ?'); params.push(JSON.stringify(data.events)); }
    if (data.instanceId !== undefined) { sets.push('instance_id = ?'); params.push(data.instanceId); }
    if (data.isEnabled !== undefined) { sets.push('is_enabled = ?'); params.push(data.isEnabled ? 1 : 0); }

    if (sets.length === 0) return this.findById(id);

    params.push(id);
    db.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.findById(id);
  }

  static delete(id) {
    const db = getDb();
    // 级联删除投递日志
    db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(id);
    const result = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  static findById(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    return row ? this._toCamel(row, true) : null;
  }

  /** 内部查询：返回原始 secret（供投递签名），不脱敏 */
  static findByIdInternal(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    return row ? this._toCamel(row, false) : null;
  }

  static findAll(options = {}) {
    const db = getDb();
    const { page = 1, pageSize = 20 } = options;
    const offset = (page - 1) * pageSize;

    const rows = db.prepare(`
      SELECT * FROM webhooks ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(pageSize, offset);

    const total = db.prepare('SELECT COUNT(*) as count FROM webhooks').get().count;

    return { webhooks: rows.map(r => this._toCamel(r, true)), total, page, pageSize };
  }

  /** 查询所有已启用的 webhook（投递时使用，返回原始 secret） */
  static findAllEnabled() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM webhooks WHERE is_enabled = 1').all();
    return rows.map(r => this._toCamel(r, false));
  }

  // ── 投递日志 ──

  static createDelivery(data) {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO webhook_deliveries
        (webhook_id, event_type, instance_id, payload, status, response_status, response_body, duration_ms, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.webhookId,
      data.eventType,
      data.instanceId || null,
      data.payload != null ? JSON.stringify(data.payload) : null,
      data.status,
      data.responseStatus || null,
      data.responseBody || null,
      data.durationMs ?? null,
      data.attempts || 1,
    );
    return result.lastInsertRowid;
  }

  static updateDelivery(id, data) {
    const db = getDb();
    const sets = [];
    const params = [];

    if (data.status !== undefined) { sets.push('status = ?'); params.push(data.status); }
    if (data.responseStatus !== undefined) { sets.push('response_status = ?'); params.push(data.responseStatus); }
    if (data.responseBody !== undefined) { sets.push('response_body = ?'); params.push(data.responseBody); }
    if (data.durationMs !== undefined) { sets.push('duration_ms = ?'); params.push(data.durationMs); }
    if (data.attempts !== undefined) { sets.push('attempts = ?'); params.push(data.attempts); }

    if (sets.length === 0) return;
    params.push(id);
    db.prepare(`UPDATE webhook_deliveries SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  static findDeliveries(options = {}) {
    const db = getDb();
    const {
      page = 1, pageSize = 20,
      webhookId, eventType, status,
    } = options;

    let where = [];
    let params = [];

    if (webhookId) { where.push('webhook_id = ?'); params.push(webhookId); }
    if (eventType) { where.push('event_type = ?'); params.push(eventType); }
    if (status) { where.push('status = ?'); params.push(status); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const rows = db.prepare(`
      SELECT * FROM webhook_deliveries
      ${whereClause}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM webhook_deliveries ${whereClause}
    `).get(...params).count;

    return { deliveries: rows.map(r => this._deliveryToCamel(r)), total, page, pageSize };
  }

  static pruneDeliveries(olderThanDays = 30) {
    const db = getDb();
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = db.prepare('DELETE FROM webhook_deliveries WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  static _toCamel(row, maskSecret) {
    if (!row) return null;
    let events = [];
    if (row.events) {
      try { events = JSON.parse(row.events); } catch { events = []; }
    }
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      secret: maskSecret ? '********' : (row.secret || null),
      platform: row.platform || 'generic',
      events,
      instanceId: row.instance_id,
      isEnabled: !!row.is_enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  static _deliveryToCamel(row) {
    if (!row) return null;
    let payload = null;
    if (row.payload) {
      try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
    }
    return {
      id: row.id,
      webhookId: row.webhook_id,
      eventType: row.event_type,
      instanceId: row.instance_id,
      payload,
      status: row.status,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      durationMs: row.duration_ms,
      attempts: row.attempts,
      createdAt: row.created_at,
    };
  }
}
