/**
 * 契约测试：服务端响应与 @mc-commander/schemas 单源 schema 对齐（验收 #262-#2 响应侧）
 *
 * 用 supertest 实打实打路由（真实 model + SQLite 内存外临时库），断言：
 * 1. 成功响应信封可被 apiEnvelopeSchema parse（status/code/message/timestamp 结构）
 * 2. data 可被对应资源 schema parse（webhook / scheduledTask，含列表逐条）
 * 3. 非法请求体被 validateBody 拒绝：400 + VALIDATION_ERROR(40000) + 结构化 details
 *
 * 本文件同时是 '@mc-commander/schemas'（dist 构建产物）在服务端 CI 环境的
 * 解析冒烟测试——导入失败即测试失败。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  apiEnvelopeSchema,
  makeApiEnvelopeSchema,
  webhookSchema,
  scheduledTaskSchema,
  taskRunHistorySchema,
  banRecordSchema,
  backupItemSchema,
  overviewDataSchema,
} from '@mc-commander/schemas';

const TEST_DIR = './test-schema-contract-data';
let db;

beforeAll(() => {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'stopped',
    server_path TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL,
    secret TEXT, platform TEXT NOT NULL DEFAULT 'generic', events TEXT DEFAULT '[]',
    instance_id TEXT, is_enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id INTEGER NOT NULL,
    event_type TEXT NOT NULL, instance_id TEXT, payload TEXT,
    status TEXT DEFAULT 'pending', response_status INTEGER, response_body TEXT,
    duration_ms INTEGER, attempts INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_tasks (
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
  )`);
  db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_run_status TEXT DEFAULT 'never'`);
  db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_run_error TEXT`);
  // v10：任务执行历史（history 契约测试用）
  db.exec(`CREATE TABLE IF NOT EXISTS task_run_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    run_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL,
    error TEXT,
    duration_ms INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL,
    action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT,
    source TEXT DEFAULT 'api', created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // v11：响应侧契约观测推广（#393）——players 封禁记录 / backups 列表契约断言用
  db.exec(`CREATE TABLE IF NOT EXISTS temp_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT 'player',
    target TEXT NOT NULL,
    reason TEXT,
    expires_at INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS backups (
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
  )`);
  // 外键种子：任务路由创建时校验实例存在（serverManager fake + DB 外键双重约束）
  db.prepare("INSERT OR IGNORE INTO instances (id, name) VALUES ('demo', '契约测试实例')").run();
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

vi.mock('../db/database.js', () => ({ getDb: () => db }));
vi.mock('../utils/audit.js', () => ({ recordAudit: vi.fn(), AuditActions: {} }));

// url-guard 真实实现 + 注入假 lookup：webhook 创建不触网（恒定解析到公网示例地址）
vi.mock('../utils/url-guard.js', async () => {
  const real = await vi.importActual('../utils/url-guard.js');
  return {
    checkPublicUrl: (url) => real.checkPublicUrl(url, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
  };
});

const { createWebhookRoutes } = await import('../routes/webhooks.js');
const { createTaskRoutes } = await import('../routes/tasks.js');
const { createPlayerRoutes } = await import('../routes/players.js');
const { createStatusRoutes } = await import('../routes/status.js');
const { createBackupRoutes } = await import('../routes/backups.js');

function getApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createWebhookRoutes());
  const fakeServerManager = { getInstance: () => ({ id: 'demo' }) };
  app.use('/api/v1', createTaskRoutes(fakeServerManager, null));
  return app;
}

describe('响应契约：webhook 路由 × webhookSchema', () => {
  it('POST /webhooks 创建成功 → 信封与 data 均可 parse', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks').send({
      name: '契约测试',
      url: 'https://example.com/hook',
      events: ['player.join'],
    });
    expect(res.status).toBe(200);
    expect(apiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(makeApiEnvelopeSchema(webhookSchema).safeParse(res.body).success).toBe(true);
  });

  it('GET /webhooks 列表 → 信封 + pagination 可 parse，data 逐条通过 webhookSchema', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks');
    expect(res.status).toBe(200);
    expect(apiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.pagination).toBeDefined();
    for (const item of res.body.data) {
      expect(webhookSchema.safeParse(item).success).toBe(true);
    }
  });

  it('POST /webhooks 缺少必填字段 → 40000 + 结构化 details', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks').send({ name: '只有名字' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(res.body.details[0]).toHaveProperty('path');
    expect(res.body.details[0]).toHaveProperty('message');
  });

  it('POST /webhooks 非法类型字段（events 非数组）→ 40000', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'x', url: 'https://example.com/hook', events: 'not-an-array',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });
});

describe('响应契约：任务路由 × scheduledTaskSchema', () => {
  it('POST /instances/:id/tasks 创建成功 → 201 且 data 可 parse', async () => {
    const res = await request(getApp()).post('/api/v1/instances/demo/tasks').send({
      name: '每日重启', type: 'restart', cronExpression: '0 4 * * *',
    });
    expect(res.status).toBe(201);
    expect(makeApiEnvelopeSchema(scheduledTaskSchema).safeParse(res.body).success).toBe(true);
  });

  it('POST /instances/:id/tasks 非法 type → 40000（schema 枚举替代手写 validTypes）', async () => {
    const res = await request(getApp()).post('/api/v1/instances/demo/tasks').send({
      name: 'x', type: 'destroy-world', cronExpression: '0 4 * * *',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('GET /tasks 列表 → data 逐条通过 scheduledTaskSchema', async () => {
    const res = await request(getApp()).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    expect(apiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const item of res.body.data) {
      expect(scheduledTaskSchema.safeParse(item).success).toBe(true);
    }
  });

  it('GET /tasks/:id/history → data 逐条通过 taskRunHistorySchema（倒序）', async () => {
    const created = await request(getApp()).post('/api/v1/instances/demo/tasks').send({
      name: '历史契约', type: 'command', cronExpression: '0 5 * * *', command: 'say hi',
    });
    const taskId = created.body.data.id;
    db.prepare(
      "INSERT INTO task_run_history (task_id, run_at, status, error, duration_ms) VALUES (?, '2026-09-02 12:00:00', 'failed', 'RCON 不可用', 3000)"
    ).run(taskId);
    db.prepare(
      "INSERT INTO task_run_history (task_id, run_at, status, error, duration_ms) VALUES (?, '2026-09-02 12:05:00', 'success', NULL, 800)"
    ).run(taskId);

    const res = await request(getApp()).get(`/api/v1/tasks/${taskId}/history`);
    expect(res.status).toBe(200);
    expect(apiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data.length).toBe(2);
    expect(res.body.data[0].status).toBe('success');
    for (const item of res.body.data) {
      expect(taskRunHistorySchema.safeParse(item).success).toBe(true);
    }
  });
});

// ── 响应侧契约观测推广（#393）：players / status / backups 接入断言 ──

describe('响应契约：玩家路由 × banRecordSchema（#393 接入）', () => {
  it('GET /instances/:id/players/bans → data 逐条通过 banRecordSchema', async () => {
    db.prepare(
      "INSERT INTO temp_bans (instance_id, target_type, target, reason, expires_at, is_active) VALUES (?, 'player', 'Steve', '破坏行为', ?, 1)"
    ).run('demo', Date.now() + 3_600_000);
    db.prepare(
      "INSERT INTO temp_bans (instance_id, target_type, target, reason, expires_at, is_active) VALUES (?, 'ip', '1.2.3.4', '恶意攻击', ?, 1)"
    ).run('demo', Date.now() + 7_200_000);

    const app = express();
    app.use(express.json());
    // serverPath 指向不存在目录：banned-*.json 原版封禁文件读取走静默跳过分支
    const fakeManager = { getInstance: () => ({ id: 'demo', serverPath: './contract-test-nonexistent' }) };
    app.use('/api/v1', createPlayerRoutes(fakeManager));

    const res = await request(app).get('/api/v1/instances/demo/players/bans');
    expect(res.status).toBe(200);
    expect(apiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.data.length).toBe(2);
    for (const item of res.body.data) {
      expect(banRecordSchema.safeParse(item).success).toBe(true);
    }
  });
});

describe('响应契约：状态路由 × overviewDataSchema（#393 接入）', () => {
  it('GET /overview → 信封与 data 均通过 overviewDataSchema', async () => {
    const fakeManager = {
      instances: new Map(),
      getAllInstances: () => [
        { id: 'demo', name: '契约实例', isRunning: true, playerCount: 2 },
      ],
      getInstance: () => null,
    };
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createStatusRoutes(fakeManager));

    const res = await request(app).get('/api/v1/overview');
    expect(res.status).toBe(200);
    expect(apiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(overviewDataSchema.safeParse(res.body.data).success).toBe(true);
  });
});

describe('响应契约：备份路由 × backupItemSchema（#393 接入）', () => {
  it('GET /instances/:instanceId/backups → 信封 + pagination 可 parse，data 逐条通过 backupItemSchema', async () => {
    db.prepare(
      "INSERT INTO backups (instance_id, name, description, type, size, status, world_name, format) VALUES (?, ?, ?, 'manual', ?, 'completed', ?, 'snapshot')"
    ).run('demo', '契约快照', null, 1024, 'world');

    const app = express();
    app.use(express.json());
    app.use('/api/v1', createBackupRoutes({ getInstance: () => ({ id: 'demo' }) }));
    const { errorHandler } = await import('../middleware/error_handler.js');
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/instances/demo/backups');
    expect(res.status).toBe(200);
    expect(apiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.pagination).toBeDefined();
    for (const item of res.body.data) {
      expect(backupItemSchema.safeParse(item).success).toBe(true);
    }
  });
});
