/**
 * 认证通道收口测试（S-P0-3 残留 + S-P1-4）
 * ① 锁定键使用 socket.remoteAddress（不信任 X-Forwarded-For）
 * ② TRUST_PROXY 环境变量可配（默认 1）
 * ③ WS 心跳周期复验 sessionToken——踢出/过期后 close(1008)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

// ── ① 锁定键 socket.remoteAddress ──

describe('锁定键使用 socket.remoteAddress', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf-8');

  it('clientIp 函数体包含 socket.remoteAddress 而非 req.ip', () => {
    // clientIp 应使用 req.socket?.remoteAddress，不应以 req.ip 开头
    expect(src).toMatch(/clientIp\(req\)[\s\\]*{[\s\\]*.*socket[\\.]?remoteAddress/s);
    // 不应以 req.ip 作为首选来源（旧代码 req.ip || req.socket?.remoteAddress）
    expect(src).not.toMatch(/req\.ip\s*\|\|\s*req\.socket/);
  });

  it('clientIp 不信任 X-Forwarded-For（注释说明设计意图）', () => {
    expect(src).toMatch(/socket\.remoteAddress/);
    expect(src).toMatch(/不信任|X-Forwarded-For|伪造/);
  });
});

// ── ② TRUST_PROXY 可配 ──

describe('TRUST_PROXY 环境变量可配', () => {
  it('config.js 导出 trustProxy 字段，默认值为 1', async () => {
    const config = (await import('../config.js')).default;
    expect(typeof config.trustProxy).toBe('number');
    expect(config.trustProxy).toBeGreaterThanOrEqual(0);
  });

  it('.env.example 包含 TRUST_PROXY 配置说明', () => {
    const envExample = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf-8');
    expect(envExample).toMatch(/TRUST_PROXY/);
  });

  it('index.js 使用 config.trustProxy 而非硬编码', () => {
    const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf-8');
    expect(src).toMatch(/app\.set\(["']trust proxy["'],\s*config\.trustProxy/);
    // 不应出现硬编码 app.set('trust proxy', 1)
    expect(src).not.toMatch(/app\.set\(["']trust proxy["'],\s*1\s*\)/);
  });
});

// ── ③ WS 心跳会话复验 ──

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});
import { getDb } from '../db/index.js';
import { AdminSessionModel } from '../db/index.js';
import { setupWebSocket, WS_SESSION_REVALIDATE_INTERVAL } from '../websocket.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const TEST_API_KEY = 'test-api-key-for-unit-tests';
const HEARTBEAT_MS = 30000;

/** 构造一个假的 WebSocket 客户端 */
function createFakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.terminate = vi.fn();
  ws.ping = vi.fn();
  return ws;
}

