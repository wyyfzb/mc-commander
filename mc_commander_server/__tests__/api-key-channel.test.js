import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

// dataDir 指向临时目录（真实 SQLite）：会话通道要真会话才能验证「Key 关闭后
// 会话仍可用」与「不静默回退」两条语义
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsMod = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mcs-api-key-channel-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminSessionModel } from '../db/admin.model.js';
import { authMiddleware, authenticateWebSocket } from '../middleware/auth.js';
import { hashToken, generateSessionToken } from '../utils/password.js';

// 测试用明文 Key（对应 vitest.config.js 注入的 API_KEY_HASH，虚拟值）
const TEST_PLAINTEXT_KEY = 'test-api-key-for-unit-tests';

let app;
let db;

beforeAll(() => {
  db = initDatabase();
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

const originalApiKeyEnabled = config.apiKeyEnabled;

beforeEach(() => {
  db.prepare('DELETE FROM admin_sessions').run();
  config.apiKeyEnabled = originalApiKeyEnabled;
  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.get('/api/v1/protected', (req, res) => res.json({ ok: true, auth: req.auth ?? null }));
});

afterEach(() => {
  config.apiKeyEnabled = originalApiKeyEnabled;
});

function seedSession() {
  const token = generateSessionToken();
  AdminSessionModel.create({
    tokenHash: hashToken(token),
    userAgent: 'vitest-api-key-channel',
    ip: '127.0.0.1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return token;
}

describe('API_KEY_ENABLED=true（默认）：既有行为不变', () => {
  it('X-API-Key 请求照常通过，req.auth.source = apiKey', async () => {
    const res = await request(app).get('/api/v1/protected').set('X-API-Key', TEST_PLAINTEXT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.auth.source).toBe('apiKey');
  });

  it('错误 Key 仍是 401/40101（不是 403/关闭提示）', async () => {
    const res = await request(app).get('/api/v1/protected').set('X-API-Key', 'wrong-key');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40101);
  });

  it('WS 握手：Key 通道可用', () => {
    expect(authenticateWebSocket(TEST_PLAINTEXT_KEY, null)).toEqual({ role: 'admin' });
    expect(authenticateWebSocket('wrong-key', null)).toBe(null);
  });
});

describe('API_KEY_ENABLED=false：API Key 通道 fail-closed', () => {
  beforeEach(() => {
    config.apiKeyEnabled = false;
  });

  it('携带 API Key 的 HTTP 请求 403/40303，提示改用会话登录', async () => {
    const res = await request(app).get('/api/v1/protected').set('X-API-Key', TEST_PLAINTEXT_KEY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40303);
    expect(res.body.message).toContain('会话登录');
    // 关闭语义下不再区分 Key 对错（不给「Key 是否正确」的探测面）
    const wrong = await request(app).get('/api/v1/protected').set('X-API-Key', 'wrong-key');
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe(40303);
  });

  it('同时带 Key 与会话令牌也拒绝：不回退到会话通道（通道关闭即不可用）', async () => {
    const token = seedSession();
    const res = await request(app)
      .get('/api/v1/protected')
      .set('X-API-Key', TEST_PLAINTEXT_KEY)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40303);
  });

  it('只带会话令牌的请求不受影响（浏览器通道是唯一正常入口）', async () => {
    const token = seedSession();
    const res = await request(app).get('/api/v1/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.auth.source).toBe('session');
  });

  it('无凭据：401 AUTH_CREDENTIALS_REQUIRED(40107)，与「凭据无效」的 40101 分开', async () => {
    const res = await request(app).get('/api/v1/protected');
    expect(res.status).toBe(401);
    // 定向文案：不带凭据不该提示「Key 无效或已过期」（那会引导用户去
    // 轮换一把其实没问题的 Key），故用独立码 40107
    expect(res.body.code).toBe(40107);
    expect(res.body.message).toContain('未提供访问凭据');
  });

  it('空白 X-API-Key（`""` / `"   "`）同按「未提供凭据」处理：40107 而非 40101', async () => {
    // 脚本从环境变量取值、变量未设置时会发出空 header——报 40101 会把「没配好凭据」
    // 误导成「Key 无效」，与定向文案（#19）的意图相反
    for (const raw of ['', '   ']) {
      const res = await request(app).get('/api/v1/protected').set('X-API-Key', raw);
      expect(res.status, `header=${JSON.stringify(raw)}`).toBe(401);
      expect(res.body.code, `header=${JSON.stringify(raw)}`).toBe(40107);
    }
  });

  it('WS 握手：Key 一律 false，会话令牌照常通过', () => {
    const token = seedSession();
    expect(authenticateWebSocket(TEST_PLAINTEXT_KEY, null)).toBe(null);
    // 与会话令牌同时提供也不回退（与 HTTP 同款 fail-closed）
    expect(authenticateWebSocket(TEST_PLAINTEXT_KEY, token)).toBe(null);
    expect(authenticateWebSocket(null, token)).toEqual({ role: 'admin' });
  });
});
