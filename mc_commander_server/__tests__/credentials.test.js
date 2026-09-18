/**
 * utils/credentials.js：凭据生成 + .env 写回 + 监听面判定。
 *
 * 承重点：服务端签发的 Key 必须满足文档对「自填 Key」的同一条要求
 * （≥32 字节 CSPRNG），且 .env 写回是「保留其余键 + 原子写 + 0600」——弱 Key 路径
 * 之所以存在，正是此前由部署方自行 `sha256sum` 生成、服务端只能照收。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';

import {
  generateApiKey,
  persistEnvLine,
  persistApiKeyHash,
  bootstrapApiKey,
  isPublicBind,
  ADMIN_KEY_PREFIX,
  READONLY_KEY_PREFIX,
} from '../utils/credentials.js';

describe('credentials generateApiKey', () => {
  it('管理员前缀 + 32 字节熵（64 位 hex，8 位一组共 8 段）', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^mcck-[0-9a-f]{8}(-[0-9a-f]{8}){7}$/);
    // 32 字节 = 64 位 hex（去掉前缀与 7 个连字符）
    expect(key.slice(ADMIN_KEY_PREFIX.length).replace(/-/g, '')).toHaveLength(64);
  });

  it('只读前缀可指定（同一格式，仅前缀不同）', () => {
    expect(generateApiKey(READONLY_KEY_PREFIX)).toMatch(/^mcro-[0-9a-f]{8}(-[0-9a-f]{8}){7}$/);
  });

  it('两次生成不相同（CSPRNG，不是固定串/时间戳派生）', () => {
    const set = new Set(Array.from({ length: 20 }, () => generateApiKey()));
    expect(set.size).toBe(20);
  });
});

describe('credentials persistEnvLine / persistApiKeyHash', () => {
  let root;
  let envPath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-credentials-'));
    envPath = path.join(root, '.env');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('尚无 .env：从零建档，只写目标行（无前导空行）', () => {
    persistEnvLine(envPath, 'API_KEY_HASH', 'abc');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('API_KEY_HASH=abc\n');
  });

  it('已有 .env：原位替换目标行，其余键逐字节保留', () => {
    fs.writeFileSync(envPath, 'PORT=25566\nAPI_KEY_HASH=old\nHOST=0.0.0.0\n');
    persistEnvLine(envPath, 'API_KEY_HASH', 'new');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('PORT=25566\nAPI_KEY_HASH=new\nHOST=0.0.0.0\n');
  });

  it('缺尾换行：追加前补换行，不把上一行粘进新行', () => {
    fs.writeFileSync(envPath, 'PORT=25566');
    persistEnvLine(envPath, 'SETUP_TOKEN', 'tok');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('PORT=25566\nSETUP_TOKEN=tok\n');
  });

  it('persistApiKeyHash：顺带清掉历史遗留的明文 API_KEY 行', () => {
    fs.writeFileSync(envPath, 'API_KEY=plaintext-secret\nPORT=25566\n');
    persistApiKeyHash(envPath, 'hashvalue');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('plaintext-secret');
    expect(content).toContain('API_KEY_HASH=hashvalue');
    expect(content).toContain('PORT=25566');
  });

  it('写回不留临时文件残件', () => {
    persistEnvLine(envPath, 'API_KEY_HASH', 'abc');
    persistEnvLine(envPath, 'SETUP_TOKEN', 'tok');
    expect(fs.readdirSync(root)).toEqual(['.env']);
  });

  it.skipIf(process.platform === 'win32')('POSIX 下 .env 与临时文件均为 0600', () => {
    fs.writeFileSync(envPath, 'PORT=25566\n', { mode: 0o644 });
    persistEnvLine(envPath, 'API_KEY_HASH', 'abc');
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });
});

describe('credentials bootstrapApiKey（首次启动播种）', () => {
  let root;
  let envPath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-bootstrap-'));
    envPath = path.join(root, '.env');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('签发一把 Key 并把其 SHA-256 摘要写回 .env（明文不落盘）', () => {
    fs.writeFileSync(envPath, 'PORT=25566\n');
    const { apiKey, hash } = bootstrapApiKey(envPath);

    expect(apiKey).toMatch(/^mcck-[0-9a-f]{8}(-[0-9a-f]{8}){7}$/);
    expect(hash).toBe(createHash('sha256').update(apiKey).digest('hex'));

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain(`API_KEY_HASH=${hash}`);
    expect(content).toContain('PORT=25566');
    // 明文一律不落盘（哪怕只是 Key 本身）
    expect(content).not.toContain(apiKey);
  });

  it('重复播种（删行后重启的场景）只留一行摘要，不堆叠旧行', () => {
    fs.writeFileSync(envPath, 'PORT=25566\n');
    const first = bootstrapApiKey(envPath);
    const second = bootstrapApiKey(envPath);

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content.match(/^API_KEY_HASH=/gm)).toHaveLength(1);
    expect(content).toContain(`API_KEY_HASH=${second.hash}`);
    expect(content).not.toContain(first.hash);
  });

  it('写回失败必须抛出（调用方据此拒绝启动，不留「每次重启换一把」的临时凭据）', () => {
    // 目标父目录不存在：写入必然失败
    expect(() => bootstrapApiKey(path.join(root, 'missing-dir', '.env'))).toThrow();
  });
});

describe('credentials isPublicBind', () => {
  it.each([
    ['', false],
    [undefined, false],
    ['127.0.0.1', false],
    ['127.1.2.3', false],
    ['localhost', false],
    ['LOCALHOST', false],
    ['::1', false],
    ['[::1]', false],
    ['0.0.0.0', true],
    ['::', true],
    ['1.2.3.4', true],
    ['10.0.0.5', true],
    ['example.internal', true],
  ])('host=%s → 对外可达=%s', (host, expected) => {
    expect(isPublicBind(host)).toBe(expected);
  });
});
