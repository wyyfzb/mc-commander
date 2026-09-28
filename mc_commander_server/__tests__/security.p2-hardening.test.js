/**
 * P2 安全小批打包测试（issue 324）
 *
 * 七项逐条覆盖：
 * - scrypt N=2^17：新哈希参数断言 + 参数不匹配/畸形存储串一律校验失败
 * - safeEqual 先 SHA-256 归一化再恒时比较：长度不等路径功能正确
 * - 认证前 JSON body 1MB：超限 413（entity.too.large 映射）
 * - /health 精简断言（health.test.js 专文件覆盖，此处不重复）
 * - deploy 脚本 Key 掩码（security.deploy.test.js 源码断言，此处不重复）
 * - 会话生命周期：30 天绝对过期（HTTP + WS 通道）、滑动续期 cap、
 *          每用户 5 会话上限挤最旧、登录路径惰性清理
 *
 * 真实 SQLite（临时目录）+ supertest，离线确定性。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import crypto from 'crypto';

// dataDir 指向临时目录（真实 SQLite），其余 config 保留实际值
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-p2-hardening-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminAccountModel, AdminSessionModel } from '../db/admin.model.js';
import {
  hashPassword,
  verifyPassword,
  safeEqual,
  hashToken,
  generateSessionToken,
} from '../utils/password.js';
import { authMiddleware, authenticateWebSocket } from '../middleware/auth.js';
import { createAuthRoutes, resetLoginLockState } from '../routes/auth.js';
import { errorHandler } from '../middleware/error_handler.js';
import { parseDbTime } from '../utils/db-time.js';

let app;
let db;

beforeAll(() => {
  db = initDatabase();
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM admin_sessions').run();
  db.prepare('DELETE FROM admin_account').run();
  resetLoginLockState();

  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use('/api/v1', createAuthRoutes());
  app.get('/api/v1/protected', (req, res) => res.json({ ok: true, auth: req.auth ?? null }));
  app.use(errorHandler);
});

// ──：scrypt 成本参数 ──

// 超时余量：本 describe 含 scrypt(N=131072) 哈希/校验（单次实测 ~270ms，成本由 N 决定）。
// 5s 默认值按空载耗时设定，并行争抢下没有余量（本批同类用例实测 5.16s 越线）；
// 显式放宽到本仓 15s 口径——scrypt 强度不因测试下调。
describe(' scrypt 成本参数（N=2^17）', { timeout: 15_000 }, () => {
  it('新哈希使用 N=131072 自描述参数', () => {
    const stored = hashPassword('some-password-1');
    expect(stored).toMatch(/^scrypt\$131072\$8\$/);
    expect(verifyPassword('some-password-1', stored)).toBe(true);
  });

  it('参数与当前参数不一致的存储串一律校验失败（单一参数集，不重算旧参数）', () => {
    // 用 N=16384 构造存储串：参数不匹配 → 直接 false，不进入重算路径
    const salt = crypto.randomBytes(16);
    const legacyHash = crypto.scryptSync('legacy-pass', salt, 64, { N: 16384, r: 8, p: 1 });
    const legacyStored = `scrypt$16384$8$1$${salt.toString('base64')}$${legacyHash.toString('base64')}`;
    expect(verifyPassword('legacy-pass', legacyStored)).toBe(false);

    const current = hashPassword('current-pass');
    expect(verifyPassword('current-pass', current)).toBe(true);
    expect(verifyPassword('wrong-pass', current)).toBe(false);
  });

  it('畸形存储串一律校验失败（不抛出）', () => {
    expect(verifyPassword('any', 'not-a-valid-hash')).toBe(false);
    expect(verifyPassword('any', 'md5$1$2$3$xx$yy')).toBe(false);
    expect(verifyPassword('any', 'scrypt$131072$8$1$xx')).toBe(false);
    expect(verifyPassword('any', 'scrypt$131072$8$1$xx$yy$zz')).toBe(false);
    // 空段：0 字节摘要会让 scryptSync(pw, salt, 0) 成功、safeEqual(空,空) 恒真
    expect(verifyPassword('any', 'scrypt$131072$8$1$$')).toBe(false);
    expect(verifyPassword('', 'scrypt$131072$8$1$$')).toBe(false);
    expect(verifyPassword('any', 'scrypt$131072$8$1$AAAAAA==$')).toBe(false);
    expect(verifyPassword('any', 'scrypt$131072$8$1$$AAAAAA==')).toBe(false);
  });

  it('空摘要段的记录不能被任意密码通过（登录语义：一律 40102）', async () => {
    // 直接种一行「0 字节摘要」的损坏记录：修复前该形状能让任意密码登录成功
    for (const broken of ['scrypt$131072$8$1$$', 'scrypt$131072$8$1$AAAAAA==$']) {
      AdminAccountModel.setPassword(broken);
      const res = await request(app).post('/api/v1/auth/login').send({ password: 'whatever-pass' });
      expect(res.status, `损坏记录 ${broken} 不得签发放行`).toBe(401);
      expect(res.body.code).toBe(40102);
    }
  });
});

// ──：safeEqual SHA-256 归一化 ──

describe(' safeEqual 归一化恒时比较', () => {
  it('等值 true / 不等 false', () => {
    expect(safeEqual('same-value', 'same-value')).toBe(true);
    expect(safeEqual('value-a', 'value-b')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('长度不等路径不再提前返回：两侧均归一化后比较（功能语义不变）', () => {
    // 长度差异显著但归一化后必不等 → false（长度信息不再影响判定路径）
    const short = 'ab';
    const long = 'a'.repeat(4096);
    expect(safeEqual(short, long)).toBe(false);
    // Buffer / 非 ASCII 输入同样安全
    expect(safeEqual(Buffer.from('bytes'), 'bytes')).toBe(true);
    expect(safeEqual('你好', '你好')).toBe(true);
    expect(safeEqual('你好', '你好世界')).toBe(false);
  });
});

// ──：认证前 JSON body 1MB（413 语义） ──

describe(' body 限制与 413 映射', () => {
  it('entity.too.large → 413（errorHandler 明确语义，不再落 500）', async () => {
    const mini = express();
    mini.use(express.json({ limit: '1kb' }));
    mini.post('/echo', (req, res) => res.json({ ok: true }));
    mini.use(errorHandler);

    const bigPayload = JSON.stringify({ blob: 'x'.repeat(8 * 1024) });
    const res = await request(mini)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(bigPayload);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toMatch(/too large/i);
  });

  it('config.bodyLimitJson 默认 1mb（认证前攻击面收口）', () => {
    expect(config.bodyLimitJson).toBe('1mb');
  });
});

// ──：会话生命周期 ──

describe(' 会话 30 天绝对过期', () => {
  function seedSession({ createdAtOffsetMs = 0, expiresInMs = 60_000 } = {}) {
    const token = generateSessionToken();
    // production 同口径：CURRENT_TIMESTAMP 的无时区 UTC 串（写 ISO 会让裸解析
    // 在任何时区下恰好正确，中间件的时区缺陷无法被测出）
    const created = new Date(Date.now() + createdAtOffsetMs)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    AdminSessionModel.create({
      tokenHash: hashToken(token),
      userAgent: 'vitest-p2',
      ip: '127.0.0.1',
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    });
    // 回写 created_at / last_seen_at 模拟历史会话（create 均为 CURRENT_TIMESTAMP
    // 默认值；last_seen_at 同步回写以越过 60s touch 节流窗口）
    db.prepare(
      'UPDATE admin_sessions SET created_at = ?, last_seen_at = ? WHERE token_hash = ?',
    ).run(created, created, hashToken(token));
    return token;
  }

  it('HTTP 通道：created_at + 30d 内正常放行', () => {
    const token = seedSession({ createdAtOffsetMs: -29 * 86400_000 });
    const req = { headers: { authorization: `Bearer ${token}` }, path: '/v1/protected' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const next = vi.fn();
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('HTTP 通道：超过 30 天绝对过期 → 401 且会话行被清理', () => {
    const token = seedSession({ createdAtOffsetMs: -31 * 86400_000 });
    const req = { headers: { authorization: `Bearer ${token}` }, path: '/v1/protected' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const next = vi.fn();

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    // 会话行被惰性清理
    expect(AdminSessionModel.findByTokenHash(hashToken(token))).toBeNull();
  });

  it('WS 通道同步校验绝对过期：超 30 天 → false 且行清理', () => {
    const token = seedSession({ createdAtOffsetMs: -31 * 86400_000 });
    expect(authenticateWebSocket(null, token)).toBe(null);
    expect(AdminSessionModel.findByTokenHash(hashToken(token))).toBeNull();
  });

  it('滑动续期 cap：touch 后 expires_at 不越过 created_at + 30d 边界', async () => {
    // created_at = 29.5 天前；滑动 ttl 默认 7 天 → 无 cap 时会越过 30d 边界
    const token = seedSession({ createdAtOffsetMs: -29.5 * 86400_000 });
    const session = AdminSessionModel.findByTokenHash(hashToken(token));
    const req = { headers: { authorization: `Bearer ${token}` }, path: '/v1/protected' };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const next = vi.fn();

    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();

    const touched = AdminSessionModel.getById(session.id);
    const expiresAt = new Date(touched.expires_at).getTime();
    // created_at 为 CURRENT_TIMESTAMP 的无时区 UTC 串，断言侧同经 parseDbTime 归一化
    const absoluteLimit = parseDbTime(touched.created_at) + config.adminSession.absoluteTtlMs;
    expect(expiresAt).toBeLessThanOrEqual(absoluteLimit);
    // 且确实被续期过（长于剩余滑动窗口起点）
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});

describe(' 会话并发上限（每用户 5 条挤最旧）', () => {
  it('enforceLimit：保留最近活跃 5 条，挤掉最旧', () => {
    const ids = [];
    for (let i = 0; i < 7; i++) {
      const id = `sess-${i}`;
      db.prepare(
        `INSERT INTO admin_sessions (id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        `hash-${i}`,
        'ua',
        '127.0.0.1',
        new Date(Date.now() - (10 - i) * 1000).toISOString(),
        new Date(Date.now() - (10 - i) * 1000).toISOString(),
        new Date(Date.now() + 3600_000).toISOString(),
      );
      ids.push(id);
    }
    const evicted = AdminSessionModel.enforceLimit(5);
    expect(evicted).toBe(2);
    // 最旧的 sess-0 / sess-1 被挤掉，最新 5 条保留
    expect(AdminSessionModel.getById('sess-0')).toBeNull();
    expect(AdminSessionModel.getById('sess-1')).toBeNull();
    for (const id of ids.slice(2)) {
      expect(AdminSessionModel.getById(id)).not.toBeNull();
    }
  });

  it('未超限时零删除；过期行先惰性清理再计数', () => {
    expect(AdminSessionModel.enforceLimit(5)).toBe(0);
    // 过期行不占限额（先清理）
    db.prepare(
      `INSERT INTO admin_sessions (id, token_hash, user_agent, ip, created_at, last_seen_at, expires_at)
       VALUES ('expired-1', 'hash-e', 'ua', '127.0.0.1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
    ).run(new Date(Date.now() - 1000).toISOString());
    expect(AdminSessionModel.enforceLimit(5)).toBe(0);
    expect(AdminSessionModel.getById('expired-1')).toBeNull();
  });

  it('登录路径集成：第 6 次登录挤掉最旧会话（登录即惰性清理触发点）', {
    timeout: 30000,
  }, async () => {
    AdminAccountModel.setPassword(hashPassword('session-limit-pass'));

    const tokens = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ password: 'session-limit-pass' });
      expect(res.status).toBe(200);
      tokens.push(res.body.data.token);
      // SQLite CURRENT_TIMESTAMP 为秒级且格式为 "YYYY-MM-DD HH:MM:SS"（空格
      // 分隔，与 ISO 的 "T" 分隔字符串序不同）——回写必须用同格式，否则混排
      // 时 SQLite 格式恒小于 ISO 格式（空格 0x20 < 'T' 0x54）导致排序失真。
      // 生产路径 touch() 始终写 CURRENT_TIMESTAMP，无此混合问题。
      const sqliteTs = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
      db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?').run(
        sqliteTs(new Date(Date.now() - (6 - i) * 60_000)),
        hashToken(tokens[i]),
      );
    }

    // 第 1 个（最旧）被挤出，第 2-6 个保留
    expect(AdminSessionModel.findByTokenHash(hashToken(tokens[0]))).toBeNull();
    for (const t of tokens.slice(1)) {
      expect(AdminSessionModel.findByTokenHash(hashToken(t))).not.toBeNull();
    }
  });
});