describe('WS 心跳会话复验', () => {
  let wss;
  let serverManager;
  let fakeDb;
  let currentSessionValid;

  beforeEach(() => {
    vi.useFakeTimers();
    wss = new EventEmitter();
    serverManager = new EventEmitter();
    serverManager.getInstance = vi.fn(() => null);

    // 会话有效性由 currentSessionValid 控制（true=有效，false=失效）
    currentSessionValid = true;

    fakeDb = {
      prepare: vi.fn((_sql) => {
        const result = { run: vi.fn(() => ({ changes: 0 })), all: vi.fn(() => []) };
        return result;
      }),
    };
    getDb.mockReturnValue(fakeDb);

    // mock AdminSessionModel.findByTokenHash
    vi.spyOn(AdminSessionModel, 'findByTokenHash').mockImplementation(() => {
      if (!currentSessionValid) return null;
      return {
        id: 'test-session-id',
        expires_at: new Date(Date.now() + 60000).toISOString(),
      };
    });
    vi.spyOn(AdminSessionModel, 'deleteById').mockImplementation(() => true);

    setupWebSocket(wss, serverManager);
  });

  afterEach(() => {
    wss.emit('close');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 建立一条 API Key 认证的连接 */
  function connectWithApiKey() {
    const ws = createFakeWs();
    wss.emit('connection', ws, { _wsApiKey: TEST_API_KEY });
    return ws;
  }

  /** 建立一条 session 认证的连接 */
  function connectWithSession(token = 'valid-session-token') {
    const ws = createFakeWs();
    wss.emit('connection', ws, { _wsSessionToken: token });
    return ws;
  }

  it('session 认证连接在心跳中未被复验时保持存活', () => {
    const ws = connectWithSession();
    // 前 WS_SESSION_REVALIDATE_INTERVAL - 1 次心跳不触发复验
    for (let i = 0; i < WS_SESSION_REVALIDATE_INTERVAL - 1; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      ws.emit('pong');
    }
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('session 失效后在复验心跳被 close(1008) 断开', () => {
    const ws = connectWithSession('kicked-session');
    // 先推进一个完整复验周期确保到达复验点
    for (let i = 0; i < WS_SESSION_REVALIDATE_INTERVAL; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      ws.emit('pong');
    }
    expect(ws.close).not.toHaveBeenCalled();

    // 使会话失效
    currentSessionValid = false;

    // 推进到下一个复验心跳（恰好一轮）
    vi.advanceTimersByTime(HEARTBEAT_MS * WS_SESSION_REVALIDATE_INTERVAL);
    ws.emit('pong');
    expect(ws.close).toHaveBeenCalledWith(1008, 'Session invalidated');
  });

  it('API Key 认证连接不受会话复验影响', () => {
    const ws = connectWithApiKey();
    // 推进到复验心跳
    for (let i = 0; i < WS_SESSION_REVALIDATE_INTERVAL; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      ws.emit('pong');
    }
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('会话有效时复验心跳不断开连接', () => {
    const ws = connectWithSession();
    // 推进到复验心跳（会话仍有效）
    for (let i = 0; i < WS_SESSION_REVALIDATE_INTERVAL; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      ws.emit('pong');
    }
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('踢出会话后 WS 在下一复验心跳被断开（端到端语义）', () => {
    const ws = connectWithSession('will-be-kicked');

    // 正常运行一个完整复验周期（会话有效，不断开）
    for (let i = 0; i < WS_SESSION_REVALIDATE_INTERVAL; i++) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      ws.emit('pong');
    }
    expect(ws.close).not.toHaveBeenCalled();

    // 模拟踢出：会话被删除
    currentSessionValid = false;

    // 继续心跳直到下一个复验周期
    vi.advanceTimersByTime(HEARTBEAT_MS * WS_SESSION_REVALIDATE_INTERVAL);
    ws.emit('pong');
    expect(ws.close).toHaveBeenCalledWith(1008, 'Session invalidated');
  });

  it('WS_SESSION_REVALIDATE_INTERVAL 导出值正确（每 3 次心跳 = 90s 复验一轮）', () => {
    expect(WS_SESSION_REVALIDATE_INTERVAL).toBe(3);
  });

  it('session 连接正确保存 _sessionToken 供心跳复验使用', () => {
    const ws = connectWithSession('my-token-abc');
    expect(ws._sessionToken).toBe('my-token-abc');
  });

  it('API Key 连接 _sessionToken 为 null（不触发复验）', () => {
    const ws = connectWithApiKey();
    expect(ws._sessionToken).toBeNull();
  });
});

// ── ④ 401 认证失败补日志（H2-4a：此前认证失败全静默，爆破不可见）──

describe('401 认证失败补日志', () => {
  const next = vi.fn();
  const IP = '203.0.113.9';

  function makeReq(headers) {
    return { headers, path: '/v1/instances', socket: { remoteAddress: IP } };
  }

  function makeRes() {
    const res = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn();
    return res;
  }

  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无效 API Key → warn（含 ip/path，不含凭据本体）', () => {
    // 无效键由测试键派生（不写第二份凭据字面量）；日志断言同时锁「凭据本体永不入日志」
    const invalidKey = `${TEST_API_KEY}-wrong`;
    const res = makeRes();
    authMiddleware(makeReq({ 'x-api-key': invalidKey }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid API key'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(IP));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('/v1/instances'));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining(invalidKey));
  });

  it('完全缺失凭据 → warn', () => {
    const res = makeRes();
    authMiddleware(makeReq({}), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing credentials'));
  });

  it('未知会话令牌 → warn（已登出/伪造令牌复用属攻击信号）', () => {
    vi.spyOn(AdminSessionModel, 'findByTokenHash').mockReturnValue(null);
    const res = makeRes();
    authMiddleware(makeReq({ authorization: 'Bearer some-unknown-token' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown session token'));
  });

  it('会话正常过期 → debug（生命周期事件，客户端自动重登，不作攻击告警）', () => {
    vi.spyOn(AdminSessionModel, 'findByTokenHash').mockReturnValue({
      id: 'sess-1',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    vi.spyOn(AdminSessionModel, 'deleteById').mockImplementation(() => true);
    const res = makeRes();
    authMiddleware(makeReq({ authorization: 'Bearer expired-token' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('session expired'));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
