/**
 * WS 首帧鉴权通道测试（H2-4b）：
 * - 无 subprotocol 凭据的连接：第一条消息必须是 auth，成功后回执
 *   {type:'auth', ok:true} 并可正常订阅
 * - 首条非 auth / 凭据错误 / pending 期消息风暴 → close(1008) 并计入封禁计数
 * - 超时与 pending 期断开不计数（网络慢≠爆破）
 * - 会话令牌首帧鉴权后 _sessionToken 保存（心跳复验可用）
 * 地址使用 TEST-NET 虚构段，严禁真实服务器信息
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  setupWebSocket,
  WS_AUTH_TIMEOUT_MS,
  ClientMessages,
} from '../websocket.js';
import { resetForTests, isLockedForTests } from '../utils/credential-lockout.js';
import { logger } from '../utils/logger.js';

vi.mock('../db/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getDb: vi.fn(),
}));
import { getDb, AdminSessionModel } from '../db/index.js';

/** 测试键从 vitest env 读取（vitest.config.js 注入的固定测试键，禁止真实凭据入库） */
const TEST_API_KEY = process.env.API_KEY;
const BAD_KEY = 'wrong-key-for-first-frame-test';
const IP = '203.0.113.10';

function createFakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.terminate = vi.fn();
  ws.ping = vi.fn();
  return ws;
}

describe('WS 首帧鉴权通道（H2-4b）', () => {
  let wss;
  let serverManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
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

  /** 建立一条无 subprotocol 凭据的 pending 连接（首帧鉴权通道） */
  function connectFirstFrame(ip = IP) {
    const ws = createFakeWs();
    wss.emit('connection', ws, { socket: { remoteAddress: ip } });
    return ws;
  }

  function sentJson(ws) {
    return ws.send.mock.calls.map((c) => JSON.parse(c[0]));
  }

  it('首帧 auth（API Key）成功：回执 ok + 后续 subscribe 正常工作', () => {
    const ws = connectFirstFrame();
    ws.emit('message', JSON.stringify({ type: ClientMessages.AUTH, apiKey: TEST_API_KEY }));

    const authReply = sentJson(ws).find((m) => m.type === ClientMessages.AUTH);
    expect(authReply).toMatchObject({ ok: true });

    // 鉴权后进入正常收发：订阅被接受（无效订阅目标不产生 error 响应）
    ws.emit('message', JSON.stringify({ type: ClientMessages.SUBSCRIBE, instanceId: 's1' }));
    const errors = sentJson(ws).filter((m) => m.type === 'error');
    expect(errors).toHaveLength(0);
  });

  it('首帧 auth（会话令牌）成功：_sessionToken 保存供心跳复验', () => {
    vi.spyOn(AdminSessionModel, 'findByTokenHash').mockReturnValue({
      id: 'sess-1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const ws = connectFirstFrame();
    ws.emit('message', JSON.stringify({ type: ClientMessages.AUTH, sessionToken: 'valid-session-token' }));

    expect(sentJson(ws).find((m) => m.type === ClientMessages.AUTH)).toMatchObject({ ok: true });
    expect(ws._sessionToken).toBe('valid-session-token');
  });

  it('首条消息非 auth（直接 subscribe）→ 1008 Unauthorized 并计入封禁', () => {
    const ws = connectFirstFrame();
    ws.emit('message', JSON.stringify({ type: ClientMessages.SUBSCRIBE, instanceId: 's1' }));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    // 连续 10 次未认证使用即触发锁定（与凭据爆破同口径）
    for (let i = 0; i < 9; i++) {
      const again = connectFirstFrame();
      again.emit('message', JSON.stringify({ type: ClientMessages.SUBSCRIBE, instanceId: 's1' }));
    }
    expect(isLockedForTests(IP)).toBe(true);
  });

  it('首帧凭据错误 → 1008 Unauthorized 并计入封禁', () => {
    const ws = connectFirstFrame();
    ws.emit('message', JSON.stringify({ type: ClientMessages.AUTH, apiKey: BAD_KEY }));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(isLockedForTests(IP)).toBe(false);
  });

  it('pending 期非 JSON 消息 → 1008 Unauthorized', () => {
    const ws = connectFirstFrame();
    ws.emit('message', 'not-json');
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
  });

  it(`auth 等待超过 ${WS_AUTH_TIMEOUT_MS}ms → 1008 Auth timeout，不计入封禁`, () => {
    const ws = connectFirstFrame();
    vi.advanceTimersByTime(WS_AUTH_TIMEOUT_MS + 1);
    expect(ws.close).toHaveBeenCalledWith(1008, 'Auth timeout');
    expect(isLockedForTests(IP)).toBe(false);
  });

  it('pending 期客户端断开：清理 pending 且不计入封禁', () => {
    const ws = connectFirstFrame();
    ws.emit('close');
    for (let i = 0; i < 20; i++) {
      const again = connectFirstFrame();
      again.emit('close');
    }
    expect(isLockedForTests(IP)).toBe(false);
  });

  it('鉴权成功：auth ok 回执先于部署快照（客户端鉴权门控不丢补发）', () => {
    // 预置一个进行中部署：setupAuthenticatedClient 登记后立即补发快照，
    // 若回执晚于快照，客户端 authenticated=false 门控会丢弃部署进度
    serverManager.activeDeploys = new Map([
      ['dep-1', { stage: 'download', percent: 30, updatedAt: Date.now() }],
    ]);
    try {
      const ws = connectFirstFrame();
      ws.emit('message', JSON.stringify({ type: ClientMessages.AUTH, apiKey: TEST_API_KEY }));
      const types = sentJson(ws).map((m) => m.type);
      expect(types.indexOf('auth')).toBeLessThan(types.indexOf('deployProgress'));
    } finally {
      serverManager.activeDeploys = undefined;
    }
  });

  it('鉴权成功后 pending 集合清理：同一连接不再重复进入 pending 统计', () => {
    const ws = connectFirstFrame();
    ws.emit('message', JSON.stringify({ type: ClientMessages.AUTH, apiKey: TEST_API_KEY }));
    expect(sentJson(ws).find((m) => m.type === ClientMessages.AUTH)).toMatchObject({ ok: true });

    // 后续 subscribe 正常走主消息管线（auth ok 已回执，订阅无 error）
    ws.emit('message', JSON.stringify({ type: ClientMessages.SUBSCRIBE, instanceId: 's1' }));
    ws.emit('message', JSON.stringify({ type: ClientMessages.SUBSCRIBE, instanceId: 's2' }));
    const errors = sentJson(ws).filter((m) => m.type === 'error');
    expect(errors).toHaveLength(0);
  });
});
