import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createKeyRoutes } from '../routes/keys.js';
import { authMiddleware } from '../middleware/auth.js';
import { ErrorCodes } from '../utils/response.js';
import config from '../config.js';
import { hashToken } from '../utils/password.js';

// keys.js 分支收口：persistApiKeyHash 的 .env 两态（存在/不存在，读取即判定）/
// API_KEY_HASH 行替换与追加 / 追加换行三态拼接 / 原子写与 0600 权限传递 /
// 路由级持久化失败 500。
// 全程 spy 阻断真实写入（不触碰开发 .env），与 keys.test.js / keys-hash.test.js 同范式。

// 与 routes/keys.js 同构推导 envPath（__tests__ 与 routes 同为服务端根一级子目录）
const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

const TEST_PLAINTEXT_KEY = 'test-api-key-for-unit-tests';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.use('/api', createKeyRoutes());
  return app;
}

/**
 * 隔离 .env 文件视图：readFileSync 仅对 envPath 返回桩定态，其余走真实 fs。
 * exists=false 时抛真实形态的 ENOENT（而不是返回空串）——persistEnvHash 的
 * 「读取即判定」分支（ENOENT ⇒ 从空串起写，其余错误上抛）只有这样才被走到；
 * existsSync 一并隔离，防止别处（如旧实现残留）用存在性预检蒙对。
 */
function stageEnvFile({ exists, content }) {
  const realExistsSync = fs.existsSync.bind(fs);
  const realReadFileSync = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
    p === ENV_PATH ? exists : realExistsSync(p),
  );
  vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
    if (p !== ENV_PATH) return realReadFileSync(p, ...rest);
    if (!exists)
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
        code: 'ENOENT',
      });
    return content;
  });
}

function captureWrite() {
  const writes = [];
  const renames = [];
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data, options) => {
    writes.push({ path: p, data, options });
  });
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    renames.push({ from, to });
  });
  return { writes, renames };
}

function writtenEnvContent(writes) {
  const call = writes.find(
    (w) => String(w.path).startsWith(`${ENV_PATH}.`) && String(w.path).endsWith('.tmp'),
  );
  expect(call, 'persistApiKeyHash 应先写 .env 的唯一临时文件').toBeDefined();
  return call.data;
}

describe('POST /api/rotate-key 分支收口', () => {
  let originalHash;

  beforeEach(() => {
    originalHash = config.apiKeyHash;
    config.apiKeyHash = hashToken(TEST_PLAINTEXT_KEY);
  });

  afterEach(() => {
    config.apiKeyHash = originalHash;
    vi.restoreAllMocks();
  });

  it('.env 不存在（读抛 ENOENT）：从零建档只写 API_KEY_HASH 一行', async () => {
    stageEnvFile({ exists: false, content: '' });
    const { writes, renames } = captureWrite();

    const res = await request(buildApp())
      .post('/api/rotate-key')
      .set('x-api-key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(newKey).toMatch(/^mcck-[0-9a-f]{8}(-[0-9a-f]{8}){7}$/);
    // 空内容追加：无前置换行，单行建档
    expect(writtenEnvContent(writes)).toBe(`API_KEY_HASH=${hashToken(newKey)}\n`);
    // 原子写语义：先写唯一临时文件（<目标>.<uuid>.tmp，并发轮换不互踩）再 rename 落地
    expect(renames).toHaveLength(1);
    expect(renames[0].to).toBe(ENV_PATH);
    expect(renames[0].from.startsWith(`${ENV_PATH}.`)).toBe(true);
    expect(renames[0].from.endsWith('.tmp')).toBe(true);
    expect(config.apiKeyHash).toBe(hashToken(newKey));
  });

  it('.env 含明文与旧哈希：API_KEY 行剔除、API_KEY_HASH 行原位替换、其余键保留', async () => {
    stageEnvFile({
      exists: true,
      content: 'API_KEY=old-plain-text\nAPI_KEY_HASH=oldhash\nPORT=25566\n',
    });
    const { writes } = captureWrite();

    const res = await request(buildApp())
      .post('/api/rotate-key')
      .set('x-api-key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    const written = writtenEnvContent(writes);
    expect(written).not.toMatch(/^API_KEY=.*$/m); // 明文不落盘
    expect(written).toContain(`API_KEY_HASH=${hashToken(newKey)}`);
    expect(written).toContain('PORT=25566'); // 其余键保留
    expect(written.match(/API_KEY_HASH=/g)).toHaveLength(1); // 原位替换而非追加
  });

  it('.env 无尾换行且无 API_KEY_HASH：追加前补换行', async () => {
    stageEnvFile({ exists: true, content: 'FOO=bar' });
    const { writes } = captureWrite();

    const res = await request(buildApp())
      .post('/api/rotate-key')
      .set('x-api-key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(writtenEnvContent(writes)).toBe(`FOO=bar\nAPI_KEY_HASH=${hashToken(newKey)}\n`);
  });

  it('.env 以换行结尾且无 API_KEY_HASH：直接追加不产生空行', async () => {
    stageEnvFile({ exists: true, content: 'FOO=bar\n' });
    const { writes } = captureWrite();

    const res = await request(buildApp())
      .post('/api/rotate-key')
      .set('x-api-key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(writtenEnvContent(writes)).toBe(`FOO=bar\nAPI_KEY_HASH=${hashToken(newKey)}\n`);
  });

  it('.env 存在但为空文件：与不存在同收敛为单行建档', async () => {
    stageEnvFile({ exists: true, content: '' });
    const { writes } = captureWrite();

    const res = await request(buildApp())
      .post('/api/rotate-key')
      .set('x-api-key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(200);
    const newKey = res.body.data.apiKey;
    expect(writtenEnvContent(writes)).toBe(`API_KEY_HASH=${hashToken(newKey)}\n`);
  });

  it('临时文件按 0600 权限写入（.env 凭据纪律），权限随 rename 落到目标', async () => {
    stageEnvFile({ exists: false, content: '' });
    const { writes, renames } = captureWrite();

    const res = await request(buildApp())
      .post('/api/rotate-key')
      .set('x-api-key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data.apiKey).toMatch(/^mcck-/);
    // 权限设在临时文件上（先写后 chmod 会留下过宽权限的中间态），rename 后目标继承
    const call = writes.find((w) => String(w.path).endsWith('.tmp'));
    expect(call?.options).toEqual({ mode: 0o600 });
    expect(renames).toHaveLength(1);
    expect(writtenEnvContent(writes)).toContain('API_KEY_HASH=');
  });

  it('.env 写入失败：500 且内存哈希不更新（轮换全有或全无）', async () => {
    stageEnvFile({ exists: true, content: 'API_KEY_HASH=oldhash\n' });
    const renames = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      renames.push({ from, to });
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    const res = await request(buildApp())
      .post('/api/rotate-key')
      .set('x-api-key', TEST_PLAINTEXT_KEY);

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
    expect(res.body.code).toBe(ErrorCodes.SERVER_ERROR.code);
    expect(res.body.message).toContain('.env 写入失败');
    // 失败路径不落地新哈希：内存保持旧值，旧 Key 仍有效
    expect(config.apiKeyHash).toBe(hashToken(TEST_PLAINTEXT_KEY));
    expect(renames).toHaveLength(0);
  });
});
