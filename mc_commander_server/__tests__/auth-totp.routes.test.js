import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import crypto from 'crypto';

// dataDir 指向临时目录（真实 SQLite）：本文件验证的是挂靠/确认/关闭/登录全链路
// 与落库状态的真实变化，mock 库无法呈现 used_at / totp_last_step 的持久化语义
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsMod = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mcs-auth-totp-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminAccountModel, AdminRecoveryCodeModel } from '../db/admin.model.js';
import { hashPassword } from '../utils/password.js';
import { authMiddleware } from '../middleware/auth.js';
import { createAuthRoutes, resetLoginLockState } from '../routes/auth.js';
import { errorHandler } from '../middleware/error_handler.js';
import { isLocked } from '../utils/credential-lockout.js';
import {
  generateTotpSecret,
  totpCodeAtStep,
  currentTimeStep,
  TOTP_PERIOD_SECONDS,
} from '../utils/totp.js';
import { hashRecoveryCode } from '../utils/recovery-codes.js';

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
// 固定虚构值（与仓库既有 TEST_API_KEY 口径一致）：不含任何真实凭据
const PASSWORD = 'test-admin-pass-9';
const TEST_PLAINTEXT_KEY = 'test-api-key-for-unit-tests';

/**
 * 步长边界对齐：挂靠确认/登录第二因子都依赖当前 30s 步长，断言期间跨边界会让
 * 「正确码」用例随机失败。对齐后至少留 4s 余量。
 */
async function alignToStepStart() {
  const periodMs = TOTP_PERIOD_SECONDS * 1000;
  const remain = periodMs - (Date.now() % periodMs);
  if (remain < 4000) await new Promise((r) => setTimeout(r, remain + 200));
}

/**
 * 当前步长的码。步长与码在**同一时刻**取自同一个 step 值：即使请求发出时
 * 恰好跨过 30s 边界，该码也只会落进漂移窗的 t-1，仍被接受且 last_step 恒等于
 * 取码时的 step——断言因此与运行时刻无关。
 */
function codeNow(secret, offset = 0) {
  return totpCodeAtStep(secret, currentTimeStep() + offset);
}

/** 一定不被接受的 6 位码：排除 t-2..t+2 五个窗口（跨边界后仍不可能是有效码） */
function wrongCode(secret) {
  const t = currentTimeStep();
  const valid = new Set([-2, -1, 0, 1, 2].map((o) => totpCodeAtStep(secret, t + o)));
  for (let i = 0; i < 1000; i += 1) {
    const candidate = String(i).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error('无法构造无效动态口令（不应发生）');
}

/** 客户端 IP 在 supertest 下可能是 IPv4 或 IPv4-mapped IPv6 形态，两种都查 */
function anyLocked() {
  return isLocked('127.0.0.1') || isLocked('::ffff:127.0.0.1');
}

let app;
let db;
// scrypt(N=2^17) 单次数百毫秒：固定哈希在文件级算一次，用例内只复用（不为测试降成本）
const PASSWORD_HASH = hashPassword(PASSWORD);

beforeAll(async () => {
  db = initDatabase();
  await alignToStepStart();
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM admin_sessions').run();
  db.prepare('DELETE FROM admin_account').run();
  db.prepare('DELETE FROM admin_recovery_codes').run();
  resetLoginLockState();

  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use('/api/v1', createAuthRoutes());
  app.use(errorHandler);
});

/** 已设密的管理员账号（不改动 TOTP 状态） */
function seedAccount() {
  AdminAccountModel.setPassword(PASSWORD_HASH);
}

function rawAccount() {
  return db.prepare('SELECT * FROM admin_account WHERE id = 1').get();
}

function rawCodeRows() {
  return db.prepare('SELECT * FROM admin_recovery_codes').all();
}

function sessionCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n;
}

/**
 * 走完整挂靠流程。返回的 token 来自**启用前**创建的会话（挂靠本身需要管理员
 * 身份，而那一刻两步验证还没生效）——已启用后的管理操作复用它是真实场景：
 * 会话不因启用两步验证而失效。
 */
