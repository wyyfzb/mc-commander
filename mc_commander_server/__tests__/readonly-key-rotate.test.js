/**
 * POST /api/v1/rotate-readonly-key —— 只读 Key 轮换（明文仅一次）。
 *
 * 写盘面全部钉在临时目录（dataDir / envFilePath 双重重定向）：本文件调用轮换端点，
 * 必须绝不触碰仓库真实 .env —— 历史上「测试穿透改写真实 .env」已让本机凭据静默失效过。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsMod = await import('fs');
  const os = await import('os');
  const pathMod = await import('path');
  const tmpRoot = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'mcs-rotate-readonly-'));
  return {
    default: {
      ...actual.default,
      dataDir: tmpRoot,
      envFilePath: pathMod.join(tmpRoot, '.env'),
      apiKeyEnabled: true,
      readonlyApiKeyEnabled: true,
    },
  };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminSessionModel } from '../db/admin.model.js';
import { authMiddleware } from '../middleware/auth.js';
import { createApiV1Router, API_V1_MOUNT } from '../routes/index.js';
import { errorHandler } from '../middleware/error_handler.js';
import { hashToken, generateSessionToken } from '../utils/password.js';
import { ErrorCodes } from '../utils/response.js';

const ADMIN_KEY = 'test-api-key-for-unit-tests';
const OLD_READONLY_KEY = 'old-readonly-test-key-for-unit-tests';

const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let app;
let db;
let envPath;

beforeAll(() => {
  db = initDatabase();
  envPath = config.envFilePath;
  const stubManager = { instances: new Map(), getAllInstances: () => [], getInstance: () => null };
  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  // 真实聚合路由：轮换端点必须经由角色门（只读凭据不可自我轮换）
  app.use(API_V1_MOUNT, createApiV1Router(stubManager, {}));
  app.use(errorHandler);
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

const originalReadonlyApiKeyEnabled = config.readonlyApiKeyEnabled;
const originalReadonlyApiKeyHash = config.readonlyApiKeyHash;
const originalApiKeyEnabled = config.apiKeyEnabled;

beforeEach(() => {
  db.prepare('DELETE FROM admin_sessions').run();
  config.readonlyApiKeyEnabled = originalReadonlyApiKeyEnabled;
  config.apiKeyEnabled = originalApiKeyEnabled;
  config.readonlyApiKeyHash = hashToken(OLD_READONLY_KEY);
  // 临时 .env：与真实 .env 同形态（含哈希行与其它键）
  fs.writeFileSync(envPath, `API_KEY_HASH=${hashToken(ADMIN_KEY)}\nPORT=25566\n`, 'utf-8');
});

afterEach(() => {
  config.readonlyApiKeyEnabled = originalReadonlyApiKeyEnabled;
  config.apiKeyEnabled = originalApiKeyEnabled;
  config.readonlyApiKeyHash = originalReadonlyApiKeyHash;
  fs.rmSync(envPath, { force: true });
});

function seedSession() {
  const token = generateSessionToken();
  AdminSessionModel.create({
    tokenHash: hashToken(token),
    userAgent: 'vitest-rotate-readonly',
    ip: '127.0.0.1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return token;
}

const rotateAs = (token) =>
  request(app).post(`${API_V1_MOUNT}/rotate-readonly-key`).set('Authorization', `Bearer ${token}`);

describe('管理员轮换只读 Key', () => {
  it('成功：明文仅一次、mcro- 前缀、内存哈希与 .env 同步、旧只读 Key 立即失效', async () => {
    const before = sha256Of(envPath);

    const res = await rotateAs(seedSession());

    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(newKey).toMatch(/^mcro-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/);
    // 契约：data 只暴露明文 Key 一个字段
    expect(Object.keys(res.body.data)).toEqual(['apiKey']);
    expect(config.readonlyApiKeyHash).toBe(hashToken(newKey));
    expect(sha256Of(envPath)).not.toBe(before);
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(`READONLY_API_KEY_HASH=${hashToken(newKey)}`);
    // 明文不落盘，且不误伤既有管理员哈希行
    expect(fs.readFileSync(envPath, 'utf-8')).toMatch(
      new RegExp(`^API_KEY_HASH=${hashToken(ADMIN_KEY)}$`, 'm')
    );
    expect(fs.readFileSync(envPath, 'utf-8')).not.toMatch(/^API_KEY=/m);
    expect(fs.readFileSync(envPath, 'utf-8')).not.toContain(newKey);

    // 新凭据在只读白名单上可用，旧凭据失效
    const okRes = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', newKey);
    expect(okRes.status).toBe(200);
    const oldRes = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', OLD_READONLY_KEY);
    expect(oldRes.status).toBe(401);
  });

  it('管理员 API Key 通道同样可轮换（与 rotate-key 一致的既有行为）', async () => {
    const res = await request(app)
      .post(`${API_V1_MOUNT}/rotate-readonly-key`)
      .set('X-API-Key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.apiKey).toMatch(/^mcro-/);
  });

  it('未配置过只读 Key 时可直接生成（首次开通路径）', async () => {
    config.readonlyApiKeyHash = '';
    const res = await rotateAs(seedSession());
    expect(res.status).toBe(200);
    expect(config.readonlyApiKeyHash).toBe(hashToken(res.body.data.apiKey));
    expect(fs.readFileSync(envPath, 'utf-8')).toContain('READONLY_API_KEY_HASH=');
  });

  it('响应体不回显任何哈希', async () => {
    const res = await rotateAs(seedSession());
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(hashToken(ADMIN_KEY));
    expect(raw).not.toContain(config.readonlyApiKeyHash);
  });
});

describe('只读凭据不得自我轮换', () => {
  it('只读凭据调用轮换端点 → 403/40305，且 .env 逐字节未变', async () => {
    const before = sha256Of(envPath);
    const beforeContent = fs.readFileSync(envPath, 'utf-8');

    const res = await request(app)
      .post(`${API_V1_MOUNT}/rotate-readonly-key`)
      .set('X-API-Key', OLD_READONLY_KEY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCodes.AUTH_INSUFFICIENT_ROLE.code);
    expect(res.body.data).toBeUndefined();
    expect(sha256Of(envPath)).toBe(before);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(beforeContent);
    expect(config.readonlyApiKeyHash).toBe(hashToken(OLD_READONLY_KEY));
  });
});

describe('READONLY_API_KEY_ENABLED=false：轮换 403 且不写 .env', () => {
  it('会话通道调用 → 403/40304，无新 Key、无 .tmp 残件、哈希不动', async () => {
    config.readonlyApiKeyEnabled = false;
    const before = sha256Of(envPath);
    const beforeContent = fs.readFileSync(envPath, 'utf-8');

    const res = await rotateAs(seedSession());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCodes.READONLY_API_KEY_DISABLED.code);
    expect(res.body.message).toContain('通道已关闭');
    expect(res.body.data).toBeUndefined();

    expect(sha256Of(envPath)).toBe(before);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(beforeContent);
    expect(fs.existsSync(`${envPath}.tmp`)).toBe(false);
    // 内存哈希不动：否则「重开即恢复」失效
    expect(config.readonlyApiKeyHash).toBe(hashToken(OLD_READONLY_KEY));
  });
});

describe('回归守卫：测试不得改动仓库真实 .env', () => {
  it('轮换启用态与关闭态都不触碰真实 .env', async () => {
    const realEnv = fileURLToPath(new URL('../.env', import.meta.url));
    expect(config.envFilePath).not.toBe(realEnv);
    const existedBefore = fs.existsSync(realEnv);
    const hashBefore = existedBefore ? sha256Of(realEnv) : null;

    expect((await rotateAs(seedSession())).status).toBe(200);
    config.readonlyApiKeyEnabled = false;
    expect((await rotateAs(seedSession())).status).toBe(403);

    if (existedBefore) {
      expect(fs.existsSync(realEnv)).toBe(true);
      expect(sha256Of(realEnv)).toBe(hashBefore);
    } else {
      expect(fs.existsSync(realEnv)).toBe(false);
    }
  });
});
