import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// dataDir 指向临时目录（真实 SQLite，路由全链路），其余 config 保留实际值
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-setup-token-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { createAuthRoutes } from '../routes/auth.js';
import { authStatusResponseSchema } from '@mc-commander/schemas';
import { errorHandler } from '../middleware/error_handler.js';
import {
  isSetupTokenRequired,
  verifySetupToken,
  consumeSetupToken,
  stripSetupTokenLines,
  _setSetupToken,
  _getSetupToken,
} from '../utils/setup-token.js';

// 虚构测试令牌（动态构造 64 位十六进制形态，避免 gitleaks 对字面量误报）：
// 值本身无关紧要，仅需等长且互不相同；非真实凭据
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = `${'a'.repeat(63)}b`; // 仅尾位不同
let app;
let db;
let tmpEnv;

beforeAll(() => {
  db = initDatabase();
  tmpEnv = path.join(os.tmpdir(), `mcs-setup-token-env-${process.pid}-${Date.now()}`);
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.rmSync(tmpEnv, { force: true });
});

beforeEach(() => {
  // 用例隔离：清空账号 + token 状态 + 临时 .env
  db.prepare('DELETE FROM admin_account').run();
  db.prepare('DELETE FROM admin_sessions').run();
  _setSetupToken('');
  fs.rmSync(tmpEnv, { force: true });

  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use('/api/v1', createAuthRoutes());
  app.use(errorHandler);
});

/** 清空管理员账号（模拟「设密前」状态，用于验证 token 作废后的重放拒绝） */
function resetAccount() {
  db.prepare('DELETE FROM admin_account').run();
  db.prepare('DELETE FROM admin_sessions').run();
}

describe('utils/setup-token 纯逻辑', () => {
  it('verifySetupToken：正确 token true；错误/空/非字符串 false；未配置恒 false', () => {
    _setSetupToken(TOKEN_A);
    expect(verifySetupToken(TOKEN_A)).toBe(true);
    expect(verifySetupToken(TOKEN_B)).toBe(false);
    expect(verifySetupToken('')).toBe(false);
    expect(verifySetupToken(null)).toBe(false);
    expect(verifySetupToken(undefined)).toBe(false);
    expect(verifySetupToken(`${TOKEN_A}x`)).toBe(false); // 长度不等提前 false，不抛出
    _setSetupToken('');
    expect(verifySetupToken(TOKEN_A)).toBe(false); // 未配置时恒 false
  });

  it('isSetupTokenRequired 随注入状态翻转', () => {
    expect(isSetupTokenRequired()).toBe(false);
    _setSetupToken(TOKEN_A);
    expect(isSetupTokenRequired()).toBe(true);
    expect(_getSetupToken()).toBe(TOKEN_A);
  });

  it('stripSetupTokenLines：仅剥离 SETUP_TOKEN= 行，注释与其他行原样保留', () => {
    const raw = [
      '# 首访设密所有权证明',
      '#SETUP_TOKEN=注释行保留',
      'API_KEY=keeper',
      'SETUP_TOKEN=deadbeef',
      'PORT=25566',
      '',
    ].join('\n');
    const next = stripSetupTokenLines(raw);
    expect(next).toContain('API_KEY=keeper');
    expect(next).toContain('PORT=25566');
    expect(next).toContain('#SETUP_TOKEN=注释行保留');
    expect(next).not.toContain('SETUP_TOKEN=deadbeef');
  });
});

describe('consumeSetupToken（内存 + .env 双重作废）', () => {
  it('内存清空 + .env 移除 SETUP_TOKEN 行（重启后从 .env 读不到，同样失效）', () => {
    _setSetupToken(TOKEN_A);
    fs.writeFileSync(
      tmpEnv,
      ['API_KEY=keeper', `SETUP_TOKEN=${TOKEN_A}`, 'PORT=25566'].join('\n'),
      { mode: 0o600 },
    );

    const result = consumeSetupToken(tmpEnv);

    expect(result).toEqual({ cleared: true, envRemoved: true });
    expect(_getSetupToken()).toBe('');
    const content = fs.readFileSync(tmpEnv, 'utf8');
    expect(content).toContain('API_KEY=keeper');
    expect(content).toContain('PORT=25566');
    expect(content).not.toContain(`SETUP_TOKEN=${TOKEN_A}`);
    // 「重启后同样失效」语义：新进程只会从该 .env 读到空 token
  });

  it('重复作废幂等：第二次 cleared=false；.env 无该行时 envRemoved=false 不误报', () => {
    fs.writeFileSync(tmpEnv, 'API_KEY=keeper\nPORT=25566\n', { mode: 0o600 });
    _setSetupToken(TOKEN_A);
    expect(consumeSetupToken(tmpEnv)).toEqual({ cleared: true, envRemoved: false });
    expect(consumeSetupToken(tmpEnv)).toEqual({ cleared: false, envRemoved: false });
  });

  it('.env 文件不存在时不抛出（best-effort），内存仍清空', () => {
    _setSetupToken(TOKEN_A);
    expect(consumeSetupToken(path.join(os.tmpdir(), 'mcs-no-such-env-file'))).toEqual({
      cleared: true,
      envRemoved: false,
    });
    expect(_getSetupToken()).toBe('');
  });
});

