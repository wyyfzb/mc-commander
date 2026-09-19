/**
 * Webhook 路由测试（supertest）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 系统临时目录（勿落服务端工作目录）：error-codes.contract.test.js 会递归扫描
// 该目录树，本文件建/删目录会与扫描并发撞 ENOENT，随机让整个契约检查变红
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-webhook-routes-'));
let db;

function createTestApp() {
  const app = express();
  app.use(express.json());

  // 绕过 auth middleware
  return app;
}

beforeAll(() => {
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
// audit 的 AuditActions 保留真实映射：路由内 action 字段才能拿到真实字面量（如 WEBHOOK_DELETE），
// 行为级断言可对齐 audit 语义而非 undefined 哨兵
vi.mock('../db/database.js', () => ({ getDb: () => db }));
vi.mock('../utils/audit.js', async () => {
  const real = await vi.importActual('../utils/audit.js');
  return { recordAudit: vi.fn(), AuditActions: real.AuditActions };
});

// WebhookService.testDelivery 网络行为由本文件接管：三分支（成功/失败/不触达）均需确定性返回，
// 其余 static 成员经原型链保留真实实现
vi.mock('../services/webhook.service.js', async () => {
  const real = await vi.importActual('../services/webhook.service.js');
  return {
    ...real,
    WebhookService: Object.create(real.WebhookService, {
      testDelivery: { value: vi.fn(), writable: true, configurable: true },
    }),
  };
});

// url-guard 真实实现 + 注入假 lookup：域名测试不触网（恒定解析到公网示例地址）
vi.mock('../utils/url-guard.js', async () => {
  const real = await vi.importActual('../utils/url-guard.js');
  return {
    checkPublicUrl: (url) =>
      real.checkPublicUrl(url, {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
  };
});

const { createWebhookRoutes } = await import('../routes/webhooks.js');
const { recordAudit } = await import('../utils/audit.js');
const { WebhookService } = await import('../services/webhook.service.js');
const recordAuditMock = vi.mocked(recordAudit);
const testDeliveryMock = vi.mocked(WebhookService.testDelivery);

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
    const res = await request(getApp())
      .post('/api/v1/webhooks')
      .send({
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
      const res = await request(getApp())
        .post('/api/v1/webhooks')
        .send({
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
    const res = await request(getApp())
      .post('/api/v1/webhooks')
      .send({
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
      name: 'To Delete',
      url: 'https://example.com/del',
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

  // ── 分页参数回归（parsePagination 统一收口，issue 388）──
  it('GET /webhooks 分页参数透传', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks?page=2&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.pageSize).toBe(5);
  });

  it('GET /webhooks page 越界钳制到 1000（webhooks 侧补齐上限，唯一行为加固）', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks?page=9999&pageSize=999');
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1000);
    expect(res.body.pagination.pageSize).toBe(200);
  });

  it('GET /webhooks 非法分页参数回落默认', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks?page=abc&pageSize=xyz');
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.pageSize).toBe(20);
  });
});

// ── 三子路由行为收口（#437）：DELETE /:id、POST /:id/test、GET /:id/deliveries ──
// 断言深度对齐行为而非 keyword 命中：404 分支、audit 记录语义、分页钳制上限逐项落点
describe('Webhook 三子路由行为收口', () => {
  beforeEach(() => {
    recordAuditMock.mockClear();
    testDeliveryMock.mockReset();
  });

  it('DELETE /webhooks/:id 不存在 → 404 WEBHOOK_NOT_FOUND（不产生 audit）', async () => {
    const res = await request(getApp()).delete('/api/v1/webhooks/9999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40410);
    expect(res.body.message).toBe('Webhook not found');
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('DELETE /webhooks/:id 成功 → WEBHOOK_DELETE audit 记录（action/targetType/targetId/detail 精确）', async () => {
    const createRes = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Audit Delete Hook',
      url: 'https://example.com/audit-del',
    });
    expect(createRes.status).toBe(200);
    const id = createRes.body.data.id;
    recordAuditMock.mockClear(); // 清掉创建时的 WEBHOOK_CREATE 记录，隔离断言作用域

    const res = await request(getApp()).delete(`/api/v1/webhooks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(res.body.message).toBe('Webhook 已删除');

    expect(recordAuditMock).toHaveBeenCalledTimes(1);
    const arg = recordAuditMock.mock.calls[0][0];
    expect(arg.action).toBe('WEBHOOK_DELETE');
    expect(arg.targetType).toBe('webhook');
    expect(arg.targetId).toBe(String(id));
    expect(arg.detail).toEqual({ name: 'Audit Delete Hook' });

    // 删除真实生效
    const getRes = await request(getApp()).get(`/api/v1/webhooks/${id}`);
    expect(getRes.status).toBe(404);
  });

  it('POST /webhooks/:id/test 不存在 → 404（不触达 WebhookService 与 audit）', async () => {
    const res = await request(getApp()).post('/api/v1/webhooks/9999/test');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40410);
    expect(testDeliveryMock).not.toHaveBeenCalled();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('POST /webhooks/:id/test 投递成功 → 200 + WEBHOOK_TEST audit(success=true)', async () => {
    const createRes = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Test OK Hook',
      url: 'https://example.com/test-ok',
    });
    const id = createRes.body.data.id;
    recordAuditMock.mockClear();
    testDeliveryMock.mockResolvedValue({ success: true, statusCode: 200, body: '{"ok":true}' });

    const res = await request(getApp()).post(`/api/v1/webhooks/${id}/test`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ statusCode: 200, body: '{"ok":true}' });
    expect(res.body.message).toBe('测试投递成功');

    expect(testDeliveryMock).toHaveBeenCalledTimes(1);
    expect(testDeliveryMock).toHaveBeenCalledWith(id);
    expect(recordAuditMock).toHaveBeenCalledTimes(1);
    const arg = recordAuditMock.mock.calls[0][0];
    expect(arg.action).toBe('WEBHOOK_TEST');
    expect(arg.targetType).toBe('webhook');
    expect(arg.targetId).toBe(String(id));
    expect(arg.detail).toEqual({ success: true, statusCode: 200 });
  });

  it('POST /webhooks/:id/test 投递失败 → 500 WEBHOOK_TEST_FAILED + audit(success=false)', async () => {
    const createRes = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Test Fail Hook',
      url: 'https://example.com/test-fail',
    });
    const id = createRes.body.data.id;
    recordAuditMock.mockClear();
    testDeliveryMock.mockResolvedValue({ success: false, error: 'connect ETIMEDOUT' });

    const res = await request(getApp()).post(`/api/v1/webhooks/${id}/test`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe(50010);
    expect(res.body.message).toBe('connect ETIMEDOUT');

    const arg = recordAuditMock.mock.calls[0][0];
    expect(arg.action).toBe('WEBHOOK_TEST');
    expect(arg.detail.success).toBe(false);
  });

  it('GET /webhooks/:id/deliveries 不存在 → 404 WEBHOOK_NOT_FOUND', async () => {
    const res = await request(getApp()).get('/api/v1/webhooks/9999/deliveries');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40410);
  });

  it('GET /webhooks/:id/deliveries 分页透传（page/pageSize/total/totalPages）+ 行转驼峰', async () => {
    const createRes = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Delivery Paging Hook',
      url: 'https://example.com/delivery-paging',
    });
    const id = createRes.body.data.id;
    const insert = db.prepare(
      'INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status, response_status, response_body, duration_ms, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 3; i++) {
      insert.run(id, 'ping', '{}', 'success', 200, '{"ok":true}', 100 + i, 1);
    }

    const res = await request(getApp()).get(`/api/v1/webhooks/${id}/deliveries?page=2&pageSize=2`);
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ total: 3, page: 2, pageSize: 2, totalPages: 2 });
    expect(res.body.data).toHaveLength(1);
    // ORDER BY id DESC：page=2 → 最后一行（最早插入的那条）
    expect(res.body.data[0].webhookId).toBe(id); // webhook_id → camelCase，证明走 model 层映射
    expect(res.body.data[0].eventType).toBe('ping');
    expect(res.body.data[0].responseStatus).toBe(200);
  });

  it('GET /webhooks/:id/deliveries pageSize=999 钳制到 maxPageSize=200', async () => {
    const createRes = await request(getApp()).post('/api/v1/webhooks').send({
      name: 'Delivery Clamp Hook',
      url: 'https://example.com/delivery-clamp',
    });
    const id = createRes.body.data.id;

    const res = await request(getApp()).get(
      `/api/v1/webhooks/${id}/deliveries?page=1&pageSize=999`,
    );
    expect(res.status).toBe(200);
    expect(res.body.pagination.pageSize).toBe(200);
    expect(res.body.pagination.total).toBe(0);
  });

  // ── PUT 链路缺口补齐（覆盖率收口：404 / validateUrl catch / 事件白名单）──
  it('PUT /webhooks/:id 不存在 → 404 WEBHOOK_NOT_FOUND', async () => {
    const res = await request(getApp()).put('/api/v1/webhooks/9999').send({ name: 'Nope' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40410);
  });

  it('PUT /webhooks/:id 非法 URL（new URL 抛异常路径）→ 400 WEBHOOK_INVALID_URL', async () => {
    const res = await request(getApp()).put('/api/v1/webhooks/1').send({ url: 'not a url at all' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40010);
  });

  it('PUT /webhooks/:id 事件类型白名单 → 400 WEBHOOK_INVALID_EVENTS', async () => {
    const res = await request(getApp())
      .put('/api/v1/webhooks/1')
      .send({ events: ['not.real.event'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40011);
  });

  it('PUT /webhooks/:id 公网 URL + isEnabled 更新成功 → 200 + WEBHOOK_UPDATE audit（SSRF 校验通过路径）', async () => {
    const res = await request(getApp()).put('/api/v1/webhooks/1').send({
      url: 'https://hooks.example.com/updated',
      isEnabled: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe('https://hooks.example.com/updated');
    expect(res.body.data.isEnabled).toBe(false);

    const arg = recordAuditMock.mock.calls[0][0];
    expect(arg.action).toBe('WEBHOOK_UPDATE');
    expect(arg.targetType).toBe('webhook');
    expect(arg.targetId).toBe('1');
    // detail.name 取更新后模型返回值：id=1 已在既有用例更名为 'Updated Hook'，本用例未改 name
    expect(arg.detail).toEqual({ name: 'Updated Hook' });
  });
});
