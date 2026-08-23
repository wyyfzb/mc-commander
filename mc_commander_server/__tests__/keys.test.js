import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import { createKeyRoutes } from '../routes/keys.js';
import { authMiddleware } from '../middleware/auth.js';
import config from '../config.js';

// API Key 轮换端点测试：鉴权门禁 / 新 key 即时生效 / 旧 key 失效 / .env 写回。
// 文件系统 spy 阻断真实写入（不触碰开发 .env），config.apiKey 原值测试后恢复。

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use('/api', createKeyRoutes());
  return app;
}

describe('POST /api/rotate-key', () => {
  let originalKey;

  beforeEach(() => {
    originalKey = config.apiKey;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
  });

  afterEach(() => {
    config.apiKey = originalKey;
    vi.restoreAllMocks();
  });

  it('should reject request without api key', async () => {
    const res = await request(buildApp()).post('/api/rotate-key');
    expect(res.status).toBe(401);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should rotate key: new key works, old key invalid, .env written back', async () => {
    const res = await request(buildApp()).post('/api/rotate-key').set('x-api-key', originalKey);
    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(newKey).toMatch(/^mcck-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(newKey).not.toBe(originalKey);
    // .env 原子写：临时文件写入 + rename
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalled();
    expect(config.apiKey).toBe(newKey);

    // 新 key 通过鉴权
    const res2 = await request(buildApp()).post('/api/rotate-key').set('x-api-key', newKey);
    expect(res2.status).toBe(200);
    // 旧 key 立即失效
    const res3 = await request(buildApp()).post('/api/rotate-key').set('x-api-key', originalKey);
    expect(res3.status).toBe(401);
  });
});
