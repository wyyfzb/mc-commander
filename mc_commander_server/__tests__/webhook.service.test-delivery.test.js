/**
 * WebhookService.testDelivery 落库测试（issue #356）
 * 验收：成功 / 非 2xx / 网络异常 三路径均落一条 event_type=ping 的投递记录；
 * SSRF 拦截与 webhook 不存在发生在投递尝试前，不落记录。
 * got / url-guard / getDb 全 mock：不触网，真实 better-sqlite3 断言落库。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TEST_DIR = './test-webhook-test-delivery-data';
let db;

const { postImpl, guardImpl } = vi.hoisted(() => ({
  postImpl: { current: null },
  guardImpl: { current: null },
}));

vi.mock('got', () => ({
  default: { post: (...args) => postImpl.current(...args) },
}));

vi.mock('../utils/url-guard.js', () => ({
  checkPublicUrl: (...args) => guardImpl.current(...args),
}));

vi.mock('../db/database.js', () => ({ getDb: () => db }));

beforeAll(() => {
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL,
    secret TEXT, events TEXT DEFAULT '[]', instance_id TEXT, is_enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id INTEGER NOT NULL,
    event_type TEXT NOT NULL, instance_id TEXT, payload TEXT,
    status TEXT DEFAULT 'pending', response_status INTEGER, response_body TEXT,
    duration_ms INTEGER, attempts INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
  )`);

  // 默认：url guard 放行 + got 可按用例覆写
  guardImpl.current = async () => ({ ok: true });
  postImpl.current = async () => ({ statusCode: 200, body: 'ok' });
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const { WebhookService } = await import('../services/webhook.service.js');
const { WebhookModel } = await import('../db/webhook.model.js');

/** 只取该 webhook 的投递记录（按创建序） */
function deliveriesOf(webhookId) {
  return db
    .prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id')
    .all(webhookId);
}

describe('WebhookService.testDelivery 落库（issue #356）', () => {
  let hook;

  beforeAll(() => {
    hook = WebhookModel.create({
      name: 'Test Hook',
      url: 'https://example.com/hook',
      secret: 's3cret',
      events: ['player.join'],
    });
  });

  it('2xx 成功路径：返回 success + 落 status=success 记录（event_type=ping）', async () => {
    postImpl.current = async () => ({ statusCode: 200, body: '{"ok":true}' });

    const result = await WebhookService.testDelivery(hook.id);
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('{"ok":true}');

    const rows = deliveriesOf(hook.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.event_type).toBe('ping');
    expect(row.status).toBe('success');
    expect(row.response_status).toBe(200);
    expect(row.response_body).toBe('{"ok":true}');
    expect(row.attempts).toBe(1);
    expect(typeof row.duration_ms).toBe('number');
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    // payload 已记录（ping 测试报文）
    expect(JSON.parse(row.payload).event).toBe('ping');
  });

  it('非 2xx 路径（throwHttpErrors=false）：返回 success=false + 落 failed 记录含响应码', async () => {
    postImpl.current = async () => ({ statusCode: 503, body: 'Service Unavailable' });

    const result = await WebhookService.testDelivery(hook.id);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(503);

    const rows = deliveriesOf(hook.id);
    expect(rows).toHaveLength(2);
    const row = rows[1];
    expect(row.event_type).toBe('ping');
    expect(row.status).toBe('failed');
    expect(row.response_status).toBe(503);
    expect(row.response_body).toBe('Service Unavailable');
  });

  it('网络异常路径：返回 error + 落 failed 记录（response_status 空、body 记错误信息）', async () => {
    postImpl.current = async () => {
      throw new Error('ETIMEDOUT');
    };

    const result = await WebhookService.testDelivery(hook.id);
    expect(result.success).toBe(false);
    expect(result.error).toBe('ETIMEDOUT');

    const rows = deliveriesOf(hook.id);
    expect(rows).toHaveLength(3);
    const row = rows[2];
    expect(row.event_type).toBe('ping');
    expect(row.status).toBe('failed');
    expect(row.response_status).toBeNull();
    expect(row.response_body).toBe('ETIMEDOUT');
  });

  it('SSRF 拦截（投递尝试前）：返回 error 且不落任何记录', async () => {
    const before = deliveriesOf(hook.id).length;
    guardImpl.current = async () => ({ ok: false, reason: '私网地址被拒绝' });
    const postSpy = vi.fn(async () => ({ statusCode: 200, body: 'ok' }));
    postImpl.current = postSpy;

    const result = await WebhookService.testDelivery(hook.id);
    expect(result.success).toBe(false);
    expect(result.error).toBe('私网地址被拒绝');
    expect(postSpy).not.toHaveBeenCalled();
    expect(deliveriesOf(hook.id)).toHaveLength(before);

    // 恢复放行
    guardImpl.current = async () => ({ ok: true });
  });

  it('webhook 不存在：返回 error 且不落记录', async () => {
    const before = deliveriesOf(hook.id).length;
    const result = await WebhookService.testDelivery(999999);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Webhook not found');
    expect(deliveriesOf(hook.id)).toHaveLength(before);
  });
});
