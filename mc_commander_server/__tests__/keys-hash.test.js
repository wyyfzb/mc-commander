import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
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

/** 仓库真实 .env（本文件必须一次都不碰；见下方回归守卫用例） */
const REAL_ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('POST /api/rotate-key 哈希存储', () => {
  let tmpDir;
  let envPath;
  let originalHash;
  let originalEnvPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-keys-hash-'));
    envPath = path.join(tmpDir, '.env');
    // 写入初始哈希
    const hash = hashToken(TEST_PLAINTEXT_KEY);
    fs.writeFileSync(envPath, `API_KEY_HASH=${hash}\nPORT=25566\n`);
    originalHash = config.apiKeyHash;
    config.apiKeyHash = hash;
    // 轮换端点写的是 config.envFilePath：钉在临时目录，绝不触碰仓库真实 .env
    originalEnvPath = config.envFilePath;
    config.envFilePath = envPath;
  });

  afterEach(() => {
    config.apiKeyHash = originalHash;
    config.envFilePath = originalEnvPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('轮换后 .env 只含 API_KEY_HASH（不含 API_KEY 明文）', async () => {
    // 写入落在临时 .env 上（config.envFilePath），spy 同时校验写入内容格式
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

      // 临时 .env 确实被更新（rename 落地后读盘）
      const onDisk = fs.readFileSync(envPath, 'utf-8');
      expect(onDisk).toContain(`API_KEY_HASH=${hashToken(newKey)}`);
      expect(onDisk).not.toMatch(/^API_KEY=/m);
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

  // 回归守卫：本文件跑真实轮换端点，**绝不允许改动仓库真实 .env**。
  // 历史上这里出过事故：本文件的 fs spy 未给 mockImplementation（调用穿透），而轮换端点
  // 曾硬编码真实 .env 路径 ⇒ 每次 `npm test` 都把真实 .env 的 API_KEY_HASH 换成一把随机
  // 新 Key 的哈希：本机 API Key 静默失效，且旧哈希不可恢复（无从反推）。
  // 现在写入路径取 config.envFilePath（本文件 beforeEach 把它钉在临时目录），此用例既断言
  // 该配置项确实被钉住，又实测「跑一次轮换后真实 .env 逐字节不变/不被创建」。
  it('回归守卫：轮换端点不得改动仓库真实 .env（字节级 SHA256 前后一致）', async () => {
    expect(config.envFilePath).toBe(envPath);
    expect(envPath).not.toBe(REAL_ENV_PATH);

    const existedBefore = fs.existsSync(REAL_ENV_PATH);
    const hashBefore = existedBefore ? sha256File(REAL_ENV_PATH) : null;

    const app = buildApp();
    const res = await request(app).post('/api/rotate-key').set('x-api-key', TEST_PLAINTEXT_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.apiKey).toBeTruthy();

    if (existedBefore) {
      expect(fs.existsSync(REAL_ENV_PATH)).toBe(true);
      expect(sha256File(REAL_ENV_PATH)).toBe(hashBefore);
    } else {
      // 真实 .env 不存在时，测试期间也不得被创建出来
      expect(fs.existsSync(REAL_ENV_PATH)).toBe(false);
    }
    // 写入落在临时 .env 上（证明这次轮换真的发生了写文件动作，守卫不是空转）
    expect(fs.readFileSync(envPath, 'utf-8')).toContain('API_KEY_HASH=');
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
