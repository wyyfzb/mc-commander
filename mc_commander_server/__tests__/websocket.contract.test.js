import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { setupWebSocket, WSEvents } from '../websocket.js';

// vitest.config.js 注入 API_KEY=test-api-key-for-unit-tests，
// authenticateWebSocket 通过 config.apiKey 读取该值，无需 mock 认证逻辑
const TEST_API_KEY = 'test-api-key-for-unit-tests';

/** 构造一个假的 WebSocket 客户端（EventEmitter + send 间谍） */
function createFakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  return ws;
}

/** 取出 ws.send 第 n 次调用的消息并解析为 JSON */
function sentMessage(ws, n = 0) {
  expect(ws.send.mock.calls.length).toBeGreaterThan(n);
  return JSON.parse(ws.send.mock.calls[n][0]);
}

describe('WebSocket 事件格式契约', () => {
  let wss;
  let serverManager;

  beforeEach(() => {
    wss = new EventEmitter();
    serverManager = new EventEmitter();
    serverManager.getInstance = vi.fn();
    setupWebSocket(wss, serverManager);
  });

  /** 建立一条已认证连接，并订阅指定实例 */
  function connectAndSubscribe(instanceId) {
    const ws = createFakeWs();
    wss.emit('connection', ws, { _wsApiKey: TEST_API_KEY });
    ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId }));
    ws.send.mockClear();
    return ws;
  }

  describe('WSEvents 事件名常量（前后端契约）', () => {
    it('核心事件名必须保持稳定（对外契约，改名即破坏性变更）', () => {
      expect(WSEvents.LOG).toBe('log');
      expect(WSEvents.STATUS).toBe('status');
      expect(WSEvents.PLAYER_JOIN).toBe('playerJoin');
    });
  });

  describe('消息信封结构', () => {
    it('广播消息必须且仅含 type/instanceId/data/timestamp 四个顶层字段', () => {
      const ws = connectAndSubscribe('s1');

      serverManager.emit('instance:log', { instanceId: 's1', text: 'hi', type: 'stdout' });

      const msg = sentMessage(ws);
      expect(Object.keys(msg).sort()).toEqual(['data', 'instanceId', 'timestamp', 'type']);
      expect(typeof msg.timestamp).toBe('number');
    });
  });

  describe('log 事件', () => {
    it('instance:log 应广播 type=log 且 data 含 text/type 字段', () => {
      const ws = connectAndSubscribe('s1');

      serverManager.emit('instance:log', { instanceId: 's1', text: '[Server] Done', type: 'stdout' });

      const msg = sentMessage(ws);
      expect(msg.type).toBe('log');
      expect(msg.instanceId).toBe('s1');
      expect(msg.data).toMatchObject({ text: '[Server] Done', type: 'stdout' });
    });
  });

  describe('status 事件', () => {
    it('instance:status 应广播 type=status 且 data 含 event 字段', () => {
      const ws = connectAndSubscribe('s1');

      serverManager.emit('instance:status', { instanceId: 's1', event: 'stopped', code: 0 });

      const msg = sentMessage(ws);
      expect(msg.type).toBe('status');
      expect(msg.instanceId).toBe('s1');
      expect(msg.data).toMatchObject({ event: 'stopped', code: 0 });
    });

    it('subscribe 应立即回发 status 快照，data 含 status/isRunning/players/tps', () => {
      serverManager.getInstance.mockReturnValue({
        status: 'running',
        isRunning: true,
        players: [{ name: 'Alice' }],
        tps: 20,
      });
      const ws = createFakeWs();
      wss.emit('connection', ws, { _wsApiKey: TEST_API_KEY });

      ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId: 's1' }));

      const msg = sentMessage(ws);
      expect(msg.type).toBe('status');
      expect(msg.instanceId).toBe('s1');
      expect(Object.keys(msg.data).sort()).toEqual(['isRunning', 'players', 'status', 'tps']);
      expect(msg.data.isRunning).toBe(true);
      expect(msg.data.players).toEqual([{ name: 'Alice' }]);
    });
  });

  describe('playerJoin 事件', () => {
    it('instance:playerJoin 应广播 type=playerJoin 且 data 含玩家字段', () => {
      const ws = connectAndSubscribe('s1');

      serverManager.emit('instance:playerJoin', {
        instanceId: 's1',
        name: 'Alice',
        joinTime: 1700000000000,
        ip: '127.0.0.1',
        totalPlayTime: 3600,
      });

      const msg = sentMessage(ws);
      expect(msg.type).toBe('playerJoin');
      expect(msg.instanceId).toBe('s1');
      expect(msg.data).toMatchObject({
        name: 'Alice',
        joinTime: 1700000000000,
        ip: '127.0.0.1',
        totalPlayTime: 3600,
      });
    });
  });

  describe('订阅过滤与认证', () => {
    it('未订阅该实例的客户端不应收到广播', () => {
      const subscribed = connectAndSubscribe('s1');
      const other = connectAndSubscribe('s2');

      serverManager.emit('instance:playerJoin', { instanceId: 's1', name: 'Alice' });

      expect(subscribed.send).toHaveBeenCalledTimes(1);
      expect(other.send).not.toHaveBeenCalled();
    });

    it('API Key 无效时应以 1008 关闭连接且不广播任何事件', () => {
      const ws = createFakeWs();
      wss.emit('connection', ws, { _wsApiKey: 'wrong-key' });

      expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');

      serverManager.emit('instance:log', { instanceId: 's1', text: 'x', type: 'stdout' });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });
});
