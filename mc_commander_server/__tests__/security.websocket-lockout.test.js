/**
 * WS 认证失败 IP 临时封禁测试（H2-4a）：
 * - 连续失败达到阈值（AUTH_LOGIN_MAX_FAILS 默认 10）→ IP 锁定：锁定窗口内
 *   即使凭据正确也拒绝（close 1008 'Too many auth failures'）
 * - 认证成功清零失败计数；锁定到期后放行；不同 IP 互不影响
 * - 跨通道共享：WS 失败计入的锁定同样封锁 HTTP 登录通道（同一凭据面不可
 *   通过分流通道绕开）
 * 地址使用 TEST-NET 虚构段，严禁真实服务器信息
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { setupWebSocket } from '../websocket.js';
import { resetForTests, isLockedForTests } from '../utils/credential-lockout.js';
import { _isLoginLocked } from '../routes/auth.js';
import { logger } from '../utils/logger.js';

vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
}));
import { getDb } from '../db/index.js';

/** 测试键从 vitest env 读取（vitest.config.js 注入的固定测试键，禁止真实凭据入库） */
const TEST_API_KEY = process.env.API_KEY;
const BAD_KEY = 'wrong-key-for-lockout-test';
const IP = '203.0.113.10';
const OTHER_IP = '203.0.113.11';
/** 与 config 默认一致（AUTH_LOGIN_MAX_FAILS 未在 vitest env 覆盖） */
const LOCK_MAX_FAILS = 10;
const LOCK_MS = 300_000;

function createFakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.terminate = vi.fn();
  ws.ping = vi.fn();
  return ws;
}

describe('WS 认证失败 IP 临时封禁', () => {
  let wss;
  let serverManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    wss = new EventEmitter();
    serverManager = new EventEmitter();
    serverManager.getInstance = vi.fn(() => null);
    getDb.mockReturnValue({
      prepare: vi.fn(() => ({ run: vi.fn(() => ({ changes: 0 })), all: vi.fn(() => []) })),
    });
    resetForTests();
    setupWebSocket(wss, serverManager);
  });

  afterEach(() => {
    wss.emit('close');
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  /** 以指定凭据与直连 IP 发起一次连接（服务端读 req.socket.remoteAddress） */
  function connectWith(key, ip = IP) {
    const ws = createFakeWs();
    wss.emit('connection', ws, { _wsApiKey: key, socket: { remoteAddress: ip } });
    return ws;
  }

  it(`连续失败 ${LOCK_MAX_FAILS} 次后 IP 锁定：锁定窗口内正确凭据也被拒`, () => {
    for (let i = 0; i < LOCK_MAX_FAILS; i++) {
      const ws = connectWith(BAD_KEY);
      expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    }
    expect(isLockedForTests(IP)).toBe(true);
    // 触发锁定的一次性告警（不逐请求刷日志）
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('IP now locked'));

    // 锁定窗口内：正确凭据也不放行（封禁语义，非「再试一次」）
    const valid = connectWith(TEST_API_KEY);
    expect(valid.close).toHaveBeenCalledWith(1008, 'Too many auth failures');

    // 跨通道共享：同一凭据面的 HTTP 登录通道同样被封锁
    expect(_isLoginLocked(IP)).toBe(true);
  });

  it('认证成功清零失败计数：9 失败 → 成功 → 再 9 失败不触发锁定', () => {
    for (let i = 0; i < LOCK_MAX_FAILS - 1; i++) connectWith(BAD_KEY);
    const ok = connectWith(TEST_API_KEY);
    expect(ok.close).not.toHaveBeenCalled();

    for (let i = 0; i < LOCK_MAX_FAILS - 1; i++) connectWith(BAD_KEY);
    expect(isLockedForTests(IP)).toBe(false);
    const final = connectWith(TEST_API_KEY);
    expect(final.close).not.toHaveBeenCalled();
  });

  it('锁定到期后放行（loginLockMs 后凭据校验恢复）', () => {
    for (let i = 0; i < LOCK_MAX_FAILS; i++) connectWith(BAD_KEY);
    expect(isLockedForTests(IP)).toBe(true);

    vi.advanceTimersByTime(LOCK_MS + 1);
    const ws = connectWith(TEST_API_KEY);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('不同 IP 互不影响：A 被锁不影响 B 正常连接', () => {
    for (let i = 0; i < LOCK_MAX_FAILS; i++) connectWith(BAD_KEY, IP);
    expect(isLockedForTests(IP)).toBe(true);

    const other = connectWith(TEST_API_KEY, OTHER_IP);
    expect(other.close).not.toHaveBeenCalled();
  });
});
