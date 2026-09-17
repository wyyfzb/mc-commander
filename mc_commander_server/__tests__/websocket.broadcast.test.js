import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { setupWebSocket, WSEvents } from '../websocket.js';

// Mock 数据库：捕获通知事件落库（全局通知 id 透传 / 落库失败降级分支）
vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
}));
import { getDb } from '../db/index.js';

// Mock os：startSystemStatsBroadcast 的系统指标采集。
// spread 保留其余导出，仅覆盖本文件关心的 5 个函数（默认实现可在用例内重设）
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      cpus: vi.fn(() => [{ model: 'cpu0' }, { model: 'cpu1' }, { model: 'cpu2' }, { model: 'cpu3' }]),
      loadavg: vi.fn(() => [2.0, 1.0, 0.5]),
      totalmem: vi.fn(() => 8 * 1024 * 1024 * 1024),
      freemem: vi.fn(() => 2 * 1024 * 1024 * 1024),
      uptime: vi.fn(() => 12345),
    },
  };
});
import os from 'os';

// Mock fs.statfsSync：磁盘使用率采集（spread 保留其余导出，logger 等模块不受影响）
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      statfsSync: vi.fn(),
    },
  };
});
import fs from 'fs';

const TEST_API_KEY = 'test-api-key-for-unit-tests';

// 三次 statfsSync 调用对应 getDiskUsage 遍历的三个配置目录（servers/data/backups）：
// 前两次同挂载点 /mnt/mc-a（60% 与 80%，聚合应保留高者），第三次独立挂载点 10%
const FS_SAMPLES = [
  { bsize: 4096, blocks: 2621440, bfree: 1048576, mounted: '/mnt/mc-a' },
  { bsize: 4096, blocks: 2621440, bfree: 524288, mounted: '/mnt/mc-a' },
  { bsize: 4096, blocks: 2621440, bfree: 2359296, mounted: '/mnt/mc-b' },
];

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

/** 模拟通过认证的连接（与 index.js handleProtocols 挂载凭据的方式一致） */
function connect(wssRef) {
  const ws = createFakeWs();
  wssRef.emit('connection', ws, { _wsApiKey: TEST_API_KEY });
  return ws;
}

/** 解析客户端收到的第 n 条消息 */
function sentMessage(ws, n = 0) {
  expect(ws.send.mock.calls.length).toBeGreaterThan(n);
  return JSON.parse(ws.send.mock.calls[n][0]);
}

