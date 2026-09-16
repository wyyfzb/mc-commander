import { getDb } from './database.js';
import { toIsoUtc } from '../utils/db-time.js';

const COLUMN_TO_FIELD = {
  id: 'id',
  name: 'name',
  description: 'description',
  status: 'status',
  jar_file: 'jarFile',
  java_path: 'javaPath',
  max_memory: 'maxMemory',
  min_memory: 'minMemory',
  start_command: 'startCommand',
  server_path: 'serverPath',
  mc_version: 'mcVersion',
  mod_loader: 'modLoader',
  port: 'port',
  auto_start: 'autoStart',
  auto_restart: 'autoRestart',
  total_uptime: 'totalUptime',
  jvm_args: 'jvmArgs',
  created_at: 'createdAt',
  updated_at: 'updatedAt'
};

const FIELD_TO_COLUMN = {
  name: 'name',
  description: 'description',
  status: 'status',
  jarFile: 'jar_file',
  javaPath: 'java_path',
  maxMemory: 'max_memory',
  minMemory: 'min_memory',
  startCommand: 'start_command',
  serverPath: 'server_path',
  mcVersion: 'mc_version',
  modLoader: 'mod_loader',
  port: 'port',
  autoStart: 'auto_start',
  autoRestart: 'auto_restart',
  totalUptime: 'total_uptime',
  jvmArgs: 'jvm_args'
};

function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function rowToInstance(row) {
  if (!row) return null;
  const instance = {};
  for (const [col, field] of Object.entries(COLUMN_TO_FIELD)) {
    if (col in row) {
      let value = row[col];
      if ((col === 'auto_start' || col === 'auto_restart') && value !== null) {
        value = Boolean(value);
      }
      // created_at/updated_at 是 CURRENT_TIMESTAMP 的无时区 UTC 串，下发前归一化
      if (col === 'created_at' || col === 'updated_at') {
        value = toIsoUtc(value);
      }
      // jvm_args 存 JSON 数组文本，损坏/非法时回退 null（安全方向：不启动
      // 恶意参数，由服务层校验兜底）
      if (col === 'jvm_args' && value !== null) {
        try {
          value = JSON.parse(value);
        } catch {
          value = null;
        }
      }
      instance[field] = value;
    }
  }
  return instance;
}

export class InstanceModel {
  static create(instanceData) {
    const db = getDb();
    const modLoader = instanceData.type ? capitalizeFirst(instanceData.type) : 'Vanilla';
    const port = instanceData.port !== undefined ? instanceData.port : 25565;

    // 窄列 upsert：整行覆盖（INSERT OR REPLACE）在 id 冲突时先删后插，未列出的列
    // （description/status/start_command/auto_start/auto_restart/total_uptime/
    // jvm_args）会被静默清空或重置、created_at 被重置；这些列只由 update() 维护，
    // create() 一律不得回退它们。范式与 db/admin.model.js 的窄列 UPDATE 一致。
    db.prepare(`
      INSERT INTO instances (
        id, name, mod_loader, jar_file, java_path, max_memory, min_memory,
        server_path, mc_version, port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        mod_loader = excluded.mod_loader,
        jar_file = excluded.jar_file,
        java_path = excluded.java_path,
        max_memory = excluded.max_memory,
        min_memory = excluded.min_memory,
        server_path = excluded.server_path,
        mc_version = excluded.mc_version,
        port = excluded.port,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      instanceData.id,
      instanceData.name,
      modLoader,
      instanceData.jarFile || null,
      instanceData.javaPath || 'java',
      instanceData.maxMemory || '2G',
      instanceData.minMemory || '1G',
      instanceData.serverPath || null,
      instanceData.mcVersion || null,
      port
    );

    return instanceData.id;
  }

  static getById(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    return rowToInstance(row);
  }

  static getAll() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all();
    return rows.map(rowToInstance);
  }

  static update(id, fields) {
    const db = getDb();
    const updates = [];
    const params = [];

    for (const [key, column] of Object.entries(FIELD_TO_COLUMN)) {
      if (fields[key] !== undefined) {
        updates.push(`${column} = ?`);
        let value = fields[key];
        if (key === 'autoStart' || key === 'autoRestart') {
          value = value ? 1 : 0;
        }
        // jvmArgs 为数组，DB 列存 JSON 文本
        if (key === 'jvmArgs' && value !== null) {
          value = JSON.stringify(value);
        }
        params.push(value);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      db.prepare(`UPDATE instances SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    return this.getById(id);
  }

  static delete(id) {
    const db = getDb();
    const result = db.prepare('DELETE FROM instances WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /// 累加实例的累计运行时长（秒），在服务器停止时调用
  static addUptime(id, seconds) {
    const db = getDb();
    db.prepare('UPDATE instances SET total_uptime = total_uptime + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(Math.floor(seconds), id);
    return this.getById(id);
  }

  /// 获取实例的累计运行时长（秒）
  static getTotalUptime(id) {
    const db = getDb();
    const row = db.prepare('SELECT total_uptime FROM instances WHERE id = ?').get(id);
    return row?.total_uptime || 0;
  }

  static migrateFromJson(instanceConfig, serverPath) {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM instances WHERE id = ?').get(instanceConfig.id);
    if (existing) {
      return false;
    }
    this.create({ ...instanceConfig, serverPath });
    return true;
  }
}

export default InstanceModel;
