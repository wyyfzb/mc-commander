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

// url-guard 真实实现 + 注入假 lookup：域名测试不触网（恒定解析到公网示例地址）
vi.mock('../utils/url-guard.js', async () => {
  const real = await vi.importActual('../utils/url-guard.js');
  return {
    checkPublicUrl: (url) => real.checkPublicUrl(url, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
  };
});

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

  it('POST /webhooks SSRF 防护（环回/私网 IP 字面量拒绝）', async () => {
    const blockedUrls = [
      'http://127.0.0.1/hook',
      'http://10.1.2.3/hook',
      'http://192.168.1.100/hook',
      'http://172.16.0.9/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0/hook',
      'http://[::1]/hook',
    ];
    for (const url of blockedUrls) {
      const res = await request(getApp()).post('/api/v1/webhooks').send({
        name: `SSRF ${url}`,
        url,
      });
      expect(res.status, `URL ${url} 应被拒绝`).toBe(400);
      expect(res.body.code).toBe(40010);
      expect(res.body.message).toContain('拒绝');
    }
  });

  it('POST /webhooks SSRF 防护（localhost 主机名拒绝）', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'SSRF localhost',
      url: 'http://localhost:8080/hook',
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

  it('PUT /webhooks/:id SSRF 防护（更新为私网 URL 拒绝）', async () => {
    const res = await request(getApp()).put('/api/v1/webhooks/1').send({
      url: 'http://192.168.0.50/hook',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40010);
    expect(res.body.message).toContain('拒绝');
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

  // 放行用例置于末尾：创建新记录会占用自增 id，避免影响前序用例的 id 约定
  it('POST /webhooks SSRF 防护（公网域名放行）', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Public Hook',
      url: 'https://hooks.example.com/webhook',
    });
    expect(res.status).toBe(200);
  });
});
