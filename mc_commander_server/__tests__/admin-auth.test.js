import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// dataDir 指向临时目录（真实 SQLite，验证模型/路由/中间件全链路），
// 其余 config 保留实际值（authMiddleware 依赖真实 apiKey）
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-admin-auth-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase, getDb } from '../db/index.js';
import { AdminAccountModel, AdminSessionModel } from '../db/admin.model.js';
import { hashPassword, verifyPassword, hashToken, generateSessionToken } from '../utils/password.js';
import { authMiddleware } from '../middleware/auth.js';
import { createAuthRoutes, resetLoginLockState } from '../routes/auth.js';
import { errorHandler } from '../middleware/error_handler.js';

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
  app.get('/api/v1/protected', (req, res) => res.json({ ok: true, auth: req.auth ?? null }));
  app.use(errorHandler);
});

describe('utils/password', () => {
  it('hash → verify 往返成功，参数自描述', () => {
    const stored = hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('错误密码 / 损坏存储格式一律 false（不抛出）', () => {
    const stored = hashPassword('secret-pass-1');
    expect(verifyPassword('wrong-pass', stored)).toBe(false);
    expect(verifyPassword('secret-pass-1', 'not-a-valid-hash')).toBe(false);
    expect(verifyPassword('secret-pass-1', 'md5$1$2$3$xx$yy')).toBe(false);
  });

  it('hashToken 稳定 64 位 hex；generateSessionToken 高熵', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });
});

describe('认证中间件', () => {
  it('X-API-Key 通道保持兼容（req.auth.source = apiKey）', async () => {
    const res = await request(app).get('/api/v1/protected').set('X-API-Key', config.apiKey);
    expect(res.status).toBe(200);
    expect(res.body.auth.source).toBe('apiKey');
  });

  it('无凭据 401；非法 API Key 401；空 Bearer 401', async () => {
    expect((await request(app).get('/api/v1/protected')).status).toBe(401);
    expect((await request(app).get('/api/v1/protected').set('X-API-Key', 'wrong')).status).toBe(401);
    expect((await request(app).get('/api/v1/protected').set('Authorization', 'Bearer ')).status).toBe(401);
  });

  it('Bearer 会话通道：有效令牌通过并标记 source=session', async () => {
    const token = generateSessionToken();
    AdminSessionModel.create({
      tokenHash: hashToken(token),
      userAgent: 'vitest',
      ip: '127.0.0.1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await request(app).get('/api/v1/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.auth.source).toBe('session');
  });

  it('Bearer：伪造令牌 401（AUTH_SESSION_EXPIRED）', async () => {
    const res = await request(app).get('/api/v1/protected').set('Authorization', 'Bearer forged-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40103);
  });

  it('Bearer：过期会话 401 且过期行被清理', async () => {
    const token = generateSessionToken();
    const session = AdminSessionModel.create({
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // 已过期
    });
    const res = await request(app).get('/api/v1/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40103);
    expect(AdminSessionModel.getById(session.id)).toBeNull();
  });
});

describe('认证路由 - status/setup', () => {
  it('status 公开可达：未设密 false → 设密后 true（全程无需认证）', async () => {
    const before = await request(app).get('/api/v1/auth/status');
    expect(before.status).toBe(200);
    expect(before.body.data.hasPassword).toBe(false);

    const setup = await request(app).post('/api/v1/auth/setup').send({ password: 'setup-pass-9' });
    expect(setup.status).toBe(200);
    expect(setup.body.data.hasPassword).toBe(true);
    expect(setup.body.data.token).toBeTruthy(); // 设密即登录

    const after = await request(app).get('/api/v1/auth/status');
    expect(after.body.data.hasPassword).toBe(true);

    // 回归：全局认证动作的审计必须落库（v8 迁移前 instance_id NOT NULL
    // 导致写入被 recordAudit 静默吞掉——KEY_ROTATE 同病）
    const audits = db.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'AUTH_SETUP' AND instance_id IS NULL",
    ).get();
    expect(audits.n).toBe(1);
  });

  it('setup 弱密码 400 且不改变未配置状态', async () => {
    const weak = await request(app).post('/api/v1/auth/setup').send({ password: 'short' });
    expect(weak.status).toBe(400);
    expect((await request(app).get('/api/v1/auth/status')).body.data.hasPassword).toBe(false);
  });

  it('setup 已设密时 409（AUTH_ALREADY_CONFIGURED）', async () => {
    await request(app).post('/api/v1/auth/setup').send({ password: 'setup-pass-9' });
    const dup = await request(app).post('/api/v1/auth/setup').send({ password: 'whatever-99' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe(40911);
  });
});

describe('认证路由 - login/logout/sessions', () => {
  it('未设密时登录 400（AUTH_NOT_CONFIGURED）', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ password: 'whatever-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40013);
  });

  it('login 错误密码 401；正确密码换令牌并可用', async () => {
    AdminAccountModel.setPassword(hashPassword('known-pass-123'));

    const wrong = await request(app).post('/api/v1/auth/login').send({ password: 'wrong-wrong' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe(40102);

    const login = await request(app).post('/api/v1/auth/login').send({ password: 'known-pass-123' });
    expect(login.status).toBe(200);
    expect(login.body.data.token).toBeTruthy();
    expect(login.body.data.expiresAt).toBeTruthy();
    expect(login.body.data.sessionId).toBeTruthy();

    const res = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${login.body.data.token}`);
    expect(res.status).toBe(200);
  });

  it('logout：会话登出后令牌失效；API Key 通道登出 400', async () => {
    AdminAccountModel.setPassword(hashPassword('known-pass-123'));
    const login = await request(app).post('/api/v1/auth/login').send({ password: 'known-pass-123' });
    const { token } = login.body.data;

    const logout = await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(200);

    const after = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);

    const viaKey = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-API-Key', config.apiKey);
    expect(viaKey.status).toBe(400);
  });

  it('sessions 列表：多会话可见且 current 标记正确；踢出目标会话', async () => {
    AdminAccountModel.setPassword(hashPassword('known-pass-123'));
    const a = (await request(app).post('/api/v1/auth/login').send({ password: 'known-pass-123' })).body.data;
    const b = (await request(app).post('/api/v1/auth/login').send({ password: 'known-pass-123' })).body.data;

    const list = await request(app)
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${a.token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.sessions).toHaveLength(2);
    const flags = list.body.data.sessions.map((s) => s.current);
    expect(flags.filter(Boolean)).toHaveLength(1);

    // 踢掉 b（从 a 的视角操作）
    const kick = await request(app)
      .delete(`/api/v1/auth/sessions/${b.sessionId}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(kick.status).toBe(200);
    expect(kick.body.data.current).toBe(false);

    // b 的令牌失效；踢不存在的会话 404
    expect(
      (await request(app).get('/api/v1/protected').set('Authorization', `Bearer ${b.token}`)).status,
    ).toBe(401);
    const missing = await request(app)
      .delete('/api/v1/auth/sessions/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${a.token}`);
    expect(missing.status).toBe(404);
  });
});

describe('认证路由 - 改密与登录锁定', () => {
  it('改密：验旧密；成功后其余会话被踢、当前保留；新密码可登录', async () => {
    AdminAccountModel.setPassword(hashPassword('old-pass-1234'));
    const a = (await request(app).post('/api/v1/auth/login').send({ password: 'old-pass-1234' })).body.data;
    const b = (await request(app).post('/api/v1/auth/login').send({ password: 'old-pass-1234' })).body.data;

    const wrongOld = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ oldPassword: 'totally-wrong', newPassword: 'new-pass-5678' });
    expect(wrongOld.status).toBe(401);

    const weak = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ oldPassword: 'old-pass-1234', newPassword: 'short' });
    expect(weak.status).toBe(400);

    const change = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ oldPassword: 'old-pass-1234', newPassword: 'new-pass-5678' });
    expect(change.status).toBe(200);
    expect(change.body.data.kickedSessions).toBe(1); // 只有 b 被踢

    expect(
      (await request(app).get('/api/v1/protected').set('Authorization', `Bearer ${a.token}`)).status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/v1/protected').set('Authorization', `Bearer ${b.token}`)).status,
    ).toBe(401);

    const relogin = await request(app).post('/api/v1/auth/login').send({ password: 'new-pass-5678' });
    expect(relogin.status).toBe(200);
  });

  it('login 失败锁定：连续失败达阈值 429，正确密码也被拒；重置后恢复', async () => {
    AdminAccountModel.setPassword(hashPassword('lock-test-pass'));
    for (let i = 0; i < config.adminSession.loginLockMaxFails; i++) {
      await request(app).post('/api/v1/auth/login').send({ password: `bad-${i}` });
    }
    const locked = await request(app).post('/api/v1/auth/login').send({ password: 'lock-test-pass' });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe(42901);

    // 测试钩子清空锁定后恢复（生产中随进程重启自然清零）
    resetLoginLockState();
    const ok = await request(app).post('/api/v1/auth/login').send({ password: 'lock-test-pass' });
    expect(ok.status).toBe(200);
  });
});