describe('WebSocket 系统广播域（broadcastAll / 全局通知 / 系统统计推送）', () => {
  let wss;
  let serverManager;
  let fakeDb;
  let api;

  beforeEach(() => {
    // fake timers 需在 setupWebSocket 之前启用：心跳 interval、广播节流窗口
    // 与系统统计 15s 周期都依赖可控时钟
    vi.useFakeTimers();
    wss = new EventEmitter();
    serverManager = new EventEmitter();
    serverManager.getInstance = vi.fn(() => null);

    // 假 DB：落库返回自增 id；failInsert 置真时抛错（验证降级分支）
    fakeDb = {
      inserted: [],
      failInsert: false,
      prepare: vi.fn((sql) => {
        if (sql.includes('INSERT INTO notification_events')) {
          return {
            run: (...args) => {
              if (fakeDb.failInsert) throw new Error('disk I/O error');
              fakeDb.inserted.push(args);
              return { lastInsertRowid: fakeDb.inserted.length };
            },
          };
        }
        return { run: vi.fn(), all: vi.fn(() => []) };
      }),
    };
    getDb.mockReturnValue(fakeDb);

    // 系统指标默认实现（用例内可重设；clearAllMocks 不清实现，这里显式复位防泄漏）
    vi.mocked(os.loadavg).mockReturnValue([2.0, 1.0, 0.5]);
    vi.mocked(os.cpus).mockReturnValue([{ model: 'cpu0' }, { model: 'cpu1' }, { model: 'cpu2' }, { model: 'cpu3' }]);
    vi.mocked(os.totalmem).mockReturnValue(8 * 1024 * 1024 * 1024);
    vi.mocked(os.freemem).mockReturnValue(2 * 1024 * 1024 * 1024);
    vi.mocked(os.uptime).mockReturnValue(12345);
    let fsCall = 0;
    vi.mocked(fs.statfsSync).mockImplementation(() => FS_SAMPLES[fsCall++ % FS_SAMPLES.length]);

    api = setupWebSocket(wss, serverManager);
  });

  afterEach(() => {
    // 清理心跳/统计定时器
    wss.emit('close');
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('broadcastAll 全量广播与类型节流', () => {
    it('对全部在线客户端广播且不受订阅过滤，消息仅含 type/data/timestamp', () => {
      const wsSub = connect(wss);
      wsSub.subscribedInstances.add('s1');
      const wsBare = connect(wss);

      api.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { cpuUsage: 12 });

      expect(wsSub.send).toHaveBeenCalledTimes(1);
      expect(wsBare.send).toHaveBeenCalledTimes(1);
      const msg = sentMessage(wsBare);
      expect(Object.keys(msg).sort()).toEqual(['data', 'timestamp', 'type']);
      expect(msg.type).toBe(WSEvents.SYSTEM_STATS_UPDATE);
      expect(msg.data).toEqual({ cpuUsage: 12 });
    });

    it('同类型 15s 节流：窗口内重复发送被抑制，窗口滚动后恢复', () => {
      const ws = connect(wss);

      api.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { seq: 1 });
      expect(ws.send).toHaveBeenCalledTimes(1);

      api.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { seq: 2 });
      expect(ws.send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(15000);
      api.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { seq: 3 });
      expect(ws.send).toHaveBeenCalledTimes(2);
      expect(sentMessage(ws, 1).data).toEqual({ seq: 3 });
    });

    it('节流按类型独立：A 类型被抑制不影响 B 类型首次发送', () => {
      const ws = connect(wss);

      api.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { seq: 1 });
      api.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { seq: 2 });
      api.broadcastAll(WSEvents.LOG, { text: 'hello', type: 'stdout' });

      expect(ws.send).toHaveBeenCalledTimes(2);
      expect(sentMessage(ws, 1).type).toBe(WSEvents.LOG);
    });

    it('readyState 非 1 的客户端不接收（连接关闭中/已关闭）', () => {
      const wsOk = connect(wss);
      const wsClosed = connect(wss);
      wsClosed.readyState = 0;

      api.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { cpuUsage: 1 });

      expect(wsOk.send).toHaveBeenCalledTimes(1);
      expect(wsClosed.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastGlobalNotification 全局通知（经部署终态驱动）', () => {
    it('终态通知落库 instance_id NULL、消息携带 id 且无 instanceId 字段，未订阅客户端也可见', () => {
      const wsA = connect(wss);
      const wsB = connect(wss);
      wsB.subscribedInstances.add('s1');

      serverManager.emit('deployProgress', {
        stage: 'complete',
        percent: 1.0,
        instanceId: 'paper-x1',
        instanceName: '生存服',
        type: 'paper',
        mcVersion: '1.21.4',
      });

      // 两客户端均收到 progress + notice（全局通知不受订阅过滤）
      expect(wsA.send).toHaveBeenCalledTimes(2);
      expect(wsB.send).toHaveBeenCalledTimes(2);

      const notice = sentMessage(wsA, 1);
      expect(notice.type).toBe(WSEvents.DEPLOY_COMPLETE);
      expect(notice.eventId).toBe(1);
      expect('instanceId' in notice).toBe(false);
      expect(notice.data).toMatchObject({ instanceId: 'paper-x1', instanceName: '生存服' });
      // 落库：instance_id NULL（无归属全局通知）
      expect(fakeDb.inserted).toHaveLength(1);
      expect(fakeDb.inserted[0][0]).toBeNull();
      expect(fakeDb.inserted[0][1]).toBe(WSEvents.DEPLOY_COMPLETE);
    });

    it('readyState 非 1 的客户端对全局通知同样免疫', () => {
      const wsOk = connect(wss);
      const wsOff = connect(wss);
      wsOff.readyState = 0;

      serverManager.emit('deployProgress', { stage: 'error', percent: 0, error: 'download failed', instanceId: 'forge-x2', instanceName: 'Forge 服' });

      expect(wsOk.send).toHaveBeenCalledTimes(2);
      expect(wsOff.send).not.toHaveBeenCalled();
      expect(sentMessage(wsOk, 1).type).toBe(WSEvents.DEPLOY_FAILED);
    });

    it('落库失败降级：通知无 id 字段但广播不中断（投递优先）', () => {
      fakeDb.failInsert = true;
      const ws = connect(wss);

      serverManager.emit('deployProgress', { stage: 'complete', percent: 1.0, instanceId: 'paper-x3', instanceName: '生存服' });

      // progress（无落库语义）+ notice 均送达，notice 无 id
      expect(ws.send).toHaveBeenCalledTimes(2);
      const notice = sentMessage(ws, 1);
      expect(notice.type).toBe(WSEvents.DEPLOY_COMPLETE);
      expect('eventId' in notice).toBe(false);
    });
  });

  describe('关键状态跃迁（crash/熔断）全局面投递', () => {
    it('未订阅该实例的客户端也收到 crash，归属仍由信封 instanceId 携带', () => {
      const wsOther = connect(wss);
      wsOther.subscribedInstances.add('s2');
      const wsBare = connect(wss);

      serverManager.emit('instance:status', { instanceId: 's1', event: 'crash', exitCode: 1 });

      expect(wsOther.send).toHaveBeenCalledTimes(1);
      expect(wsBare.send).toHaveBeenCalledTimes(1);
      const msg = sentMessage(wsBare);
      expect(msg.type).toBe(WSEvents.STATUS);
      expect(msg.instanceId).toBe('s1');
      expect(msg.data).toMatchObject({ event: 'crash', exitCode: 1 });
    });

    it('订阅者只收到一次（放开通投递不引入重复下发）', () => {
      const ws = connect(wss);
      ws.subscribedInstances.add('s1');

      serverManager.emit('instance:status', { instanceId: 's1', event: 'crash' });

      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('关键事件落库 instance_id 置空（断线补齐取全局面）且消息携带自增 id', () => {
      const ws = connect(wss);
      ws.subscribedInstances.add('s1');

      serverManager.emit('instance:status', {
        instanceId: 's1',
        event: 'circuit_breaker',
        reason: '连续崩溃',
      });

      expect(fakeDb.inserted).toHaveLength(1);
      expect(fakeDb.inserted[0][0]).toBeNull();
      expect(sentMessage(ws).eventId).toBe(1);
    });

    it('常规跃迁（stopped）仍按订阅过滤并保留实例归属', () => {
      const wsOther = connect(wss);
      wsOther.subscribedInstances.add('s2');
      const wsSub = connect(wss);
      wsSub.subscribedInstances.add('s1');

      serverManager.emit('instance:status', { instanceId: 's1', event: 'stopped', code: 0 });

      expect(wsSub.send).toHaveBeenCalledTimes(1);
      expect(wsOther.send).not.toHaveBeenCalled();
      expect(fakeDb.inserted[0][0]).toBe('s1');
    });

    it('readyState 非 1 的客户端对关键事件同样免疫', () => {
      const wsOff = connect(wss);
      wsOff.readyState = 0;

      serverManager.emit('instance:status', { instanceId: 's1', event: 'crash' });

      expect(wsOff.send).not.toHaveBeenCalled();
    });
  });

  describe('startSystemStatsBroadcast 系统资源统计推送', () => {
    it('启动立即推送一次，指标数据与采集源一致（CPU/内存/磁盘八字段）', () => {
      const ws = connect(wss);
      ws.send.mockClear();

      api.startSystemStatsBroadcast();

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = sentMessage(ws);
      expect(msg.type).toBe(WSEvents.SYSTEM_STATS_UPDATE);
      expect(msg.data).toEqual({
        cpuUsage: 50,
        memoryUsage: 6,
        totalMemory: 8,
        memoryPercent: 75,
        cpuCores: 4,
        loadAvg: [2.0, 1.0, 0.5],
        uptime: 12345,
        diskUsage: {
          primary: { mountpoint: '/mnt/mc-a', totalGB: 10, usedGB: 8, percent: 80 },
          all: [
            { mountpoint: '/mnt/mc-a', totalGB: 10, usedGB: 8, percent: 80 },
            { mountpoint: '/mnt/mc-b', totalGB: 10, usedGB: 1, percent: 10 },
          ],
        },
      });
    });

    it('同挂载点目录聚合保留使用率高者，primary 取全局最高', () => {
      // 默认 mock：/mnt/mc-a 两个目录（60%/80%）→ 聚合保留 80%；/mnt/mc-b 10%
      const ws = connect(wss);
      ws.send.mockClear();

      api.startSystemStatsBroadcast();

      const { diskUsage } = sentMessage(ws).data;
      expect(diskUsage.all).toHaveLength(2);
      expect(diskUsage.primary).toMatchObject({ mountpoint: '/mnt/mc-a', percent: 80 });
      expect(diskUsage.all[0].percent).toBe(80);
      expect(diskUsage.all[1]).toMatchObject({ mountpoint: '/mnt/mc-b', percent: 10 });
    });

    it('单目录 statfsSync 异常跳过不致崩溃，其余目录正常聚合', () => {
      let fsCall = 0;
      vi.mocked(fs.statfsSync).mockImplementation(() => {
        fsCall += 1;
        if (fsCall === 2) throw new Error('permission denied');
        return FS_SAMPLES[fsCall - 1];
      });
      const ws = connect(wss);
      ws.send.mockClear();

      api.startSystemStatsBroadcast();

      const { diskUsage } = sentMessage(ws).data;
      expect(diskUsage.all).toHaveLength(2);
      expect(diskUsage.primary).toMatchObject({ mountpoint: '/mnt/mc-a', percent: 60 });
    });

    it('全部目录异常时 diskUsage 为空结果，推送仍发生', () => {
      vi.mocked(fs.statfsSync).mockImplementation(() => {
        throw new Error('fs unavailable');
      });
      const ws = connect(wss);
      ws.send.mockClear();

      api.startSystemStatsBroadcast();

      const msg = sentMessage(ws);
      expect(msg.type).toBe(WSEvents.SYSTEM_STATS_UPDATE);
      expect(msg.data.diskUsage).toEqual({ primary: null, all: [] });
    });

    it('CPU 使用率按 loadavg/核数近似且有 100 上限钳制', () => {
      vi.mocked(os.loadavg).mockReturnValue([1000, 0, 0]);
      const ws = connect(wss);
      ws.send.mockClear();

      api.startSystemStatsBroadcast();

      expect(sentMessage(ws).data.cpuUsage).toBe(100);
    });

    it('15s 周期推送，stop 函数调用后停止（优雅停机）', () => {
      const ws = connect(wss);
      ws.send.mockClear();

      const stop = api.startSystemStatsBroadcast();
      expect(ws.send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(15000);
      expect(ws.send).toHaveBeenCalledTimes(2);

      stop();
      vi.advanceTimersByTime(15000);
      expect(ws.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('异常 payload 兜底与实例广播降级', () => {
    it('upgradeProgress 缺 instanceId 的异常 payload 退回 broadcastAll 兜底', () => {
      const wsA = connect(wss);
      const wsB = connect(wss);

      serverManager.emit('instance:upgradeProgress', { stage: 'download', percent: 40, detail: '正在下载...' });

      // 兜底走全量广播：无实例归属，不校验订阅，不落库
      expect(wsA.send).toHaveBeenCalledTimes(1);
      expect(wsB.send).toHaveBeenCalledTimes(1);
      const msg = sentMessage(wsA);
      expect(msg.type).toBe(WSEvents.UPGRADE_PROGRESS);
      expect('instanceId' in msg).toBe(false);
      expect(fakeDb.inserted).toHaveLength(0);
    });

    it('实例广播落库失败降级：通知消息无 id 但订阅者仍收到', () => {
      fakeDb.failInsert = true;
      const ws = connect(wss);
      ws.subscribedInstances.add('s1');
      ws.send.mockClear();

      serverManager.emit('instance:playerJoin', { instanceId: 's1', name: 'Steve' });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = sentMessage(ws);
      expect(msg.type).toBe(WSEvents.PLAYER_JOIN);
      expect('id' in msg).toBe(false);
      expect(msg.data).toMatchObject({ instanceId: 's1', name: 'Steve' });
    });
  });

  describe('低频事件处理器广播链（EVENT_HANDLERS 统一注册域）', () => {
    it('九个玩家/性能事件经统一注册的处理器广播到订阅者', () => {
      const ws = connect(wss);
      ws.subscribedInstances.add('s1');
      ws.send.mockClear();

      const CASES = [
        ['instance:playerDeath', WSEvents.PLAYER_DEATH, { instanceId: 's1', name: 'Steve', cause: 'lava' }],
        ['instance:playerRespawn', WSEvents.PLAYER_RESPAWN, { instanceId: 's1', name: 'Steve' }],
        ['instance:playerChat', WSEvents.PLAYER_CHAT, { instanceId: 's1', name: 'Steve', message: 'hello' }],
        ['instance:achievement', WSEvents.ACHIEVEMENT, { instanceId: 's1', name: 'Steve', achievement: 'Taking Inventory' }],
        ['instance:tpsUpdate', WSEvents.TPS_UPDATE, { instanceId: 's1', tps: 19.5 }],
        ['instance:performanceUpdate', WSEvents.PERFORMANCE_UPDATE, { instanceId: 's1', cpu: 30 }],
        ['instance:weatherUpdate', WSEvents.WEATHER_UPDATE, { instanceId: 's1', raining: true }],
        ['instance:playerStatsUpdate', WSEvents.PLAYER_STATS_UPDATE, { instanceId: 's1', players: [{ name: 'Alex' }] }],
        ['instance:playerSleep', WSEvents.PLAYER_SLEEP, { instanceId: 's1', name: 'Steve' }],
      ];
      for (const [event, expectedType, data] of CASES) {
        serverManager.emit(event, data);
        const msg = sentMessage(ws, ws.send.mock.calls.length - 1);
        expect(msg.type).toBe(expectedType);
        expect(msg.instanceId).toBe('s1');
      }
      expect(ws.send).toHaveBeenCalledTimes(CASES.length);
    });

    it('webhook 投递失败事件广播并落库（低频高价值通知链）', () => {
      const ws = connect(wss);
      ws.subscribedInstances.add('s1');
      ws.send.mockClear();

      serverManager.emit('instance:webhookDeliveryFailed', {
        instanceId: 's1',
        webhookId: 3,
        webhookName: '通知钩子',
        url: 'https://hooks.example.com/notify',
        error: 'request timeout',
      });

      expect(fakeDb.inserted).toHaveLength(1);
      const msg = sentMessage(ws);
      expect(msg.type).toBe(WSEvents.WEBHOOK_DELIVERY_FAILED);
      expect(msg.eventId).toBe(1);
      expect(msg.data).toMatchObject({ webhookId: 3, error: 'request timeout' });
    });

    it('客户端断开事件移出广播集合，error 事件仅记录无副作用', () => {
      const wsStay = connect(wss);
      const wsGone = connect(wss);

      wsGone.emit('error', new Error('transport error'));
      expect(wsGone.send).not.toHaveBeenCalled();
      wsGone.emit('close');

      api.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { seq: 1 });
      expect(wsStay.send).toHaveBeenCalledTimes(1);
      expect(wsGone.send).not.toHaveBeenCalled();
    });
  });
});
