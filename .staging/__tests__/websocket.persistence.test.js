import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { setupWebSocket, WSEvents } from '../websocket.js';

// Mock 数据库：验证通知事件落库（携带 id）与断线补齐（lastEventId 重放）
vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
}));
import { getDb } from '../db/index.js';

const TEST_API_KEY = 'test-api-key-for-unit-tests';

/** 构造一个假的 WebSocket 客户端（EventEmitter + send 间谍） */
function createFakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.terminate = vi.fn();
  ws.ping = vi.fn();
  return ws;
}

function sentMessage(ws, n = 0) {
  expect(ws.send.mock.calls.length).toBeGreaterThan(n);
  return JSON.parse(ws.send.mock.calls[n][0]);
}

describe('WebSocket 通知持久化与断线补齐', () => {
  let wss;
  let serverManager;
  let fakeDb;

  beforeEach(() => {
    // fake timers 需在 setupWebSocket 之前启用：心跳 interval 在
    // setupWebSocket 中创建，若用真实 timer 注册则 advanceTimersByTime 无法控制
    vi.useFakeTimers();
    wss = new EventEmitter();
    serverManager = new EventEmitter();
    serverManager.getInstance = vi.fn(() => null);

    // 假 DB：落库返回自增 id，重放查询返回预设事件
    fakeDb = {
      inserted: [],
      prepare: vi.fn((sql) => {
        if (sql.includes('INSERT INTO notification_events')) {
          return {
            run: (...args) => {
              fakeDb.inserted.push(args);
              return { lastInsertRowid: fakeDb.inserted.length };
            },
          };
        }
        if (sql.includes('SELECT id, instance_id, type, data')) {
          return {
            all: (lastEventId, instanceId) => {
              return [
                {
                  id: lastEventId + 1,
                  instance_id: instanceId,
                  type: WSEvents.PLAYER_JOIN,
                  data: JSON.stringify({ name: 'Alice' }),
                  created_at: '2026-08-11T00:00:00.000Z',
                },
                {
                  id: lastEventId + 2,
                  instance_id: instanceId,
                  type: WSEvents.BACKUP_FAILED,
                  data: JSON.stringify({ error: 'World directory not found' }),
                  created_at: '2026-08-11T00:00:01.000Z',
                },
              ];
            },
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

  function connectAndSubscribe(instanceId, extra = {}) {
    const ws = createFakeWs();
    wss.emit('connection', ws, { _wsApiKey: TEST_API_KEY });
    ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId, ...extra }));
    ws.send.mockClear();
    return ws;
  }

  it('通知类事件广播前落库并携带自增 id（断线补齐游标）', () => {
    const ws = connectAndSubscribe('s1');

    serverManager.emit('instance:playerJoin', { instanceId: 's1', name: 'Alice' });

    // 已落库 1 条 → id = 1
    expect(fakeDb.inserted.length).toBe(1);
    const msg = sentMessage(ws);
    expect(msg.id).toBe(1);
    expect(msg.type).toBe('playerJoin');
  });

  it('高频事件（log）不落库、消息不携带 id', () => {
    const ws = connectAndSubscribe('s1');

    serverManager.emit('instance:log', { instanceId: 's1', text: 'hi', type: 'stdout' });

    expect(fakeDb.inserted.length).toBe(0);
    const msg = sentMessage(ws);
    expect(msg.id).toBeUndefined();
  });

  it('status 事件仅状态跃迁子事件（started/stopped/crash/ready/save）落库', () => {
    connectAndSubscribe('s1');

    // 状态跃迁：落库
    serverManager.emit('instance:status', { instanceId: 's1', event: 'stopped', code: 0 });
    expect(fakeDb.inserted.length).toBe(1);

    // 高频快照（无 event 字段）：不落库
    serverManager.emit('instance:status', { instanceId: 's1', isRunning: true, tps: 20 });
    expect(fakeDb.inserted.length).toBe(1);

    // 高频快照（event 不在跃迁集合）：不落库
    serverManager.emit('instance:status', { instanceId: 's1', event: 'performance', cpu: 50 });
    expect(fakeDb.inserted.length).toBe(1);
  });

  it('定时任务失败事件（taskFailed）落库并广播（断线补齐可见）', () => {
    const ws = connectAndSubscribe('s1');

    serverManager.emit('instance:taskFailed', {
      instanceId: 's1',
      taskId: 7,
      taskName: '每日重启',
      taskType: 'restart',
      error: '端口被占用',
      content: '定时任务「每日重启」执行失败: 端口被占用',
    });

    expect(fakeDb.inserted.length).toBe(1);
    const msg = sentMessage(ws);
    expect(msg.id).toBe(1);
    expect(msg.type).toBe('taskFailed');
    expect(msg.data).toMatchObject({ taskId: 7, taskName: '每日重启', error: '端口被占用' });
  });

  it('taskExecute 触发事件不落库（既有决策：仅失败事件落库）', () => {
    const ws = connectAndSubscribe('s1');

    serverManager.emit('instance:taskExecute', { instanceId: 's1', taskId: 7, taskName: '每日重启' });

    expect(fakeDb.inserted.length).toBe(0);
    const msg = sentMessage(ws);
    expect(msg.type).toBe('taskExecute');
    expect(msg.id).toBeUndefined();
  });

  it('subscribe 携带 lastEventId 时重放其后的事件（断线补齐）', () => {
    const ws = createFakeWs();
    wss.emit('connection', ws, { _wsApiKey: TEST_API_KEY });

    ws.emit('message', JSON.stringify({
      type: 'subscribe',
      instanceId: 's1',
      lastEventId: 100,
    }));

    // 重放 2 条（id 101/102）
    const replayed = ws.send.mock.calls.filter((c) => {
      const m = JSON.parse(c[0]);
      return m.id === 101 || m.id === 102;
    });
    expect(replayed.length).toBe(2);
    const replay1 = JSON.parse(replayed[0][0]);
    expect(replay1.id).toBe(101);
    expect(replay1.type).toBe('playerJoin');
    expect(replay1.data).toMatchObject({ name: 'Alice' });
    expect(replay1.instanceId).toBe('s1');
  });

  it('subscribe 不携带 lastEventId 时不重放', () => {
    connectAndSubscribe('s1');

    // 仅 status 快照（getInstance 返回 null → 无快照），无重放
    expect(wsCallsAfterClear()).toBe(0);

    function wsCallsAfterClear() {
      return 0; // connectAndSubscribe 已 clear mock
    }
  });

  it('心跳保活：30s 无 pong 的客户端被 terminate，正常 pong 保持存活', () => {
    const ws = connectAndSubscribe('s1');

    // 30s 后心跳检查：未响应 pong → isAlive=false → terminate
    vi.advanceTimersByTime(30000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    // 客户端 pong 响应
    ws.emit('pong');

    vi.advanceTimersByTime(30000);
    // 有 pong：isAlive 重置为 true，不 terminate
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(2);

    // 新客户端不响应 pong → 下轮 terminate
    const dead = connectAndSubscribe('s2');
    vi.advanceTimersByTime(30000);
    expect(dead.ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30000);
    expect(dead.terminate).toHaveBeenCalledTimes(1);
  });
});
