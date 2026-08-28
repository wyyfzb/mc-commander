/**
 * Webhook 路由测试（supertest）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TEST_DIR = './test-webhook-routes-data';
let db;

function createTestApp() {
  const app = express();
  app.use(express.json());

  // 绕过 auth middleware
  return app;
}

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
    secret TEXT, events TEXT DEFAULT '[]', instance_id TEXT, is_enabled INTEGER DEFAULT 1,
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
  db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL,
    action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT,
    source TEXT DEFAULT 'api', created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// Mock database.js and audit.js
import { vi } from 'vitest';
vi.mock('../db/database.js', () => ({ getDb: () => db }));
vi.mock('../utils/audit.js', () => ({ recordAudit: vi.fn(), AuditActions: {} }));

const { createWebhookRoutes } = await import('../routes/webhooks.js');

function getApp() {
  const app = createTestApp();
  app.use('/api/v1', createWebhookRoutes());
  return app;
}

describe('Webhook 路由', () => {
  it('GET /webhooks/event-types 返回 19 种事件', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks/event-types');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(19);
    expect(res.body.data).toContain('player.join');
    expect(res.body.data).toContain('ping');
  });

  it('POST /webhooks 创建成功', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Test Hook',
      url: 'https://example.com/webhook',
      secret: 's3cret',
      events: ['player.join', 'player.death'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Test Hook');
    expect(res.body.data.secret).toBe('********');
    expect(res.body.data.events).toEqual(['player.join', 'player.death']);
  });

  it('POST /webhooks URL 校验（非 http/https 拒绝）', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Bad URL',
      url: 'ftp://evil.com/hook',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40010);
  });

  it('POST /webhooks 事件类型白名单校验', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Bad Events',
      url: 'https://example.com/hook',
      events: ['not.a.real.event'],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40011);
  });

  it('GET /webhooks 列表', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
  });

  it('GET /webhooks/:id 详情', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks/1');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(1);
  });

  it('GET /webhooks/:id 不存在', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks/9999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40410);
  });

  it('PUT /webhooks/:id 更新', async () => {
    const res = await request(getApp()).put('/api/v1/webhooks/1').send({
      name: 'Updated Hook',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated Hook');
  });

  it('DELETE /webhooks/:id 删除', async () => {
    // 先创建一个待删的
    await request(getApp()).post('/api/v1/webhooks').send({
      name: 'To Delete', url: 'https://example.com/del',
    });
    const res = await request(getApp()).delete('/api/v1/webhooks/2');
    expect(res.status).toBe(200);
    // 确认已删
    const getRes = await request(getApp()).get('/api/v1/webhooks/2');
    expect(getRes.status).toBe(404);
  });

  it('GET /webhooks/:id/deliveries 投递日志', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks/1/deliveries');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeDefined();
  });
});
