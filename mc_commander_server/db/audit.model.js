import { getDb } from './database.js';
import { toIsoUtc, toDbUtcString } from '../utils/db-time.js';

export class AuditLogModel {
  static create(data) {
    const db = getDb();
    const result = db
      .prepare(`
      INSERT INTO audit_logs (instance_id, action, target_type, target_id, detail, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(
        data.instanceId,
        data.action,
        data.targetType || null,
        data.targetId || null,
        data.detail != null ? JSON.stringify(data.detail) : null,
        data.source || 'api',
      );
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id);
    return row ? this._toCamel(row) : null;
  }

  static findAll(options = {}) {
    const db = getDb();
    const {
      page = 1,
      pageSize = 20,
      instanceId,
      action,
      targetType,
      startTime,
      endTime,
      source,
      order = 'desc',
    } = options;

    let where = [];
    let params = [];

    if (instanceId) {
      where.push('instance_id = ?');
      params.push(instanceId);
    }
    if (action) {
      where.push('action = ?');
      params.push(action);
    }
    if (targetType) {
      where.push('target_type = ?');
      params.push(targetType);
    }
    if (source) {
      where.push('source = ?');
      params.push(source);
    }
    if (startTime) {
      where.push('created_at >= ?');
      params.push(startTime);
    }
    if (endTime) {
      where.push('created_at <= ?');
      params.push(endTime);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    // 排序方向白名单（issue 383）：缺省/非法值回落 DESC，与历史行为完全一致
    const direction = order === 'asc' ? 'ASC' : 'DESC';

    const rows = db
      .prepare(`
      SELECT * FROM audit_logs
      ${whereClause}
      ORDER BY id ${direction}
      LIMIT ? OFFSET ?
    `)
      .all(...params, pageSize, offset);

    const total = db
      .prepare(`
      SELECT COUNT(*) as count FROM audit_logs ${whereClause}
    `)
      .get(...params).count;

    return { logs: rows.map((r) => this._toCamel(r)), total, page, pageSize };
  }

  static prune(olderThanDays = 90) {
    const db = getDb();
    // cutoff 必须与 created_at 同口径（naive UTC 串）：拿 toISOString() 去比会在
    // **同一天**上因 ' '(0x20) < 'T'(0x54) 恒成立而误判，把当日记录整日多删
    const cutoff = toDbUtcString(Date.now() - olderThanDays * 86_400_000);
    const result = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  static _toCamel(row) {
    if (!row) return null;
    let detail = null;
    if (row.detail) {
      try {
        detail = JSON.parse(row.detail);
      } catch {
        detail = row.detail;
      }
    }
    return {
      id: row.id,
      instanceId: row.instance_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      detail,
      source: row.source,
      // created_at 是无时区 UTC 串，下发前归一化（前端 new Date() 才能正确换算本地时区）
      createdAt: toIsoUtc(row.created_at),
    };
  }
}

export class CommandHistoryModel {
  static create(data) {
    const db = getDb();
    const result = db
      .prepare(`
      INSERT INTO command_history (instance_id, command, source, success, response, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(
        data.instanceId,
        data.command,
        data.source || 'api',
        data.success ? 1 : 0,
        data.response || null,
        data.durationMs || null,
      );
    return this.findById(result.lastInsertRowid);
  }

  static findById(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM command_history WHERE id = ?').get(id);
    return row ? this._toCamel(row) : null;
  }

  static findAll(options = {}) {
    const db = getDb();
    const { page = 1, pageSize = 20, instanceId, startTime, endTime, source } = options;

    let where = [];
    let params = [];

    if (instanceId) {
      where.push('instance_id = ?');
      params.push(instanceId);
    }
    if (source) {
      where.push('source = ?');
      params.push(source);
    }
    if (startTime) {
      where.push('created_at >= ?');
      params.push(startTime);
    }
    if (endTime) {
      where.push('created_at <= ?');
      params.push(endTime);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const rows = db
      .prepare(`
      SELECT * FROM command_history
      ${whereClause}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `)
      .all(...params, pageSize, offset);

    const total = db
      .prepare(`
      SELECT COUNT(*) as count FROM command_history ${whereClause}
    `)
      .get(...params).count;

    return { commands: rows.map((r) => this._toCamel(r)), total, page, pageSize };
  }

  static prune(olderThanDays = 90) {
    const db = getDb();
    // 同 AuditLogModel.prune：cutoff 与列必须同口径（naive UTC 串）
    const cutoff = toDbUtcString(Date.now() - olderThanDays * 86_400_000);
    const result = db.prepare('DELETE FROM command_history WHERE created_at < ?').run(cutoff);
    return result.changes;
  }

  static _toCamel(row) {
    if (!row) return null;
    return {
      id: row.id,
      instanceId: row.instance_id,
      command: row.command,
      source: row.source,
      success: !!row.success,
      response: row.response,
      durationMs: row.duration_ms,
      createdAt: toIsoUtc(row.created_at),
    };
  }
}
