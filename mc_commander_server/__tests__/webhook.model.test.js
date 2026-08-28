import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TEST_DIR = './test-webhook-model-data';

let db;

beforeAll(() => {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 建表（手写最小 schema，不依赖 database.js）
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'stopped',
      server_path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
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
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

import { vi } from 'vitest';

// 顶层 mock database.js 的 getDb
vi.mock('../db/database.js', () => {
  return {
    getDb: () => db,
  };
});

// 现在 import model（会使用 mocked getDb）
const { WebhookModel } = await import('../db/webhook.model.js');

describe('WebhookModel', () => {
  it('create + findById（secret 脱敏）', () => {
    const w = WebhookModel.create({
      name: 'test-webhook',
      url: 'https://example.com/hook',
      secret: 'my-secret-key',
      events: ['player.join', 'instance.start'],
    });
    expect(w.id).toBe(1);
    expect(w.name).toBe('test-webhook');
    expect(w.url).toBe('https://example.com/hook');
    expect(w.secret).toBe('********'); // 脱敏
    expect(w.events).toEqual(['player.join', 'instance.start']);
    expect(w.isEnabled).toBe(true);
    expect(w.instanceId).toBeNull();
  });

  it('findByIdInternal 返回原始 secret', () => {
    const w = WebhookModel.findByIdInternal(1);
    expect(w.secret).toBe('my-secret-key'); // 不脱敏
  });

  it('findAll 分页', () => {
    WebhookModel.create({ name: 'w2', url: 'https://b.com/hook' });
    const result = WebhookModel.findAll({ page: 1, pageSize: 10 });
    expect(result.total).toBe(2);
    expect(result.webhooks).toHaveLength(2);
    expect(result.webhooks[0].id).toBe(2); // DESC
  });

  it('update secret 逻辑', () => {
    const updated = WebhookModel.update(1, { secret: 'new-secret' });
    expect(updated.secret).toBe('********'); // 脱敏
    const raw = WebhookModel.findByIdInternal(1);
    expect(raw.secret).toBe('new-secret');
  });

  it('update name + events', () => {
    const updated = WebhookModel.update(1, {
      name: 'renamed',
      events: ['player.death'],
    });
    expect(updated.name).toBe('renamed');
    expect(updated.events).toEqual(['player.death']);
  });

  it('delete 级联删除投递日志', () => {
    WebhookModel.createDelivery({ webhookId: 1, eventType: 'ping', payload: { test: true }, status: 'success' });
    WebhookModel.createDelivery({ webhookId: 2, eventType: 'ping', payload: { test: true }, status: 'pending' });
    expect(WebhookModel.delete(2)).toBe(true);
    // webhook 2 的投递日志也应被级联删除
    const dels = WebhookModel.findDeliveries({ webhookId: 2 });
    expect(dels.total).toBe(0);
    // webhook 1 的投递日志不受影响
    const dels1 = WebhookModel.findDeliveries({ webhookId: 1 });
    expect(dels1.total).toBe(1);
  });

  it('delete 不存在的 webhook 返回 false', () => {
    expect(WebhookModel.delete(9999)).toBe(false);
  });

  it('findAllEnabled 只返回启用的 webhook（原始 secret）', () => {
    // id=1 仍启用, 再创建一个禁用的
    WebhookModel.create({ name: 'disabled', url: 'https://c.com/hook', isEnabled: false, secret: 'dis-secret' });
    const enabled = WebhookModel.findAllEnabled();
    // id=1 (enabled), id=3 (disabled) — 但 id=2 已被删除
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe(1);
    expect(enabled[0].secret).toBe('new-secret'); // 原始 secret
  });

  it('delivery CRUD + 分页', () => {
    const dId = WebhookModel.createDelivery({
      webhookId: 1, eventType: 'player.join', instanceId: 'inst-1',
      payload: { player: 'Steve' }, status: 'pending',
    });
    expect(dId).toBeGreaterThan(0);

    WebhookModel.updateDelivery(dId, { status: 'success', responseStatus: 200, durationMs: 150 });
    const dels = WebhookModel.findDeliveries({ webhookId: 1, page: 1, pageSize: 10 });
    expect(dels.total).toBe(2); // 之前有 1 个 + 现在新增 1 个
    const latest = dels.deliveries[0];
    expect(latest.status).toBe('success');
    expect(latest.responseStatus).toBe(200);
    expect(latest.durationMs).toBe(150);
    expect(latest.eventType).toBe('player.join');
    expect(latest.payload).toEqual({ player: 'Steve' });
  });

  it('findDeliveries 按 eventType 过滤', () => {
    WebhookModel.createDelivery({ webhookId: 1, eventType: 'instance.start', payload: {}, status: 'pending' });
    const result = WebhookModel.findDeliveries({ webhookId: 1, eventType: 'instance.start' });
    expect(result.total).toBe(1);
    expect(result.deliveries[0].eventType).toBe('instance.start');
  });

  it('findDeliveries 按 status 过滤', () => {
    const result = WebhookModel.findDeliveries({ webhookId: 1, status: 'success' });
    expect(result.total).toBe(2);
  });

  it('pruneDeliveries 清理旧投递日志', () => {
    // 插入一个「旧」投递日志（直接 SQL 模拟）
    db.prepare(`
      INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status, created_at)
      VALUES (?, 'ping', '{}', 'success', '2020-01-01T00:00:00Z')
    `).run(1);
    const pruned = WebhookModel.pruneDeliveries(30);
    expect(pruned).toBeGreaterThanOrEqual(1);
  });
});
