import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  rateLimit,
  apiKeyRateLimit,
  _clearRateLimitMap,
  _getRateLimitMapSize,
  _pruneExpired,
} from '../middleware/rate_limit.js';

// find-009：限流键可伪造 + Map 无上限 + 24h 清理周期过长
// 修复验证：默认键用真实连接 IP、apiKey 截断 128、容量上限 LRU、窗口级清理

function makeReq(remoteIp, headers = {}) {
  return { socket: { remoteAddress: remoteIp }, headers, ip: remoteIp };
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

describe('rateLimit keyGenerator（find-009 修复）', () => {
  beforeEach(() => {
    _clearRateLimitMap();
  });

  it('默认 keyGenerator 使用真实连接 IP（req.socket.remoteAddress）', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 2 });
    const req = makeReq('203.0.113.10');
    const res = makeRes();
    const next = vi.fn();

    // 同 IP 第 1、2 次放行，第 3 次 429
    limiter(req, res, next);
    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();

    limiter(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', code: 42900 })
    );
  });

  it('不同真实连接 IP 使用独立限流桶', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1 });

    // 第一个 IP 超限后 429
    const res1 = makeRes();
    limiter(makeReq('203.0.113.11'), res1, vi.fn());
    limiter(makeReq('203.0.113.11'), res1, vi.fn());
    expect(res1.status).toHaveBeenCalledWith(429);

    // 第二个 IP 不受影响（独立桶）
    const res2 = makeRes();
    limiter(makeReq('203.0.113.12'), res2, vi.fn());
    expect(res2.status).not.toHaveBeenCalled();
  });

  it('X-Forwarded-For 头无法伪造限流键（默认键不取自 req.ip）', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1 });
    const req = makeReq('203.0.113.20', { 'x-forwarded-for': '198.51.100.1' });
    const res = makeRes();

    limiter(req, res, vi.fn());
    limiter(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(429);

    // 伪造不同的 XFF 再请求，仍命中同一桶（键基于真实连接 IP）
    const res2 = makeRes();
    const req2 = makeReq('203.0.113.20', { 'x-forwarded-for': '198.51.100.2' });
    limiter(req2, res2, vi.fn());
    expect(res2.status).toHaveBeenCalledWith(429);
  });

  it('显式传入 keyGenerator 时使用自定义键（保持原能力）', () => {
    const limiter = rateLimit({
      windowMs: 60000,
      max: 1,
      keyGenerator: (req) => `custom:${req.headers['x-custom']}`,
    });
    const res = makeRes();
    const next = vi.fn();

    limiter(makeReq('203.0.113.30', { 'x-custom': 'bucket-a' }), res, next);
    limiter(makeReq('203.0.113.30', { 'x-custom': 'bucket-a' }), res, next);
    expect(res.status).toHaveBeenCalledWith(429);
  });
});

describe('apiKeyRateLimit（find-009 修复）', () => {
  beforeEach(() => {
    _clearRateLimitMap();
  });

  it('x-api-key 超长时截断 128 字符，前 128 字符相同的键共享同一桶', () => {
    const limiter = apiKeyRateLimit({ windowMs: 60000, max: 2 });
    const longKeyA = 'A'.repeat(200);
    const longKeyAB = 'A'.repeat(200) + 'B'; // 与 longKeyA 前 128 字符相同

    // 用 longKeyA 打满桶（2 次放行后第 3 次 429）
    const resA = makeRes();
    limiter(makeReq('203.0.113.40', { 'x-api-key': longKeyA }), resA, vi.fn());
    limiter(makeReq('203.0.113.40', { 'x-api-key': longKeyA }), resA, vi.fn());
    expect(resA.status).not.toHaveBeenCalled();
    limiter(makeReq('203.0.113.40', { 'x-api-key': longKeyA }), resA, vi.fn());
    expect(resA.status).toHaveBeenCalledWith(429);

    // 前 128 字符相同的另一个超长 key 应命中同一桶（立即 429）
    const resAB = makeRes();
    limiter(makeReq('203.0.113.40', { 'x-api-key': longKeyAB }), resAB, vi.fn());
    expect(resAB.status).toHaveBeenCalledWith(429);

    // 前缀不同的 key 使用独立桶
    const resC = makeRes();
    limiter(makeReq('203.0.113.40', { 'x-api-key': 'C'.repeat(200) }), resC, vi.fn());
    expect(resC.status).not.toHaveBeenCalled();
  });

  it('无 x-api-key 时回退到真实连接 IP 作为键', () => {
    const limiter = apiKeyRateLimit({ windowMs: 60000, max: 1 });

    const res1 = makeRes();
    limiter(makeReq('203.0.113.50'), res1, vi.fn());
    limiter(makeReq('203.0.113.50'), res1, vi.fn());
    expect(res1.status).toHaveBeenCalledWith(429);

    // 不同 IP 独立桶
    const res2 = makeRes();
    limiter(makeReq('203.0.113.51'), res2, vi.fn());
    expect(res2.status).not.toHaveBeenCalled();
  });
});

describe('rateLimit Map 容量上限（LRU，find-009 修复）', () => {
  beforeEach(() => {
    _clearRateLimitMap();
  });

  it('超过 maxKeys 时淘汰最久未使用的键，最新请求仍受保护', () => {
    const limiter = rateLimit({ windowMs: 60000, max: 1, maxKeys: 5 });

    // 依次用 6 个不同 IP 各请求 1 次，第 6 个触发容量淘汰
    for (let i = 1; i <= 6; i++) {
      const res = makeRes();
      limiter(makeReq(`203.0.113.6${i}`), res, vi.fn());
      expect(res.status).not.toHaveBeenCalled();
    }

    // 容量被控制在上限内
    expect(_getRateLimitMapSize()).toBeLessThanOrEqual(5);

    // 最旧的键（ip.61~63）已被 LRU 淘汰，再来请求视为新桶放行
    const resOld = makeRes();
    limiter(makeReq('203.0.113.61'), resOld, vi.fn());
    expect(resOld.status).not.toHaveBeenCalled();

    // 仍存活的键（ip.64）已累计到 max=1，再次请求应 429
    const resAlive = makeRes();
    limiter(makeReq('203.0.113.64'), resAlive, vi.fn());
    expect(resAlive.status).toHaveBeenCalledWith(429);
  });
});

describe('窗口级空闲清理（find-009 修复）', () => {
  beforeEach(() => {
    _clearRateLimitMap();
  });

  it('键空闲超过其 windowMs×2 即被删除，未超过则保留', () => {
    const limiter = rateLimit({ windowMs: 1000, max: 5 });
    const now = Date.now();

    limiter(makeReq('203.0.113.70'), makeRes(), vi.fn());
    expect(_getRateLimitMapSize()).toBe(1);

    // 空闲 1.5 倍窗口：未超过 2 倍，保留
    _pruneExpired(now + 1500);
    expect(_getRateLimitMapSize()).toBe(1);

    // 空闲超过 2 倍窗口（留出采样与执行间的时间差余量）：删除
    _pruneExpired(now + 2500);
    expect(_getRateLimitMapSize()).toBe(0);
  });
});
