import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// dataDir 与会话/账号走临时目录；envFilePath 指向临时 .env——本文件**绝不触碰**
// 仓库真实 .env（轮换端点会写它，必须把写入面钉在临时文件上）
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsMod = await import('fs');
  const os = await import('os');
  const pathMod = await import('path');
  const tmpRoot = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'mcs-rotate-key-'));
  return {
    default: { ...actual.default, dataDir: tmpRoot, envFilePath: pathMod.join(tmpRoot, '.env') },
  };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminSessionModel } from '../db/admin.model.js';
import { authMiddleware } from '../middleware/auth.js';
import { createKeyRoutes } from '../routes/keys.js';
import { errorHandler } from '../middleware/error_handler.js';
import { hashToken, generateSessionToken } from '../utils/password.js';

const TEST_PLAINTEXT_KEY = 'test-api-key-for-unit-tests';

let app;
let db;
let envPath;

const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

beforeAll(() => {
  db = initDatabase();
  envPath = config.envFilePath;
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

const originalApiKeyEnabled = config.apiKeyEnabled;
const originalApiKeyHash = config.apiKeyHash;

beforeEach(() => {
  db.prepare('DELETE FROM admin_sessions').run();
  config.apiKeyEnabled = originalApiKeyEnabled;
  // 临时 .env：与真实 .env 同形态（含哈希行与其它键）
  fs.writeFileSync(envPath, `API_KEY_HASH=${originalApiKeyHash}\nPORT=25566\n`, 'utf-8');
  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use('/api/v1', createKeyRoutes());
  app.use(errorHandler);
});

afterEach(() => {
  config.apiKeyEnabled = originalApiKeyEnabled;
  config.apiKeyHash = originalApiKeyHash;
  fs.rmSync(envPath, { force: true });
});

function seedSession() {
  const token = generateSessionToken();
  AdminSessionModel.create({
    tokenHash: hashToken(token),
    userAgent: 'vitest-rotate',
    ip: '127.0.0.1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return token;
}

describe('API_KEY_ENABLED=false：rotate-key 403 且不写 .env', () => {
  it('会话通道调用 → 403/40303，响应不含新 Key，.env 逐字节未变', async () => {
    config.apiKeyEnabled = false;
    const token = seedSession();
    const before = sha256Of(envPath);
    const beforeContent = fs.readFileSync(envPath, 'utf-8');

    const res = await request(app)
      .post('/api/v1/rotate-key')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40303);
    expect(res.body.message).toContain('通道已关闭');
    expect(res.body.data).toBeUndefined();

    // 关键：没有任何写文件动作（含 .tmp 残件），哈希未被覆写
    expect(sha256Of(envPath)).toBe(before);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(beforeContent);
    expect(fs.existsSync(`${envPath}.tmp`)).toBe(false);
    // 内存中的哈希同样不动（否则「重开即恢复」也失效）
    expect(config.apiKeyHash).toBe(originalApiKeyHash);
  });

  it('带 API Key 调用先被鉴权层拦下（403/40303），同样不动 .env', async () => {
    config.apiKeyEnabled = false;
    const before = sha256Of(envPath);
    const res = await request(app).post('/api/v1/rotate-key').set('X-API-Key', TEST_PLAINTEXT_KEY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40303);
    expect(sha256Of(envPath)).toBe(before);
  });
});

describe('API_KEY_ENABLED=true（默认）：轮换行为与现状一致', () => {
  it('会话通道轮换成功：返回新 Key、内存哈希与 .env 同步更新', async () => {
    const token = seedSession();
    const before = sha256Of(envPath);

    const res = await request(app)
      .post('/api/v1/rotate-key')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(newKey).toMatch(/^mcck-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(config.apiKeyHash).toBe(hashToken(newKey));
    // 只更新临时 .env；仓库真实 .env 从未参与
    expect(sha256Of(envPath)).not.toBe(before);
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(`API_KEY_HASH=${hashToken(newKey)}`);
    expect(fs.readFileSync(envPath, 'utf-8')).not.toMatch(/^API_KEY=/m);
  });

  it('API Key 通道轮换成功（既有行为不变）', async () => {
    const res = await request(app).post('/api/v1/rotate-key').set('X-API-Key', TEST_PLAINTEXT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.apiKey).toBeTruthy();
  });

  // 回归守卫（轮换端点的第二个消费点）：写文件动作只能落在 config.envFilePath 上。
  // 历史事故见 keys-hash.test.js 同名用例注释——测试穿透写真实 .env 会让本机 API Key
  // 静默失效且旧哈希不可恢复，故两个调用该端点的测试文件各钉一条。
  it('回归守卫：本文件的轮换调用不得改动仓库真实 .env', async () => {
    const realEnv = fileURLToPath(new URL('../.env', import.meta.url));
    expect(config.envFilePath).not.toBe(realEnv);

    const existedBefore = fs.existsSync(realEnv);
    const hashBefore = existedBefore ? sha256Of(realEnv) : null;

    const res = await request(app)
      .post('/api/v1/rotate-key')
      .set('Authorization', `Bearer ${seedSession()}`);
    expect(res.status).toBe(200);

    if (existedBefore) {
      expect(fs.existsSync(realEnv)).toBe(true);
      expect(sha256Of(realEnv)).toBe(hashBefore);
    } else {
      expect(fs.existsSync(realEnv)).toBe(false);
    }
  });
});
