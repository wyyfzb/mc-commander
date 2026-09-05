import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  setupWebSocket,
  WSEvents,
  MAX_CONNECTIONS,
  MAX_SUBSCRIPTIONS_PER_CLIENT,
  REPLAY_THROTTLE_MS,
  MESSAGE_RATE_WINDOW_MS,
  MAX_MESSAGES_PER_WINDOW,
} from '../websocket.js';

// Mock 数据库：重放查询返回预设事件（验证节流不阻断合法重放）
vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
}));
import { getDb } from '../db/index.js';

const TEST_API_KEY = 'test-api-key-for-unit-tests';

/** 构造一个假的 WebSocket 客户端（EventEmitter + send/close/terminate/ping 间谍） */
function createFakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.terminate = vi.fn();
  ws.ping = vi.fn();
  return ws;
}

describe('WebSocket 资源上限与频率限制', () => {
  let wss;
  let serverManager;
  let fakeDb;

  beforeEach(() => {
    // fake timers 需在 setupWebSocket 之前启用：心跳 interval 与
    // 节流窗口（Date.now）都依赖可控时钟
    vi.useFakeTimers();
    wss = new EventEmitter();
    serverManager = new EventEmitter();
    // 默认无实例：subscribe 不产生 status 快照，便于精确断言重放/error 消息
    serverManager.getInstance = vi.fn(() => null);

    // 假 DB：重放查询返回 1 条预设事件（id = lastEventId + 1）
    fakeDb = {
      prepare: vi.fn((sql) => {
        if (sql.includes('SELECT id, instance_id, type, data')) {
          return {
            all: (lastEventId, instanceId) => [
              {
                id: lastEventId + 1,
                instance_id: instanceId,
                type: WSEvents.PLAYER_JOIN,
                data: JSON.stringify({ name: 'Alice' }),
                created_at: '2026-08-11T00:00:00.000Z',
              },
            ],
          };
        }
        return { run: vi.fn(), all: vi.fn(() => []) };
      }),
    };
    getDb.mockReturnValue(fakeDb);

    setupWebSocket(wss, serverManager);
  });

  afterEach(() => {
    // 清理心跳定时器
    wss.emit('close');
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  /** 建立一条已认证连接 */
  function connect() {
    const ws = createFakeWs();
    wss.emit('connection', ws, { _wsApiKey: TEST_API_KEY });
    return ws;
  }

  /** 取出 ws.send 全部消息并解析为 JSON */
  function sentJson(ws) {
    return ws.send.mock.calls.map((c) => JSON.parse(c[0]));
  }

  it(`连接数达到上限（${'MAX_CONNECTIONS'}）后拒绝新连接（1013）`, () => {
    // 前 MAX_CONNECTIONS 个连接正常建立
    for (let i = 0; i < MAX_CONNECTIONS; i++) {
      const ws = connect();
      expect(ws.close).not.toHaveBeenCalled();
    }
    // 第 MAX_CONNECTIONS + 1 个连接被拒绝
    const rejected = createFakeWs();
    wss.emit('connection', rejected, { _wsApiKey: TEST_API_KEY });
    expect(rejected.close).toHaveBeenCalledWith(1013, 'Too many connections');
    // 被拒绝的连接不注册消息监听、不广播任何事件
    serverManager.emit('instance:log', { instanceId: 's1', text: 'x', type: 'stdout' });
    expect(rejected.send).not.toHaveBeenCalled();
  });

  it(`订阅实例数达到上限（${'MAX_SUBSCRIPTIONS_PER_CLIENT'}）后拒绝新增订阅`, () => {
    const ws = connect();
    // 通过正常消息路径订阅少量实例（验证订阅功能本身正常）
    for (let i = 0; i < 3; i++) {
      ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId: `s${i}` }));
    }
    // 直接填充订阅集合到上限（模拟已订阅 MAX_SUBSCRIPTIONS_PER_CLIENT 个实例）。
    // 逐条发消息会触发消息频率限制（60 msg/min），故直接构造内部状态
    for (let i = 3; i < MAX_SUBSCRIPTIONS_PER_CLIENT; i++) {
      ws.subscribedInstances.add(`s${i}`);
    }
    ws.send.mockClear();

    // 超限的新实例订阅：拒绝并返回 error 消息
    ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId: 'overflow' }));
    const err = sentJson(ws).find((m) => m.type === WSEvents.ERROR);
    expect(err).toBeTruthy();
    expect(err.data.message).toBe('Too many subscriptions');

    // 订阅未生效：该实例的广播不会送达
    serverManager.emit('instance:log', { instanceId: 'overflow', text: 'x', type: 'stdout' });
    expect(sentJson(ws).some((m) => m.type === 'log')).toBe(false);

    // 幂等重复订阅已有实例仍放行（不打断断线补齐重放）
    ws.send.mockClear();
    ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId: 's0', lastEventId: 1 }));
    expect(sentJson(ws).some((m) => m.id === 2)).toBe(true);
  });

  it(`同一实例的断线补齐重放节流（${'REPLAY_THROTTLE_MS'}ms 内仅一次）`, () => {
    const ws = connect();
    const subscribeWithReplay = () => {
      ws.send.mockClear();
      ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId: 's1', lastEventId: 100 }));
      return sentJson(ws);
    };

    // 首次：正常重放 1 条（id=101）
    expect(subscribeWithReplay().filter((m) => m.id === 101)).toHaveLength(1);

    // 节流窗口内再次：无重放，返回 error 提示
    const msgs2 = subscribeWithReplay();
    expect(msgs2.filter((m) => m.id === 101)).toHaveLength(0);
    expect(msgs2.find((m) => m.type === WSEvents.ERROR)?.data.message).toMatch(/throttled/i);

    // 窗口滚动后恢复重放
    vi.advanceTimersByTime(REPLAY_THROTTLE_MS);
    expect(subscribeWithReplay().filter((m) => m.id === 101)).toHaveLength(1);
  });

  it(`消息频率超过上限（${'MAX_MESSAGES_PER_WINDOW'} msg/min）时断开连接（1008）`, () => {
    const ws = connect();
    // 窗口内发满上限条消息：不断开
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) {
      ws.emit('message', JSON.stringify({ type: 'ping' }));
    }
    expect(ws.close).not.toHaveBeenCalled();

    // 超限一条：断开
    ws.emit('message', JSON.stringify({ type: 'ping' }));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Message rate limit exceeded');

    // 窗口滚动（MESSAGE_RATE_WINDOW_MS）后计数重置，不再立即断开
    const closeCalls = ws.close.mock.calls.length;
    vi.advanceTimersByTime(MESSAGE_RATE_WINDOW_MS);
    ws.emit('message', JSON.stringify({ type: 'ping' }));
    expect(ws.close.mock.calls.length).toBe(closeCalls);
  });
});
