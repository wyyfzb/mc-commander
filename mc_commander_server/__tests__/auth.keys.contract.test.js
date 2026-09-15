/**
 * 契约测试：auth/keys 路由响应接入 validatedSuccess 观测（issue 414）
 *
 * 用 supertest 实打实打路由（真实 model + SQLite 临时库），断言各成功响应
 * data 可被 @mc-commander/schemas auth 域 schema parse——session/apiKey 属
 * 安全敏感出参，schema 白名单化后的回归防护（结构漂移即观测告警）。
 * rotate-key 沿用 keys.test.js 的 fs spy 模式：阻断真实 .env 写入。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsMod = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mcs-auth-contract-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminSessionModel } from '../db/admin.model.js';
import { hashToken } from '../utils/password.js';
import { authMiddleware } from '../middleware/auth.js';
import { createAuthRoutes, resetLoginLockState } from '../routes/auth.js';
import { createKeyRoutes } from '../routes/keys.js';
import { errorHandler } from '../middleware/error_handler.js';
import {
  authStatusResponseSchema,
  authSetupResponseSchema,
  authSessionResponseSchema,
  authPasswordChangeResponseSchema,
  authLogoutResponseSchema,
  authSessionsResponseSchema,
  authSessionKickResponseSchema,
  apiKeyRotateResponseSchema,
} from '@mc-commander/schemas';

const TEST_PLAINTEXT_KEY = 'test-api-key-for-unit-tests';
const SETUP_PASSWORD = 'setup-pass-9';

let app;
let db;

beforeAll(() => {
  db = initDatabase();
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 用例隔离：清空账号/会话/锁定状态
  db.prepare('DELETE FROM admin_sessions').run();
  db.prepare('DELETE FROM admin_account').run();
  resetLoginLockState();

  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use('/api/v1', createAuthRoutes());
  app.use('/api', createKeyRoutes());
  app.use(errorHandler);
});

/** 设密并登录拿会话令牌（公共前置） */
async function setupAndLogin() {
  await request(app).post('/api/v1/auth/setup').send({ password: SETUP_PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ password: SETUP_PASSWORD });
  return login.body.data.token;
}

// 超时口径：setup+login 链路每例含 2~3 次 scrypt（N=131072，单次 ~2800ms），
// 并发争抢下默认 5s 余量过薄 → 显式 15s（与本仓 web 侧口径同值）。
describe('auth/keys 响应契约（validatedSuccess 观测）', { timeout: 15_000 }, () => {
  it('GET /auth/status：未设密 hasPassword=false 可 parse', async () => {
    const res = await request(app).get('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(authStatusResponseSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.hasPassword).toBe(false);
  });

  it('POST /auth/setup：设密即登录（hasPassword=true + 会话三字段）', async () => {
    const res = await request(app).post('/api/v1/auth/setup').send({ password: SETUP_PASSWORD });
    expect(res.status).toBe(200);
    const parsed = authSetupResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data.hasPassword).toBe(true);
    // sessionId 为 UUID 字符串（与 sessions 列表条目 id 同型）
    expect(parsed.data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('POST /auth/login：会话三字段（token/sessionId/expiresAt）', async () => {
    await request(app).post('/api/v1/auth/setup').send({ password: SETUP_PASSWORD });
    const res = await request(app).post('/api/v1/auth/login').send({ password: SETUP_PASSWORD });
    expect(res.status).toBe(200);
    expect(authSessionResponseSchema.safeParse(res.body.data).success).toBe(true);
  });

  it('PUT /auth/password：改密响应（ok 恒 true + kickedSessions 数值）', async () => {
    const token = await setupAndLogin();
    const res = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: SETUP_PASSWORD, newPassword: 'new-pass-12345' });
    expect(res.status).toBe(200);
    const parsed = authPasswordChangeResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data.ok).toBe(true);
    expect(typeof parsed.data.kickedSessions).toBe('number');
  });

  it('GET /auth/sessions：列表条目含 current 标记', async () => {
    const token = await setupAndLogin();
    const res = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const parsed = authSessionsResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data.sessions.length).toBeGreaterThan(0);
    expect(parsed.data.sessions.some((s) => s.current)).toBe(true);
  });

  it('POST /auth/logout：ok 恒 true', async () => {
    const token = await setupAndLogin();
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(authLogoutResponseSchema.safeParse(res.body.data).success).toBe(true);
  });

  it('DELETE /auth/sessions/:id：ok + current 布尔（踢非当前会话）', async () => {
    const token = await setupAndLogin();
    const second = AdminSessionModel.create({
      tokenHash: hashToken('second-session-token'),
      userAgent: 'vitest-second',
      ip: '127.0.0.1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await request(app)
      .delete(`/api/v1/auth/sessions/${second.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const parsed = authSessionKickResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data.current).toBe(false);
  });

  it('POST /rotate-key：apiKey 白名单单字段 + 提示语保留（fs spy 阻断真实 .env 写入）', async () => {
    const originalHash = config.apiKeyHash;
    config.apiKeyHash = hashToken(TEST_PLAINTEXT_KEY);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post('/api/rotate-key')
        .set('x-api-key', TEST_PLAINTEXT_KEY);
      expect(res.status).toBe(200);
      expect(apiKeyRotateResponseSchema.safeParse(res.body.data).success).toBe(true);
      expect(res.body.data.apiKey).toMatch(/^mcck-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/);
      expect(res.body.message).toContain('API Key 已轮换');
    } finally {
      config.apiKeyHash = originalHash;
      vi.restoreAllMocks();
    }
  });
});
