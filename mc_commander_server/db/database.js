import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import config from '../config.js';

let db = null;

export function initDatabase() {
  const dbPath = path.join(config.dataDir || './data', 'mc_commander.db');

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables();

  console.log(`Database initialized at ${dbPath}`);
  return db;
}

function createTables() {
  // 实例表
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'stopped',
      jar_file TEXT,
      java_path TEXT DEFAULT 'java',
      max_memory TEXT DEFAULT '2G',
      min_memory TEXT DEFAULT '1G',
      start_command TEXT,
      server_path TEXT,
      mc_version TEXT,
      mod_loader TEXT DEFAULT 'Vanilla',
      port INTEGER DEFAULT 25565,
      auto_start INTEGER DEFAULT 0,
      auto_restart INTEGER DEFAULT 1,
      total_uptime INTEGER DEFAULT 0,
      jvm_args TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 迁移：为已有数据库添加 total_uptime 字段（SQLite ALTER TABLE 兼容）
  try {
    db.prepare('SELECT total_uptime FROM instances LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE instances ADD COLUMN total_uptime INTEGER DEFAULT 0');
    console.log('Migration: added total_uptime column to instances table');
  }

  // 迁移：实例意外停止自动重启默认开启（新功能，用 user_version 标记一次性执行）
  const userVersion = db.pragma('user_version', { simple: true });
  if (userVersion < 1) {
    db.exec('UPDATE instances SET auto_restart = 1 WHERE auto_restart = 0');
    db.pragma('user_version = 1');
    console.log('Migration: enabled auto_restart for all instances (default on)');
  }

  // 迁移：jvm_args 结构化启动参数列（实例级 jvmArgs 持久化，
  // 替代自由 startCommand 写入面；JSON 数组文本存储）
  if (userVersion < 2) {
    try {
      db.prepare('SELECT jvm_args FROM instances LIMIT 1').get();
    } catch {
      db.exec('ALTER TABLE instances ADD COLUMN jvm_args TEXT');
    }
    db.pragma('user_version = 2');
    console.log('Migration: added jvm_args column to instances table');
  }

  // 备份表
  // format 列（v4）：'snapshot'（目录快照，当前格式）/'zip'（旧格式压缩包，
  // 仅保留可删）。恢复路径按 format 分流——zip 无解压链路直接拒绝
  db.exec(`
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'manual',
      size INTEGER DEFAULT 0,
      status TEXT DEFAULT 'creating',
      file_path TEXT,
      world_name TEXT,
      format TEXT DEFAULT 'snapshot',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
    )
  `);

  // 迁移：backups 表增加 updated_at 列（v3）——恢复互斥状态机（status='restoring'）
  // 的卡死清理需要"状态最后变更时间"：creating 的年龄可用 created_at 判断，
  // 但 restoring 可能发生在很久以前创建的备份上（创建时间≠状态变更时间），
  // 必须用 updated_at 判断恢复是否卡死（超过阈值 → 重置回 completed）
  if (userVersion < 3) {
    try {
      db.prepare('SELECT updated_at FROM backups LIMIT 1').get();
    } catch {
      db.exec('ALTER TABLE backups ADD COLUMN updated_at TEXT DEFAULT CURRENT_TIMESTAMP');
    }
    db.pragma('user_version = 3');
    console.log('Migration: added updated_at column to backups table');
  }

  // 迁移：backups 表增加 format 列（v4）——快照方案（目录快照 + rsync/robocopy
  // 增量）取代 zip 压缩后，历史 zip 备份与新建快照需区分：
  // 旧记录 file_path 以 .zip 结尾 → 标记 zip（仅可删，恢复拒绝）；
  // 其余（含新库建表默认值）为 snapshot。存量迁移不依赖默认值，
  // 显式按 file_path 后缀改写，保证老库与旧版本写入的行均正确归类
  if (userVersion < 4) {
    try {
      db.prepare('SELECT format FROM backups LIMIT 1').get();
    } catch {
      db.exec("ALTER TABLE backups ADD COLUMN format TEXT DEFAULT 'snapshot'");
    }
    db.exec("UPDATE backups SET format = 'zip' WHERE file_path LIKE '%.zip'");
    db.pragma('user_version = 4');
    console.log('Migration: added format column to backups table');
  }

  // 定时任务表
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      command TEXT,
      is_enabled INTEGER DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
    )
  `);

  // 迁移：scheduled_tasks 表增加 last_run_status 列（v5）——最近一次触发结果
  // （never/success/failed/skipped）落库，失败/跳过对用户可见；
  // 列默认值 never 兜底新增行，存量行补列后同样得到 never
  if (userVersion < 5) {
    try {
      db.prepare('SELECT last_run_status FROM scheduled_tasks LIMIT 1').get();
    } catch {
      db.exec("ALTER TABLE scheduled_tasks ADD COLUMN last_run_status TEXT DEFAULT 'never'");
    }
    db.pragma('user_version = 5');
    console.log('Migration: added last_run_status column to scheduled_tasks table');
  }

  // 迁移 v6：审计日志 + 命令历史（append-only 双表）
  if (userVersion < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        detail TEXT,
        source TEXT DEFAULT 'api',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS command_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        command TEXT NOT NULL,
        source TEXT DEFAULT 'api',
        success INTEGER DEFAULT 1,
        response TEXT,
        duration_ms INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_instance ON audit_logs(instance_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_cmd_instance ON command_history(instance_id);
      CREATE INDEX IF NOT EXISTS idx_cmd_created ON command_history(created_at);
    `);
    db.pragma('user_version = 6');
    console.log('Migration: added audit_logs and command_history tables');
  }

  // 迁移 v7：Webhook 外部通知 + 投递日志
  if (userVersion < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        events TEXT DEFAULT '[]',
        instance_id TEXT,
        is_enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        instance_id TEXT,
        payload TEXT,
        status TEXT DEFAULT 'pending',
        response_status INTEGER,
        response_body TEXT,
        duration_ms INTEGER,
        attempts INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(is_enabled);
      CREATE INDEX IF NOT EXISTS idx_webhooks_instance ON webhooks(instance_id);
      CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_deliveries_created ON webhook_deliveries(created_at);
    `);
    db.pragma('user_version = 7');
    console.log('Migration: added webhooks and webhook_deliveries tables');
  }

  // 临时封禁表（服务端自实现 tempban：原版 ban 立即生效 + 到期自动 pardon）
  db.exec(`
    CREATE TABLE IF NOT EXISTS temp_bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'player',
      target TEXT NOT NULL,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
    )
  `);

  // 通知事件日志表（广播前落库：断线补齐 + 投递审计）。
  // 高频事件（log/status 快照/performance/tps）不落库，仅通知类事件落库
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT,
      type TEXT NOT NULL,
      data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // v8：audit_logs.instance_id 放宽为可空——全局动作（API Key 轮换、管理员
  // 登录/登出/改密等）没有实例上下文，原 NOT NULL 约束导致这些审计写入
  // 失败且被 recordAudit 静默吞掉（仅 warn），审计链路存在盲区。
  // SQLite 无法直接改列约束：重建表 + 复制 + 原名替换；新库由上方 v6 建表
  // 语句直接可空，此处仅在检测到 notnull 标记时执行重建。
  if (userVersion < 8) {
    const auditInstanceId = db.prepare('PRAGMA table_info(audit_logs)').all()
      .find((c) => c.name === 'instance_id');
    if (auditInstanceId?.notnull) {
      db.exec(`
        CREATE TABLE audit_logs_v8 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id TEXT,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          detail TEXT,
          source TEXT DEFAULT 'api',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO audit_logs_v8 (id, instance_id, action, target_type, target_id, detail, source, created_at)
          SELECT id, instance_id, action, target_type, target_id, detail, source, created_at FROM audit_logs;
        DROP TABLE audit_logs;
        ALTER TABLE audit_logs_v8 RENAME TO audit_logs;
      `);
      console.log('Migration: relaxed audit_logs.instance_id to nullable (global actions audit)');
    }
    db.pragma('user_version = 8');
  }

  // 管理员账号（安全主线：单管理员密码登录）。单行表 id 恒为 1；
  // totp_secret 预留 TOTP 两步验证挂靠（roadmap）
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password_hash TEXT NOT NULL,
      totp_secret TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 管理员会话：仅存令牌 SHA-256 摘要（数据库泄露不等于会话泄露）；
  // 滑动续期（expires_at 每次认证触达刷新）；踢单设备 = 删除对应行
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      ip TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    )
  `);

  // 创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

    CREATE INDEX IF NOT EXISTS idx_backups_instance_id ON backups(instance_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_instance_id ON scheduled_tasks(instance_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(is_enabled);
    CREATE INDEX IF NOT EXISTS idx_temp_bans_active ON temp_bans(is_active);
    CREATE INDEX IF NOT EXISTS idx_temp_bans_instance ON temp_bans(instance_id);
    CREATE INDEX IF NOT EXISTS idx_notification_events_instance ON notification_events(instance_id);
  `);
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export default { initDatabase, getDb };
