import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { createKeyRoutes } from '../routes/keys.js';
import { authMiddleware } from '../middleware/auth.js';
import config from '../config.js';
import { hashToken } from '../utils/password.js';

// API Key 轮换端点测试：鉴权门禁 / 新 key 即时生效 / 旧 key 失效 / .env 哈希写回。
// 文件系统 spy 阻断真实写入（不触碰开发 .env），config.apiKeyHash 原值测试后恢复。

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use('/api', createKeyRoutes());
  return app;
}

// 生成测试用明文 Key（模拟 .env 中存储的旧明文，哈希化前可用）
const TEST_PLAINTEXT_KEY = 'test-api-key-for-unit-tests';

function setTestHash(key) {
  config.apiKeyHash = hashToken(key);
}

describe('POST /api/rotate-key', () => {
  let originalHash;

  beforeEach(() => {
    originalHash = config.apiKeyHash;
    // 设置测试用哈希（基于 TEST_PLAINTEXT_KEY 的 SHA-256）
    setTestHash(TEST_PLAINTEXT_KEY);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
  });

  afterEach(() => {
    config.apiKeyHash = originalHash;
    vi.restoreAllMocks();
  });

  it('should reject request without api key', async () => {
    const res = await request(buildApp()).post('/api/rotate-key');
    expect(res.status).toBe(401);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should rotate key: new key works, old key invalid, .env hash written back', async () => {
    const res = await request(buildApp()).post('/api/rotate-key').set('x-api-key', TEST_PLAINTEXT_KEY);
    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(newKey).toMatch(/^mcck-[0-9a-f]{8}(-[0-9a-f]{8}){7}$/);
    expect(newKey).not.toBe(TEST_PLAINTEXT_KEY);
    // .env 原子写：临时文件写入 + rename
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalled();
    // 内存中存储的是哈希
    expect(config.apiKeyHash).toBe(hashToken(newKey));

    // 新 key 通过鉴权（用明文 → 哈希比对）
    const res2 = await request(buildApp()).post('/api/rotate-key').set('x-api-key', newKey);
    expect(res2.status).toBe(200);
    // 旧 key 立即失效
    const res3 = await request(buildApp()).post('/api/rotate-key').set('x-api-key', TEST_PLAINTEXT_KEY);
    expect(res3.status).toBe(401);
  });
});
