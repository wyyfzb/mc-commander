import { getDb } from './database.js';
import { logger } from '../utils/logger.js';
import { parseDbTime, toIsoUtc } from '../utils/db-time.js';

// 对外查询列白名单（find-021）：显式列出字段，绝不返回 file_path。
// file_path 是服务器本地磁盘路径，原样下发给 API 客户端会泄露服务器
// 目录结构（且可被用于探测/构造路径）；file_path 仅服务层内部通过
// findByIdWithPath 获取（restoreBackup/deleteBackup 需要）。
const PUBLIC_COLUMNS =
  'id, instance_id, name, description, type, size, status, world_name, format, created_at, updated_at';

export class BackupModel {
  static findAll(options = {}) {
    const db = getDb();
    const { page = 1, pageSize = 20, instanceId, type, status } = options;

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

    if (status) {
      where.push('status = ?');
      params.push(status);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const backups = db.prepare(`
      SELECT ${PUBLIC_COLUMNS} FROM backups
      ${whereClause}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM backups ${whereClause}
    `).get(...params).count;

    return { backups: backups.map(r => this._toCamel(r)), total, page, pageSize };
  }

  static findById(id) {
    const db = getDb();
    const row = db.prepare(`
      SELECT ${PUBLIC_COLUMNS} FROM backups WHERE id = ?
    `).get(id);
    return row ? this._toCamel(row) : null;
  }

  // 服务层专用：返回含 file_path 的完整行。file_path 仅限服务层内部
  // 使用（restoreBackup/deleteBackup 需要磁盘路径），绝不通过 API 下发。
  // 保持 snake_case 原始行（服务层按 DB 列名访问），不做 camelCase 映射。
  static findByIdWithPath(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  }

  /**
   * 将 DB 的 snake_case 行映射为前端期望的 camelCase 对象。
   * size 保持字节原值，换算由前端完成。
   * createdAt/updatedAt 经 toIsoUtc 补 Z 转 ISO8601，前端 toLocal() 才能正确换算。
   */
  static _toCamel(row) {
    if (!row) return null;
    return {
      id: row.id,
      instanceId: row.instance_id,
      name: row.name,
      description: row.description,
      type: row.type,
      size: row.size,
      status: row.status,
      worldName: row.world_name,
      format: row.format,
      createdAt: toIsoUtc(row.created_at),
      updatedAt: toIsoUtc(row.updated_at),
    };
  }

  static create(data) {
    const db = getDb();

    const result = db.prepare(`
      INSERT INTO backups (
        instance_id, name, description, type, size, status,
        file_path, world_name, format
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.instanceId,
      data.name,
      data.description || null,
      data.type || 'manual',
      data.size || 0,
      data.status || 'creating',
      data.filePath || null,
      data.worldName || null,
      data.format || 'snapshot'
    );

    return this.findById(result.lastInsertRowid);
  }

  static update(id, data) {
    const db = getDb();
    const updates = [];
    const params = [];

    const fieldMap = {
      name: 'name',
      description: 'description',
      status: 'status',
      size: 'size',
      filePath: 'file_path',
      worldName: 'world_name',
      format: 'format'
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        updates.push(`${column} = ?`);
        params.push(data[key]);
      }
    }

    if (updates.length > 0) {
      // 任何状态/字段变更同时刷新 updated_at：restoring 卡死判定
      // 依赖"状态最后变更时间"（恢复可能发生在很久以前创建的备份上）
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);

      db.prepare(`
        UPDATE backups SET ${updates.join(', ')} WHERE id = ?
      `).run(...params);
    }

    return this.findById(id);
  }

  /**
   * 卡死恢复：进程崩溃时执行中的备份/恢复记录永久停留 creating/restoring
   * （fire-and-forget 的 finally 不会执行），导致该实例备份功能永久死锁
   * （互斥检查全部命中 409）。超过 maxAgeMs 的进行中记录按语义重置：
   * - creating（备份执行中崩溃，zip 可能不完整）→ failed
   * - restoring（恢复执行中崩溃，备份文件本身未动）→ completed
   * 返回被重置的记录数。JS 侧比较避免 SQLite 时间函数时区差异。
   */
  static resetStaleInProgress({ maxAgeMs = 60 * 60 * 1000, instanceId } = {}) {
    const db = getDb();
    let where = "status IN ('creating', 'restoring')";
    const params = [];
    if (instanceId) {
      where += ' AND instance_id = ?';
      params.push(instanceId);
    }

    const stale = db.prepare(`SELECT id, status, updated_at FROM backups WHERE ${where}`).all(...params);
    const cutoff = Date.now() - maxAgeMs;
    let resetCount = 0;

    for (const row of stale) {
      // 必须经 parseDbTime 归一化：SQLite 时间是无时区标记的 UTC 串，直接
      // Date.parse 会按本地时区解释，非 UTC 时区下所有记录都会被误判为陈旧，
      // 使下方互斥检查（backup.service）的 busyCount 恒为 0。
      const ts = parseDbTime(row.updated_at || row.created_at);
      if (ts < cutoff) {
        const target = row.status === 'restoring' ? 'completed' : 'failed';
        db.prepare(`UPDATE backups SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(target, row.id);
        logger.warn(
          `[Backup] Reset stale ${row.status} backup record #${row.id} -> ${target} (crashed process)`
        );
        resetCount++;
      }
    }
    return resetCount;
  }

  static delete(id) {
    const db = getDb();
    const result = db.prepare('DELETE FROM backups WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // 删除某实例的全部备份记录（实例卸载时清理孤儿记录，
  // 配合备份目录删除，避免 backups 表残留该实例的孤立行）
  static deleteByInstance(instanceId) {
    const db = getDb();
    const result = db.prepare('DELETE FROM backups WHERE instance_id = ?').run(instanceId);
    return result.changes > 0;
  }

  static getLatestBackup(instanceId) {
    const db = getDb();
    const row = db.prepare(`
      SELECT ${PUBLIC_COLUMNS} FROM backups
      WHERE instance_id = ? AND status = 'completed'
      ORDER BY id DESC
      LIMIT 1
    `).get(instanceId);
    return row ? this._toCamel(row) : null;
  }

  static getBackupCount(instanceId) {
    const db = getDb();
    return db.prepare(`
      SELECT COUNT(*) as count FROM backups WHERE instance_id = ?
    `).get(instanceId).count;
  }

  static getTotalSize(instanceId) {
    const db = getDb();
    const result = db.prepare(`
      SELECT COALESCE(SUM(size), 0) as total_size FROM backups WHERE instance_id = ?
    `).get(instanceId);
    return result.total_size;
  }
}

export default BackupModel;
