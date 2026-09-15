import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

// dataDir 指向临时目录（真实 SQLite，验证模型/路由/中间件全链路），
// 其余 config 保留实际值（authMiddleware 依赖真实 apiKeyHash）
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-auth-input-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminAccountModel } from '../db/admin.model.js';
import { hashPassword } from '../utils/password.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  createAuthRoutes,
  resetLoginLockState,
  _getLoginFailuresSize,
} from '../routes/auth.js';
import { errorHandler } from '../middleware/error_handler.js';

// 测试用明文 Key（与 vitest.config.js 中 API_KEY 一致）
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

beforeEach(() => {
  // 用例隔离：清空账号/会话/锁定状态
  db.prepare('DELETE FROM admin_sessions').run();
  db.prepare('DELETE FROM admin_account').run();
  resetLoginLockState();

  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use('/api/v1', createAuthRoutes());
  app.use(errorHandler);
});

/** 断言 validateBody 统一 400 信封：code 40000 + 结构化 details 指向目标字段 */
function expectValidationError(res, fieldPath) {
  expect(res.status).toBe(400);
  expect(res.body.status).toBe('error');
  expect(res.body.code).toBe(40000);
  expect(Array.isArray(res.body.details)).toBe(true);
  const paths = res.body.details.map((d) => d.path);
  expect(paths).toContain(fieldPath);
}

// 超时口径：冲突用例含 3 次 scrypt（N=131072，单次 ~2800ms），叠加同文件前一例的
// 密码哈希后，默认 5s 在并发争抢下余量过薄（实测三次命中）→ 显式 15s（与本仓 web 侧口径同值）。
describe('auth 输入侧契约 - POST /auth/setup（#428）', { timeout: 15_000 }, () => {
  it('缺失 password → 400 统一校验语义（不再落入 handler 隐式 undefined）', async () => {
    const res = await request(app).post('/api/v1/auth/setup').send({});
    expectValidationError(res, 'password');
  });

  it('password 非字符串（数字）→ 400', async () => {
    const res = await request(app).post('/api/v1/auth/setup').send({ password: 12345678 });
    expectValidationError(res, 'password');
  });

  it('未配置 SETUP_TOKEN 时请求体缺失 password → 400（无凭据头场景语义不变）', async () => {
    const res = await request(app).post('/api/v1/auth/setup').send();
    expectValidationError(res, 'password');
  });

  it('弱密码仍由路由层强度校验收口 → 400 且未改变未配置状态（schema 不越权）', async () => {
    const res = await request(app).post('/api/v1/auth/setup').send({ password: 'short' });
    expect(res.status).toBe(400);
    // 弱密码走路由层：错误码仍为 VALIDATION_ERROR，但 schema 形状校验已放行
    // （若 schema 越权加长度约束，此处 details 结构与路径将来自 zod 而非路由层）
    expect(res.body.code).toBe(40000);
    expect((await request(app).get('/api/v1/auth/status')).body.data.hasPassword).toBe(false);
  });

  it('合法密码 → 200 设密即登录（成功路径行为不变）', async () => {
    const res = await request(app).post('/api/v1/auth/setup').send({ password: 'setup-pass-9' });
    expect(res.status).toBe(200);
    expect(res.body.data.hasPassword).toBe(true);
    expect(res.body.data.token).toBeTruthy();
  });
});

describe('auth 输入侧契约 - POST /auth/login（#428）', { timeout: 15_000 }, () => {
  it('缺失 password → 400（形状校验，不计入失败锁定）', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({});
    expectValidationError(res, 'password');
    expect(_getLoginFailuresSize()).toBe(0);
  });

  it('password 非字符串（对象）→ 400 且不计入失败锁定', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ password: { $gt: '' } });
    expectValidationError(res, 'password');
    expect(_getLoginFailuresSize()).toBe(0);
  });

  it('弱密码（字符串）仍 401 并计入失败锁定——锁定挂靠点语义保持', async () => {
    AdminAccountModel.setPassword(hashPassword('known-pass-123'));
    const res = await request(app).post('/api/v1/auth/login').send({ password: 'short' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40102);
    expect(_getLoginFailuresSize()).toBe(1);
  });

  it('错误密码 401；正确密码 200（凭据语义零变化）', async () => {
    AdminAccountModel.setPassword(hashPassword('known-pass-123'));
    const wrong = await request(app).post('/api/v1/auth/login').send({ password: 'wrong-wrong' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe(40102);

    const ok = await request(app).post('/api/v1/auth/login').send({ password: 'known-pass-123' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.token).toBeTruthy();
  });
});

describe('auth 输入侧契约 - PUT /auth/password（#428）', { timeout: 15_000 }, () => {
  /** 预置账号并返回有效会话令牌 */
  async function loginToken(password = 'old-pass-1234') {
    AdminAccountModel.setPassword(hashPassword(password));
    const login = await request(app).post('/api/v1/auth/login').send({ password });
    return login.body.data.token;
  }

  it('缺失 newPassword → 400（认证后形状校验）', async () => {
    const token = await loginToken();
    const res = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'old-pass-1234' });
    expectValidationError(res, 'newPassword');
  });

  it('oldPassword 非字符串（数字）→ 400', async () => {
    const token = await loginToken();
    const res = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 12345678, newPassword: 'new-pass-5678' });
    expectValidationError(res, 'oldPassword');
  });

  it('旧密错误 + 新密弱 → 401（旧密校验先于新密强度，错误呈现顺序保持）', async () => {
    const token = await loginToken();
    const res = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'totally-wrong', newPassword: 'short' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40102);
  });

  it('旧密正确 + 新密弱 → 400（路由层强度校验收口）', async () => {
    const token = await loginToken();
    const res = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'old-pass-1234', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('合法改密 → 200 且新密码可登录（成功路径行为不变）', async () => {
    const token = await loginToken();
    const res = await request(app)
      .put('/api/v1/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'old-pass-1234', newPassword: 'new-pass-5678' });
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);

    const relogin = await request(app).post('/api/v1/auth/login').send({ password: 'new-pass-5678' });
    expect(relogin.status).toBe(200);
  });

  it('API Key 通道改密同样受形状校验约束（缺失字段 400）', async () => {
    AdminAccountModel.setPassword(hashPassword('old-pass-1234'));
    const res = await request(app)
      .put('/api/v1/auth/password')
      .set('X-API-Key', TEST_PLAINTEXT_KEY)
      .send({ oldPassword: 'old-pass-1234' });
    expectValidationError(res, 'newPassword');
  });
});