async function enrollAndConfirm() {
  seedAccount();
  const login = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
  const token = login.body.data.token;
  const auth = { Authorization: `Bearer ${token}` };

  const enroll = await request(app).post('/api/v1/auth/totp/enroll').set(auth).send();
  const secret = enroll.body.data.secret;
  const confirm = await request(app)
    .post('/api/v1/auth/totp/confirm')
    .set(auth)
    .send({ code: codeNow(secret) });

  return { secret, recoveryCodes: confirm.body.data.recoveryCodes, token };
}

describe('两步验证端点的鉴权域', () => {
  it('无凭据访问 totp 端点一律 401（只有 status/setup/login 是公开端点）', async () => {
    for (const [method, path] of [
      ['get', '/api/v1/auth/totp/status'],
      ['post', '/api/v1/auth/totp/enroll'],
      ['post', '/api/v1/auth/totp/confirm'],
      ['post', '/api/v1/auth/totp/disable'],
    ]) {
      const res = await request(app)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('安全档位变更后的会话吊销（confirm / disable）', () => {
  /** 新建一个会话（未启用阶段只需密码），返回明文令牌 */
  async function loginToken(totpCode) {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send(totpCode ? { password: PASSWORD, totpCode } : { password: PASSWORD });
    expect(res.status, res.body?.message).toBe(200);
    return res.body.data.token;
  }

  /** 用令牌探活：200 = 会话仍有效，401 = 已被吊销 */
  const alive = async (token) =>
    (await request(app).get('/api/v1/auth/totp/status').set('Authorization', `Bearer ${token}`)).status;

  it('confirm 成功：其它会话立即失效，当前会话保留', async () => {
    seedAccount();
    const current = await loginToken();
    const other1 = await loginToken();
    const other2 = await loginToken();
    const auth = { Authorization: `Bearer ${current}` };

    const { secret } = (await request(app).post('/api/v1/auth/totp/enroll').set(auth).send()).body.data;
    const res = await request(app)
      .post('/api/v1/auth/totp/confirm')
      .set(auth)
      .send({ code: codeNow(secret) });
    expect(res.status).toBe(200);

    // 变更前创建的会话（可能是被窃会话）必须立刻失效——否则绕过刚启用的第二因子
    expect(await alive(current)).toBe(200);
    expect(await alive(other1)).toBe(401);
    expect(await alive(other2)).toBe(401);
  });

  it('confirm 失败（码错）：不吊销任何会话', async () => {
    seedAccount();
    const current = await loginToken();
    const other = await loginToken();
    const auth = { Authorization: `Bearer ${current}` };

    const { secret } = (await request(app).post('/api/v1/auth/totp/enroll').set(auth).send()).body.data;
    const res = await request(app)
      .post('/api/v1/auth/totp/confirm')
      .set(auth)
      .send({ code: wrongCode(secret) });
    expect(res.status).toBe(401);

    expect(await alive(current)).toBe(200);
    expect(await alive(other)).toBe(200);
  });

  it('API Key 通道 confirm：无当前会话可留 ⇒ 全部会话失效', async () => {
    seedAccount();
    const other = await loginToken();
    const apiKey = { 'X-API-Key': TEST_PLAINTEXT_KEY };

    const { secret } = (await request(app).post('/api/v1/auth/totp/enroll').set(apiKey).send()).body.data;
    const res = await request(app)
      .post('/api/v1/auth/totp/confirm')
      .set(apiKey)
      .send({ code: codeNow(secret) });
    expect(res.status).toBe(200);
    expect(await alive(other)).toBe(401);
  });

  it('disable 成功：其它会话立即失效，当前会话保留', async () => {
    const { secret, recoveryCodes, token: current } = await enrollAndConfirm();
    // 启用后新登录的会话（第二因子用 t+1：confirm 已消耗当前窗口）
    const other = await loginToken(codeNow(secret, 1));
    expect(await alive(other)).toBe(200);

    const res = await request(app)
      .post('/api/v1/auth/totp/disable')
      .set('Authorization', `Bearer ${current}`)
      .send({ password: PASSWORD, code: recoveryCodes[0] });
    expect(res.status).toBe(200);

    expect(await alive(current)).toBe(200);
    expect(await alive(other)).toBe(401);
  });

  it('disable 失败（密码错 / 第二因子错）：不吊销任何会话', async () => {
    const { secret, token: current } = await enrollAndConfirm();
    const other = await loginToken(codeNow(secret, 1));

    const wrongPass = await request(app)
      .post('/api/v1/auth/totp/disable')
      .set('Authorization', `Bearer ${current}`)
      .send({ password: 'wrong-password-1', code: codeNow(secret, 1) });
    expect(wrongPass.status).toBe(401);

    const wrongSecond = await request(app)
      .post('/api/v1/auth/totp/disable')
      .set('Authorization', `Bearer ${current}`)
      .send({ password: PASSWORD, code: wrongCode(secret) });
    expect(wrongSecond.status).toBe(401);

    expect(await alive(current)).toBe(200);
    expect(await alive(other)).toBe(200);
  });
});

describe('挂靠流程：enroll → confirm', () => {
  it('status：未挂靠时为 false / null / 0，且响应只有三个字段（无 secret）', async () => {
    seedAccount();
    const login = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    const res = await request(app)
      .get('/api/v1/auth/totp/status')
      .set('Authorization', `Bearer ${login.body.data.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: false, confirmedAt: null, recoveryCodesRemaining: 0 });
    expect(Object.keys(res.body.data).sort()).toEqual(['confirmedAt', 'enabled', 'recoveryCodesRemaining']);
  });

  it('enroll 返回 secret + otpauth URI + PNG 二维码；此时尚未启用，登录不需要第二因子', async () => {
    seedAccount();
    const login = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    const res = await request(app)
      .post('/api/v1/auth/totp/enroll')
      .set('Authorization', `Bearer ${login.body.data.token}`)
      .send();
    expect(res.status).toBe(200);

    const { secret, otpauthUrl, qrDataUrl } = res.body.data;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(otpauthUrl.startsWith('otpauth://totp/')).toBe(true);

    // 二维码是服务端出的真 PNG（不是空串/占位）
    expect(qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // 未 confirm：启用位仍为 0，会话登录不要求第二因子
    expect(rawAccount().totp_enabled).toBe(0);
    expect(rawAccount().totp_confirmed_at).toBeNull();
    const relogin = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    expect(relogin.status).toBe(200);
    expect(relogin.body.data.token).toBeTruthy();
  });

  it('未设密（无 admin_account 行）时 enroll → 400/40013，不返回从未落库的 secret', async () => {
    // 无管理员密码时仍有 API Key 通道可达该端点：若不拦截会返回一个 confirm 必然
    // 拒绝的 secret（beginTotpEnrollment 更新 0 行）
    const res = await request(app)
      .post('/api/v1/auth/totp/enroll')
      .set('X-API-Key', TEST_PLAINTEXT_KEY)
      .send();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40013);
    expect(res.body.data).toBeUndefined();
    expect(rawAccount()).toBeUndefined();
  });

  it('未挂靠时 confirm → 400/40015，disable → 400/40015', async () => {
    seedAccount();
    const login = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    const auth = { Authorization: `Bearer ${login.body.data.token}` };

    const confirm = await request(app).post('/api/v1/auth/totp/confirm').set(auth).send({ code: '123456' });
    expect(confirm.status).toBe(400);
    expect(confirm.body.code).toBe(40015);

    const disable = await request(app)
      .post('/api/v1/auth/totp/disable')
      .set(auth)
      .send({ password: PASSWORD, code: '123456' });
    expect(disable.status).toBe(400);
    expect(disable.body.code).toBe(40015);
  });

  it('confirm 错误码 → 401/40106 且启用位与确认时间都不落库', async () => {
    seedAccount();
    const login = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    const auth = { Authorization: `Bearer ${login.body.data.token}` };
    const enroll = await request(app).post('/api/v1/auth/totp/enroll').set(auth).send();
    const { secret } = enroll.body.data;

    const res = await request(app)
      .post('/api/v1/auth/totp/confirm')
      .set(auth)
      .send({ code: wrongCode(secret) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40106);
    expect(rawAccount().totp_enabled).toBe(0);
    expect(rawAccount().totp_confirmed_at).toBeNull();
    expect(rawAccount().totp_last_step).toBeNull();
    expect(rawCodeRows()).toHaveLength(0);
  });

  it('confirm 正确码 → 启用 + 确认时间 + 10 个恢复码（明文唯一出口）', async () => {
    seedAccount();
    const login = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    const auth = { Authorization: `Bearer ${login.body.data.token}` };
    const { secret } = (await request(app).post('/api/v1/auth/totp/enroll').set(auth).send()).body.data;

    const step = currentTimeStep();
    const res = await request(app)
      .post('/api/v1/auth/totp/confirm')
      .set(auth)
      .send({ code: totpCodeAtStep(secret, step) });
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(res.body.data.recoveryCodes).toHaveLength(10);
    for (const code of res.body.data.recoveryCodes) expect(code).toMatch(CODE_RE);

    const account = rawAccount();
    expect(account.totp_enabled).toBe(1);
    expect(account.totp_confirmed_at).toBeTruthy();
    expect(account.totp_secret).toBe(secret);
    // 重放基线 = 确认时接受的步长（确认本身就消耗了当前窗口）
    expect(account.totp_last_step).toBe(step);

    // 库里只有哈希
    const hashes = rawCodeRows().map((r) => r.code_hash);
    expect(hashes).toHaveLength(10);
    for (const code of res.body.data.recoveryCodes) {
      expect(hashes).not.toContain(code);
      expect(hashes).toContain(hashRecoveryCode(code));
    }
  });

  it('status 在启用后只报计数，响应体不含 secret 也不含任何恢复码明文', async () => {
    const { secret, recoveryCodes, token } = await enrollAndConfirm();
    const res = await request(app)
      .get('/api/v1/auth/totp/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(res.body.data.recoveryCodesRemaining).toBe(10);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(secret);
    for (const code of recoveryCodes) expect(body).not.toContain(code.replace('-', ''));
  });

  it('重复 enroll：已启用 → 409/40913（必须先 disable），secret 不被替换', async () => {
    const { secret, token } = await enrollAndConfirm();
    const res = await request(app)
      .post('/api/v1/auth/totp/enroll')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40913);
    expect(rawAccount().totp_secret).toBe(secret);
  });

  it('未确认的候选 secret 可重新 enroll：旧 secret 立即作废，新 secret 可确认', async () => {
    seedAccount();
    const login = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    const auth = { Authorization: `Bearer ${login.body.data.token}` };

    const first = (await request(app).post('/api/v1/auth/totp/enroll').set(auth).send()).body.data.secret;
    const second = (await request(app).post('/api/v1/auth/totp/enroll').set(auth).send()).body.data.secret;
    expect(second).not.toBe(first);
    expect(rawAccount().totp_secret).toBe(second);

    const stale = await request(app)
      .post('/api/v1/auth/totp/confirm')
      .set(auth)
      .send({ code: codeNow(first) });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe(40106);

    const step = currentTimeStep();
    const fresh = await request(app)
      .post('/api/v1/auth/totp/confirm')
      .set(auth)
      .send({ code: totpCodeAtStep(second, step) });
    expect(fresh.status).toBe(200);
    expect(rawAccount().totp_enabled).toBe(1);
    expect(rawAccount().totp_last_step).toBe(step);
  });
});

describe('关闭两步验证：密码 + 第二因子双证', () => {
  it('密码错误 → 401/40102 且仍启用；正确密码 + 错误码 → 401/40106 且仍启用', async () => {
    const { secret, token } = await enrollAndConfirm();
    const auth = { Authorization: `Bearer ${token}` };

    const wrongPass = await request(app)
      .post('/api/v1/auth/totp/disable')
      .set(auth)
      .send({ password: 'wrong-password-1', code: codeNow(secret, 1) });
    expect(wrongPass.status).toBe(401);
    expect(wrongPass.body.code).toBe(40102);

    const wrongSecond = await request(app)
      .post('/api/v1/auth/totp/disable')
      .set(auth)
      .send({ password: PASSWORD, code: wrongCode(secret) });
    expect(wrongSecond.status).toBe(401);
    expect(wrongSecond.body.code).toBe(40106);

    expect(rawAccount().totp_enabled).toBe(1);
    expect(rawAccount().totp_secret).toBe(secret);
  });

  it('双证通过 → 关闭：secret / 确认时间 / 重放基线 / 恢复码一并清空，登录不再要第二因子', async () => {
    const { secret, recoveryCodes, token } = await enrollAndConfirm();

    const res = await request(app)
      .post('/api/v1/auth/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      // 确认已消耗当前窗口，故用 t+1（漂移窗内、> 重放基线）
      .send({ password: PASSWORD, code: codeNow(secret, 1) });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });

    const account = rawAccount();
    expect(account.totp_enabled).toBe(0);
    expect(account.totp_secret).toBeNull();
    expect(account.totp_confirmed_at).toBeNull();
    expect(account.totp_last_step).toBeNull();
    // 恢复码随挂靠一并作废（不留仍可用的第二因子凭据）
    expect(rawCodeRows()).toHaveLength(0);
    for (const code of recoveryCodes) {
      expect(AdminRecoveryCodeModel.verifyAndConsume(code)).toBe(false);
    }

    const relogin = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    expect(relogin.status).toBe(200);
  });

  it('丢机场景：可用一枚未用恢复码作第二因子关闭，且该码被消耗', async () => {
    const { recoveryCodes, token } = await enrollAndConfirm();

    const res = await request(app)
      .post('/api/v1/auth/totp/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: PASSWORD, code: recoveryCodes[0] });
    expect(res.status).toBe(200);
    expect(rawAccount().totp_enabled).toBe(0);
    expect(AdminRecoveryCodeModel.verifyAndConsume(recoveryCodes[0])).toBe(false);
  });
});

describe('登录第二因子', () => {
  it('已启用但未带第二因子 → 401/40105，不签发会话', async () => {
    await enrollAndConfirm();
    // enrollAndConfirm 自身留下的那条会话来自身份确认前的登录：失败尝试不得新增
    const before = sessionCount();
    expect(before).toBe(1);
    const res = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40105);
    expect(res.body.data).toBeUndefined();
    expect(sessionCount()).toBe(before);
  });

  it('第二因子错误 → 401/40106 且不签发会话；恢复码形状的错误同样计入', async () => {
    const { secret } = await enrollAndConfirm();
    const before = sessionCount();
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: wrongCode(secret) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe(40106);
    expect(sessionCount()).toBe(before);

    const wrongRecovery = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: 'ZZZZZ-ZZZZZ' });
    expect(wrongRecovery.status).toBe(401);
    expect(wrongRecovery.body.code).toBe(40106);
    expect(sessionCount()).toBe(before);

    // 正确码仍可登录（上述失败不改变 secret 与启用态）
    const ok = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: codeNow(secret, 1) });
    expect(ok.status).toBe(200);
    expect(sessionCount()).toBe(before + 1);
  });

  it('正确码 → 签发可用会话；同一个码重放（仍在漂移窗内）必须失败', async () => {
    const { secret } = await enrollAndConfirm();
    const step = currentTimeStep() + 1;
    const code = totpCodeAtStep(secret, step);

    const first = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD, totpCode: code });
    expect(first.status).toBe(200);
    expect(first.body.data.token).toBeTruthy();
    expect(rawAccount().totp_last_step).toBe(step);

    const token = first.body.data.token;
    const protectedRes = await request(app)
      .get('/api/v1/auth/totp/status')
      .set('Authorization', `Bearer ${token}`);
    expect(protectedRes.status).toBe(200);

    const replay = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD, totpCode: code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe(40106);
  });

  it('恢复码可登录：该码作废、剩余数减一、第二次使用失败', async () => {
    const { recoveryCodes } = await enrollAndConfirm();
    const used = recoveryCodes[3];

    const first = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: used });
    expect(first.status).toBe(200);
    expect(AdminRecoveryCodeModel.countRemaining()).toBe(9);

    const second = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: used });
    expect(second.status).toBe(401);
    expect(second.body.code).toBe(40106);
    expect(AdminRecoveryCodeModel.countRemaining()).toBe(9);

    // 状态接口报出的剩余数与库内一致，且不暴露码本身
    const status = await request(app)
      .get('/api/v1/auth/totp/status')
      .set('Authorization', `Bearer ${first.body.data.token}`);
    expect(status.body.data.recoveryCodesRemaining).toBe(9);
    expect(JSON.stringify(status.body)).not.toContain(used.replace('-', ''));
    // 未用的码仍然有效
    expect(AdminRecoveryCodeModel.verifyAndConsume(recoveryCodes[4])).toBe(true);
  });

  it('未通过密码时拿不到「是否启用两步验证」的信息面（错误码仍是密码错误）', async () => {
    const { secret } = await enrollAndConfirm();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: 'totally-wrong-1', totpCode: codeNow(secret, 1) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(40102);
  });

  it('损坏基线（未来步长）自愈：正确码可登录、基线被写回正常值，同一码随后重放仍被拒', async () => {
    const { secret } = await enrollAndConfirm();
    // 库被手工改写 / 时钟前跳期间验证成功的残留：基线落在未来，若不纠正会永久拒绝正确码
    AdminAccountModel.setTotpLastStep(99999999999);

    const step = currentTimeStep() + 1;
    const code = totpCodeAtStep(secret, step);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: code });
    expect(login.status, login.body?.message).toBe(200);

    // 登录成功即把基线纠正回本次接受的步长（护栏只放行、不写坏值）
    expect(rawAccount().totp_last_step).toBe(step);

    // 护栏没有变成绕过重放的路径：同一个码再来一次必须被拒
    const replay = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe(40106);
  });
});

describe('登录失败封禁：第二因子错误计入同一计数', () => {
  const original = { ...config.adminSession };

  afterEach(() => {
    Object.assign(config.adminSession, original);
    resetLoginLockState();
  });

  it('连续第二因子错误达阈值 ⇒ isLocked 为真，且正确密码 + 正确码也被拒（封禁优先）', async () => {
    config.adminSession.loginLockMaxFails = 3;
    const { secret } = await enrollAndConfirm();
    const before = sessionCount();

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ password: PASSWORD, totpCode: wrongCode(secret) });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe(40106);
    }
    expect(anyLocked()).toBe(true);

    const locked = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: codeNow(secret, 1) });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe(42901);
    expect(sessionCount()).toBe(before);
  });

  it('「未带第二因子」不消耗计数，正确码通过后计数清零', async () => {
    config.adminSession.loginLockMaxFails = 2;
    const { secret } = await enrollAndConfirm();

    // 空提交两次（密码正确但没输码）：既不清计数也不计失败
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
      expect(res.body.code).toBe(40105);
    }
    expect(anyLocked()).toBe(false);

    // 失败一次（计数 1），再用正确码登录 → 计数被清零
    await request(app).post('/api/v1/auth/login').send({ password: PASSWORD, totpCode: wrongCode(secret) });
    const ok = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: codeNow(secret, 1) });
    expect(ok.status).toBe(200);

    // 清零后再失败一次不应触发锁定（阈值 2）；若上面的成功没清零，这里会 429
    const after = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: wrongCode(secret) });
    expect(after.status).toBe(401);
    expect(anyLocked()).toBe(false);
  });

  it('恢复码错误与密码错误共用同一计数（跨凭据类型封禁）', async () => {
    config.adminSession.loginLockMaxFails = 2;
    await enrollAndConfirm();

    await request(app).post('/api/v1/auth/login').send({ password: 'wrong-password-1' });
    await request(app).post('/api/v1/auth/login').send({ password: PASSWORD, totpCode: 'ZZZZZ-ZZZZZ' });
    expect(anyLocked()).toBe(true);

    const blocked = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    expect(blocked.status).toBe(429);
  });
});

describe('改密透明重哈希与两步验证共处一行', () => {
  /** 旧参数 scrypt 哈希（N=2^14）：登录成功会触发透明重哈希写入 */
  function legacyHash(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
  }

  it('重哈希不触碰 totp_secret，且重哈希后登录仍要求第二因子', async () => {
    const secret = generateTotpSecret();
    db.prepare('INSERT INTO admin_account (id, password_hash, totp_secret) VALUES (1, ?, ?)').run(
      legacyHash(PASSWORD),
      secret,
    );
    AdminAccountModel.confirmTotp();

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ password: PASSWORD, totpCode: codeNow(secret) });
    expect(login.status).toBe(200);

    const account = rawAccount();
    expect(account.password_hash).toMatch(/^scrypt\$131072\$8\$1\$/); // 已透明升级
    expect(account.totp_secret).toBe(secret); // 未被整行覆盖清空
    expect(account.totp_enabled).toBe(1);

    const again = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });
    expect(again.body.code).toBe(40105); // 第二因子仍然生效
  });
});
