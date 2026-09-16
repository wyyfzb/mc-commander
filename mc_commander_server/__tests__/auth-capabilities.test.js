/**
 * GET /api/v1/auth/capabilities —— 部署能力探测端点
 *
 * 为何存在：API_KEY_ENABLED 是服务端部署配置，公开的 /auth/status 刻意不回传配置面，
 * 于是设置页无法据此隐藏「API Key 轮换」入口（该端点已 fail-closed 403，但用户仍会点到
 * 一个必然失败的操作）。本端点把该开关放进认证域内，客户端按真实返回决定入口可见性。
 *
 * 覆盖：未认证 → 401；认证后 → 200 且 apiKeyEnabled 与 config 一致（true/false 两态）。
 * 临时库指向 os.tmpdir()，不触碰仓库内 .env 与真实数据目录。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsMod = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mcs-auth-capabilities-'));
  return {
    default: {
      ...actual.default,
      dataDir: tmpRoot,
      // 开关初值必须钉死：本文件断言 true 态，而真实 config 从部署机 .env 解析
      // （API_KEY_ENABLED=false 的机器上跑全量会假红）。envFilePath 一并指向临时目录，
      // 顺带消除任何写仓库真实 .env 的可能。
      apiKeyEnabled: true,
      envFilePath: path.join(tmpRoot, '.env'),
    },
  };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminSessionModel } from '../db/admin.model.js';
import { hashToken, generateSessionToken } from '../utils/password.js';
import { authMiddleware } from '../middleware/auth.js';
import { createAuthRoutes } from '../routes/auth.js';
import { errorHandler } from '../middleware/error_handler.js';
import { authCapabilitiesResponseSchema } from '@mc-commander/schemas';

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
  app.use('/api/v1', createAuthRoutes());
  app.use(errorHandler);
});

afterEach(() => {
  config.apiKeyEnabled = originalApiKeyEnabled;
});

/** 会话记录（真实 model + 临时 SQLite），返回明文令牌 */
function seedSession() {
  const token = generateSessionToken();
  AdminSessionModel.create({
    tokenHash: hashToken(token),
    userAgent: 'vitest-auth-capabilities',
    ip: '127.0.0.1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return token;
}

describe('GET /auth/capabilities 鉴权域', () => {
  it('未认证 → 401（该端点不在公开白名单内）', async () => {
    const res = await request(app).get('/api/v1/auth/capabilities');
    expect(res.status).toBe(401);
    expect(res.body.status).toBe('error');
  });

  it('带无效 API Key → 401（不是 200）', async () => {
    const res = await request(app).get('/api/v1/auth/capabilities').set('X-API-Key', 'wrong-key');
    expect(res.status).toBe(401);
  });
});

describe('GET /auth/capabilities 返回值', () => {
  it('API_KEY_ENABLED=true（默认）：会话认证后 200，apiKeyEnabled=true', async () => {
    const res = await request(app)
      .get('/api/v1/auth/capabilities')
      .set('Authorization', `Bearer ${seedSession()}`);

    expect(res.status).toBe(200);
    const parsed = authCapabilitiesResponseSchema.safeParse(res.body.data);
    expect(parsed.success).toBe(true);
    expect(parsed.data.apiKeyEnabled).toBe(true);
    // 契约只暴露这一个字段：部署配置（路径/端口/后端开关）不得进入响应面
    expect(Object.keys(res.body.data)).toEqual(['apiKeyEnabled']);
  });

  it('API_KEY_ENABLED=false：会话认证后 200，apiKeyEnabled=false', async () => {
    config.apiKeyEnabled = false;
    const res = await request(app)
      .get('/api/v1/auth/capabilities')
      .set('Authorization', `Bearer ${seedSession()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.apiKeyEnabled).toBe(false);
  });

  it('关闭态下携带 API Key 仍 403：能力探测不构成绕过关闭通道的口子', async () => {
    config.apiKeyEnabled = false;
    const res = await request(app)
      .get('/api/v1/auth/capabilities')
      .set('X-API-Key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40303);
  });

  it('开启态下 API Key 通道可用：200 且 apiKeyEnabled=true', async () => {
    const res = await request(app)
      .get('/api/v1/auth/capabilities')
      .set('X-API-Key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.apiKeyEnabled).toBe(true);
  });
});
