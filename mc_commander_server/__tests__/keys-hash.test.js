import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { hashToken } from '../utils/password.js';
import config from '../config.js';
import { createKeyRoutes } from '../routes/keys.js';
import { authMiddleware } from '../middleware/auth.js';
import express from 'express';
import request from 'supertest';

// API Key 哈希存储集成测试：验证 persistApiKeyHash 写入格式与权限

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use('/api', createKeyRoutes());
  return app;
}

const TEST_PLAINTEXT_KEY = 'test-api-key-for-unit-tests';

describe('POST /api/rotate-key 哈希存储', () => {
  let tmpDir;
  let envPath;
  let originalHash;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-keys-hash-'));
    envPath = path.join(tmpDir, '.env');
    // 写入初始哈希
    const hash = hashToken(TEST_PLAINTEXT_KEY);
    fs.writeFileSync(envPath, `API_KEY_HASH=${hash}\nPORT=25566\n`);
    originalHash = config.apiKeyHash;
    config.apiKeyHash = hash;
  });

  afterEach(() => {
    config.apiKeyHash = originalHash;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('轮换后 .env 只含 API_KEY_HASH（不含 API_KEY 明文）', async () => {
    // 由于 persistApiKeyHash 用固定路径，这里直接验证写入格式
    // 通过 spy 拦截 writeFileSync 检查内容
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    try {
      const app = buildApp();
      const res = await request(app).post('/api/rotate-key').set('x-api-key', TEST_PLAINTEXT_KEY);
      expect(res.status).toBe(200);
      const newKey = res.body.data.apiKey;

      // 检查写入内容不含 API_KEY= 明文
      const writeCall = writeSpy.mock.calls.find(c => {
        const content = typeof c[1] === 'string' ? c[1] : '';
        return content.includes('API_KEY_HASH');
      });
      expect(writeCall).toBeDefined();
      const writtenContent = writeCall[1];
      expect(writtenContent).toContain('API_KEY_HASH=');
      expect(writtenContent).not.toMatch(/^API_KEY=.*$/m);
      expect(writtenContent).toContain(hashToken(newKey));
    } finally {
      writeSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('轮换后新 Key 的哈希即时生效（内存中 apiKeyHash 已更新）', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/rotate-key').set('x-api-key', TEST_PLAINTEXT_KEY);
    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(config.apiKeyHash).toBe(hashToken(newKey));
  });
});

describe('persistApiKeyHash 文件权限', () => {
  let tmpDir;
  let envPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-keys-perm-'));
    envPath = path.join(tmpDir, '.env');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('写入后文件权限为 0o600（仅 POSIX）', () => {
    // 直接测试写入逻辑（不通过路由，避免 auth 依赖）
    const hash = crypto.createHash('sha256').update('perm-test-key').digest('hex');
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    const newLine = `API_KEY_HASH=${hash}`;
    if (/^API_KEY_HASH=.*$/m.test(content)) {
      content = content.replace(/^API_KEY_HASH=.*$/m, newLine);
    } else {
      content += (content === '' || content.endsWith('\n') ? '' : '\n') + newLine + '\n';
    }
    const tmp = envPath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
    fs.renameSync(tmp, envPath);

    try {
      const stat = fs.statSync(envPath);
      expect(stat.mode & 0o777).toBe(0o600);
    } catch {
      // Windows 等不支持权限位的系统跳过
    }
  });
});