// 承重用例：首屏探测必须能预知「是否需要令牌」。
// 修复前 /auth/status 只答 hasPassword，前端只能靠先提交一次拿 40104 才展开输入框，
// 于是每个新装用户都被迫以「报错」的形式学习下一步。
describe('GET /auth/status × setupTokenRequired（首屏预知，无需先失败一次）', () => {
  it('未配置 token → setupTokenRequired=false，且契约可 parse', async () => {
    const res = await request(app).get('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(authStatusResponseSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.setupTokenRequired).toBe(false);
  });

  it('已配置 token → setupTokenRequired=true（前端首屏即渲染令牌框）', async () => {
    _setSetupToken(TOKEN_A);
    const res = await request(app).get('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.data.setupTokenRequired).toBe(true);
  });

  it('该端点绝不回传令牌本身（只答「要不要」）', async () => {
    _setSetupToken(TOKEN_A);
    const res = await request(app).get('/api/v1/auth/status');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(TOKEN_A);
    // 键集合固定，不夹带其它部署配置
    expect(Object.keys(res.body.data).sort()).toEqual(['hasPassword', 'setupTokenRequired']);
  });
});

describe('POST /auth/setup × SETUP_TOKEN（四路径）', () => {
  it('未配置 token：行为不变（无凭据头即设密成功，本机首发兼容）', async () => {
    const res = await request(app).post('/api/v1/auth/setup').send({ password: 'setup-pass-9' });
    expect(res.status).toBe(200);
    expect(res.body.data.hasPassword).toBe(true);
    expect(res.body.data.token).toBeTruthy(); // 设密即登录
  });

  it('已配置 + 正确 token：200，且 token 立即作废（重放被拒）', async () => {
    _setSetupToken(TOKEN_A);
    const ok = await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', `SetupToken ${TOKEN_A}`)
      .send({ password: 'setup-pass-9' });
    expect(ok.status).toBe(200);
    // 作废第一腿：内存置空（同进程后续请求不再认可该 token）
    expect(_getSetupToken()).toBe('');

    // 作废第二腿（重放被拒）：同 token 第二次 setup 请求被拒——
    // 生产路径为 409 已设密（幂等防护先于 token 校验）；.env 行移除（重启后
    // 同样失效）由 consumeSetupToken 用例独立覆盖
    const replay = await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', `SetupToken ${TOKEN_A}`)
      .send({ password: 'setup-pass-9' });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe(40911);
  });

  it('已作废 token 的重放（账号未配置的恢复场景）：不再认可旧 token，按未配置态处理', async () => {
    // 场景：设密成功后 DB 回滚/恢复到未设密快照（生产可达：恢复面板备份），
    // 已消费 token 不得复用——token 状态为空 = 未配置，本次请求按既有开放行为处理；
    // 需要重新保护时在 .env 重新生成 SETUP_TOKEN（README/SECURITY.md 说明）
    _setSetupToken(TOKEN_A);
    await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', `SetupToken ${TOKEN_A}`)
      .send({ password: 'setup-pass-9' });
    resetAccount();

    const replay = await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', `SetupToken ${TOKEN_A}`)
      .send({ password: 'setup-pass-9' });
    expect(replay.status).toBe(200); // 旧 token 已消费：不再作为凭据校验，等同未配置态
    expect(_getSetupToken()).toBe('');
  });

  it('已配置 + 错误 token：403（AUTH_SETUP_TOKEN_INVALID），不设密不消费', async () => {
    _setSetupToken(TOKEN_A);
    const res = await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', `SetupToken ${'f'.repeat(62)}00`)
      .send({ password: 'setup-pass-9' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40104);
    expect((await request(app).get('/api/v1/auth/status')).body.data.hasPassword).toBe(false);
    expect(_getSetupToken()).toBe(TOKEN_A); // 错误 token 不触发作废
  });

  it('已配置 + 缺失/畸形凭据头：403（缺失、Bearer 伪装、无值三种变体）', async () => {
    _setSetupToken(TOKEN_A);
    const missing = await request(app)
      .post('/api/v1/auth/setup')
      .send({ password: 'setup-pass-9' });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe(40104);

    const bearer = await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', `Bearer ${TOKEN_A}`) // scheme 不符（会话头伪装）
      .send({ password: 'setup-pass-9' });
    expect(bearer.status).toBe(403);
    expect(bearer.body.code).toBe(40104);

    const bare = await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', 'SetupToken') // 无值
      .send({ password: 'setup-pass-9' });
    expect(bare.status).toBe(403);
    expect(bare.body.code).toBe(40104);
  });

  it('token 校验先于密码强度校验：错误 token + 弱密码返回 403 而非 400', async () => {
    _setSetupToken(TOKEN_A);
    const res = await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', 'SetupToken wrong-token')
      .send({ password: 'short' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40104);
  });

  it('已配置 + 正确 token + 弱密码：400 且 token 不消费（设密未成功）', async () => {
    _setSetupToken(TOKEN_A);
    const res = await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', `SetupToken ${TOKEN_A}`)
      .send({ password: 'short' });
    expect(res.status).toBe(400);
    expect(_getSetupToken()).toBe(TOKEN_A); // 未成功设密，一次性令牌不浪费
  });

  it('已设密时 409 优先（token 状态不改变幂等防护）', async () => {
    _setSetupToken(TOKEN_A);
    await request(app)
      .post('/api/v1/auth/setup')
      .set('Authorization', `SetupToken ${TOKEN_A}`)
      .send({ password: 'setup-pass-9' });
    _setSetupToken(TOKEN_A); // 模拟外部重新注入，隔离出 409 分支
    const dup = await request(app).post('/api/v1/auth/setup').send({ password: 'whatever-99' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe(40911);
  });
});
