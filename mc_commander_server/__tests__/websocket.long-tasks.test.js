import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { setupWebSocket, WSEvents } from '../websocket.js';

// Mock 数据库：验证长任务终态通知落库（deployComplete/deployFailed/upgradeComplete/upgradeFailed）
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

/** 模拟通过认证的连接（与 index.js handleProtocols 挂载凭据的方式一致） */
function connect(wss, req) {
  const ws = createFakeWs();
  wss.emit('connection', ws, { _wsApiKey: TEST_API_KEY, _wsSessionToken: null, ...req });
  return ws;
}

function subscribe(ws, instanceId, lastEventId) {
  ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId, ...(lastEventId ? { lastEventId } : {}) }));
}

/** 解析客户端收到的第 n 条消息 */
function sentMessage(ws, n = 0) {
  expect(ws.send.mock.calls.length).toBeGreaterThan(n);
  return JSON.parse(ws.send.mock.calls[n][0]);
}

describe('WebSocket 长任务（部署/升级）通知与补发', () => {
  let wss;
  let serverManager;
  let fakeDb;

  beforeEach(() => {
    vi.useFakeTimers();
    wss = new EventEmitter();
    // 模拟真实 MCServerManager：长任务注册表 + 实例查询
    serverManager = new EventEmitter();
    serverManager.activeDeploys = new Map();
    serverManager.activeUpgrades = new Map();
    serverManager.getInstance = vi.fn((id) =>
      id === 'paper-abc1' ? { id, name: '生存服', mcVersion: '1.21.4' } : null,
    );

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
        return { run: vi.fn(), all: vi.fn(() => []) };
      }),
    };
    getDb.mockReturnValue(fakeDb);
    setupWebSocket(wss, serverManager);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('部署终态通知（落库 + 全局广播）', () => {
    it('deployProgress complete → 广播 deployComplete 并落库（instance_id NULL）', () => {
      const ws = connect(wss);
      // 终态通知不受订阅过滤（部署实例未入库，无实例归属），未订阅也可见
      serverManager.emit('deployProgress', {
        stage: 'complete',
        percent: 1.0,
        instanceId: 'paper-abc1',
        instanceName: '生存服',
        type: 'paper',
        mcVersion: '1.21.4',
      });

      // 第 1 条：deployProgress 原事件（broadcastAll）；第 2 条：deployComplete 通知
      const progress = sentMessage(ws, 0);
      expect(progress.type).toBe(WSEvents.DEPLOY_PROGRESS);
      const notice = sentMessage(ws, 1);
      expect(notice.type).toBe(WSEvents.DEPLOY_COMPLETE);
      expect(notice.data.instanceName).toBe('生存服');
      // 落库：instance_id 为 NULL（无归属全局通知），类型与 data 校验
      expect(fakeDb.inserted).toHaveLength(1);
      const [instanceId, type, data] = fakeDb.inserted[0];
      expect(instanceId).toBeNull();
      expect(type).toBe(WSEvents.DEPLOY_COMPLETE);
      expect(JSON.parse(data).instanceId).toBe('paper-abc1');
    });

    it('deployProgress error → 广播 deployFailed 并落库', () => {
      const ws = connect(wss);
      serverManager.emit('deployProgress', {
        stage: 'error',
        percent: 0,
        error: 'Forge installer timed out (120s)',
        instanceId: 'forge-abc2',
        instanceName: 'Forge 服',
        type: 'forge',
        mcVersion: '1.20.1',
      });

      const notice = sentMessage(ws, 1);
      expect(notice.type).toBe(WSEvents.DEPLOY_FAILED);
      expect(notice.data.error).toBe('Forge installer timed out (120s)');
      expect(fakeDb.inserted[0][1]).toBe(WSEvents.DEPLOY_FAILED);
    });

    it('进行中阶段（download）不产生通知事件（仅原事件广播）', () => {
      const ws = connect(wss);
      serverManager.emit('deployProgress', { stage: 'download', percent: 0.42, transferred: 100, total: 240 });

      // broadcastAll 对同类型有 15s 节流（既有设计），单事件仅验证通知不落库
      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(fakeDb.inserted).toHaveLength(0);
      expect(sentMessage(ws, 0).type).toBe(WSEvents.DEPLOY_PROGRESS);
    });
  });

  describe('升级终态通知（落库 + 实例归属广播）', () => {
    it('upgradeProgress completed → 广播 upgradeComplete（补实例名）并落库', () => {
      const ws = connect(wss);
      subscribe(ws, 'paper-abc1');
      ws.send.mockClear();
      fakeDb.inserted.length = 0;

      serverManager.emit('instance:upgradeProgress', {
        instanceId: 'paper-abc1',
        stage: 'completed',
        percent: 100,
        detail: '升级完成',
        timestamp: Date.now(),
      });

      // 第 1 条：upgradeProgress 原事件；第 2 条：upgradeComplete 通知（带实例名）
      const progress = sentMessage(ws, 0);
      expect(progress.type).toBe(WSEvents.UPGRADE_PROGRESS);
      const notice = sentMessage(ws, 1);
      expect(notice.type).toBe(WSEvents.UPGRADE_COMPLETE);
      expect(notice.instanceId).toBe('paper-abc1');
      expect(notice.data.instanceName).toBe('生存服');
      expect(fakeDb.inserted[0][1]).toBe(WSEvents.UPGRADE_COMPLETE);
      expect(fakeDb.inserted[0][0]).toBe('paper-abc1');
    });

    it('upgradeProgress failed / rolled_back → 广播 upgradeFailed 并落库', () => {
      const ws = connect(wss);
      subscribe(ws, 'paper-abc1');
      ws.send.mockClear();
      fakeDb.inserted.length = 0;

      serverManager.emit('instance:upgradeProgress', {
        instanceId: 'paper-abc1',
        stage: 'rolled_back',
        percent: 0,
        detail: '升级失败: 下载失败，正在回滚...',
        timestamp: Date.now(),
      });
      serverManager.emit('instance:upgradeProgress', {
        instanceId: 'paper-abc1',
        stage: 'failed',
        percent: 0,
        detail: '升级失败并已回滚: 下载失败',
        timestamp: Date.now(),
      });

      const notice1 = sentMessage(ws, 1);
      expect(notice1.type).toBe(WSEvents.UPGRADE_FAILED);
      const notice3 = sentMessage(ws, 3);
      expect(notice3.type).toBe(WSEvents.UPGRADE_FAILED);
      expect(fakeDb.inserted).toHaveLength(2);
    });

    it('upgradeProgress 进行中阶段不产生通知事件', () => {
      const ws = connect(wss);
      subscribe(ws, 'paper-abc1');
      ws.send.mockClear();
      fakeDb.inserted.length = 0;

      serverManager.emit('instance:upgradeProgress', {
        instanceId: 'paper-abc1',
        stage: 'download',
        percent: 50,
        detail: '正在下载...',
        timestamp: Date.now(),
      });

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(fakeDb.inserted).toHaveLength(0);
    });
  });

  describe('长任务状态补发（刷新/重连恢复）', () => {
    it('连接建立时补发进行中的部署快照（全局事件，无需订阅）', () => {
      // updatedAt 由 trackDeployProgress 写入；读取判据按它判死快照（utils/deploy-inflight.js）
      serverManager.activeDeploys.set('paper-abc1', {
        instanceId: 'paper-abc1',
        instanceName: '生存服',
        type: 'paper',
        mcVersion: '1.21.4',
        stage: 'forge_install',
        percent: 0,
        updatedAt: Date.now(),
      });

      const ws = connect(wss);
      // 连接即补发（部署无订阅语义；STATUS 快照仅 subscribe 后才有）
      expect(ws.send).toHaveBeenCalledTimes(1);
      const snapshot = sentMessage(ws, 0);
      expect(snapshot.type).toBe(WSEvents.DEPLOY_PROGRESS);
      expect(snapshot.data.instanceId).toBe('paper-abc1');
      expect(snapshot.data.stage).toBe('forge_install');
    });

    it('死快照（超时限未更新）不补发：与 GET /instances/deploy/status 同口径', () => {
      serverManager.activeDeploys.set('paper-stale', {
        instanceId: 'paper-stale',
        instanceName: '旧部署服',
        type: 'paper',
        mcVersion: '1.21.4',
        stage: 'forge_install',
        percent: 0,
        updatedAt: Date.now() - 16 * 60 * 1000,
      });

      const ws = connect(wss);

      // 补发一个早已结束的「部署中」会让前端误判服务端仍在部署
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('无进行中部署时连接不补发', () => {
      const ws = connect(wss);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('subscribe 时补发该实例进行中的升级快照', () => {
      serverManager.activeUpgrades.set('paper-abc1', {
        instanceId: 'paper-abc1',
        stage: 'download',
        percent: 55,
        detail: '正在下载...',
        timestamp: Date.now(),
      });

      const ws = connect(wss);
      ws.send.mockClear();
      subscribe(ws, 'paper-abc1');

      const types = ws.send.mock.calls.map((c) => JSON.parse(c[0]).type);
      // STATUS 快照 + 升级补发
      expect(types).toContain(WSEvents.UPGRADE_PROGRESS);
      const upgradeMsg = ws.send.mock.calls
        .map((c) => JSON.parse(c[0]))
        .find((m) => m.type === WSEvents.UPGRADE_PROGRESS);
      expect(upgradeMsg.instanceId).toBe('paper-abc1');
      expect(upgradeMsg.data.percent).toBe(55);
    });

    it('subscribe 其他实例不补发无关实例的升级快照', () => {
      serverManager.activeUpgrades.set('paper-abc1', {
        instanceId: 'paper-abc1',
        stage: 'download',
        percent: 55,
        timestamp: Date.now(),
      });

      const ws = connect(wss);
      ws.send.mockClear();
      subscribe(ws, 'vanilla-other');

      const types = ws.send.mock.calls.map((c) => JSON.parse(c[0]).type);
      expect(types).not.toContain(WSEvents.UPGRADE_PROGRESS);
    });
  });
});
