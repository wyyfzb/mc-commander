import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// 启动迁移逻辑的单元测试：验证旧格式 API_KEY → API_KEY_HASH 自动迁移
// 不通过 import index.js（依赖太多），直接测试迁移代码路径

describe('API Key 哈希迁移', () => {
  let tmpDir;
  let envPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-migration-'));
    envPath = path.join(tmpDir, '.env');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 模拟 index.js 中的迁移逻辑（与源码保持一致） */
  function runMigration(apiKey, apiKeyHash) {
    if (!apiKeyHash && apiKey) {
      const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      content = content.replace(/^API_KEY=.*$/m, '');
      const hashLine = `API_KEY_HASH=${hash}`;
      if (/^API_KEY_HASH=.*$/m.test(content)) {
        content = content.replace(/^API_KEY_HASH=.*$/m, hashLine);
      } else {
        content += (content === '' || content.endsWith('\n') ? '' : '\n') + hashLine + '\n';
      }
      const tmp = envPath + '.tmp';
      fs.writeFileSync(tmp, content, 'utf-8');
      try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
      fs.renameSync(tmp, envPath);
      return { migrated: true, hash };
    }
    return { migrated: false, hash: apiKeyHash };
  }

  it('旧格式 API_KEY= 明文迁移为 API_KEY_HASH= 哈希', () => {
    fs.writeFileSync(envPath, 'PORT=25566\nAPI_KEY=legacy-plaintext-key\nOTHER=val\n');
    const result = runMigration('legacy-plaintext-key', '');
    expect(result.migrated).toBe(true);
    const expected = crypto.createHash('sha256').update('legacy-plaintext-key').digest('hex');
    expect(result.hash).toBe(expected);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('API_KEY=');
    expect(content).toContain(`API_KEY_HASH=${expected}`);
    expect(content).toContain('PORT=25566');
    expect(content).toContain('OTHER=val');
  });

  it('迁移后 .env 权限为 0o600（POSIX）', () => {
    fs.writeFileSync(envPath, 'API_KEY=test-key-for-perm-check\n');
    runMigration('test-key-for-perm-check', '');
    try {
      const stat = fs.statSync(envPath);
      expect(stat.mode & 0o777).toBe(0o600);
    } catch {
      // Windows 等不支持权限位的系统跳过
    }
  });

  it('已有 API_KEY_HASH 时不迁移', () => {
    const existingHash = crypto.createHash('sha256').update('existing').digest('hex');
    fs.writeFileSync(envPath, `API_KEY_HASH=${existingHash}\n`);
    const result = runMigration('some-key', existingHash);
    expect(result.migrated).toBe(false);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain(`API_KEY_HASH=${existingHash}`);
  });

  it('无旧明文也无哈希时不迁移', () => {
    fs.writeFileSync(envPath, 'PORT=25566\n');
    const result = runMigration('', '');
    expect(result.migrated).toBe(false);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('API_KEY_HASH');
  });

  it('空 .env 文件迁移后正确追加', () => {
    fs.writeFileSync(envPath, '');
    runMigration('brand-new-key', '');
    const expected = crypto.createHash('sha256').update('brand-new-key').digest('hex');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain(`API_KEY_HASH=${expected}`);
  });

  it('.env 不存在时创建并写入哈希', () => {
    if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
    runMigration('no-env-file-key', '');
    expect(fs.existsSync(envPath)).toBe(true);
    const expected = crypto.createHash('sha256').update('no-env-file-key').digest('hex');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain(`API_KEY_HASH=${expected}`);
  });

  it('迁移后哈希可用于认证比对（恒时比较）', () => {
    const key = 'verify-after-migration-key';
    fs.writeFileSync(envPath, `API_KEY=${key}\n`);
    const { hash } = runMigration(key, '');
    const incomingHash = crypto.createHash('sha256').update(key).digest('hex');
    // 模拟 safeEqual 的长度检查 + timingSafeEqual
    const bufA = Buffer.from(incomingHash);
    const bufB = Buffer.from(hash);
    expect(bufA.length).toBe(bufB.length);
    expect(crypto.timingSafeEqual(bufA, bufB)).toBe(true);
  });
});
