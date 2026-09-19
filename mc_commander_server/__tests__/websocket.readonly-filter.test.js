/**
 * 只读角色 Phase 2：WS 事件级过滤
 *
 * Phase 1 的做法是只读凭据一律拒握手；Phase 2 放行握手并把过滤挪到**投递侧**。
 * 本文件的承重点是「投递面全覆盖」——只读拿不到的必须是**所有**投递路径都拿不到，
 * 四条路径缺一条就是越权读取面：
 *   ① `fanOut`（实例广播 / 关键事件 includeUnsubscribed / 全局通知 / broadcastAll）
 *   ② 连接建立时的在途部署补发（直发）
 *   ③ 订阅时的升级进度补发（直发）
 *   ④ 断线补齐重放（`lastEventId`，直发且取自落库表）
 *
 * 另含一条**归类哨兵**：`WSEvents` 新增成员若没在本文件里二分归类即变红——
 * 白名单是「放行」语义，漏登记只会更严不会更松，但**新增事件悄悄变成放行**（或
 * 悄悄变成拒绝）都是需要人拍板的事，故用用例把这次决策钉住。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/index.js', () => ({ getDb: vi.fn() }));
import config from '../config.js';
import { hashToken } from '../utils/password.js';
import { setupWebSocket, WSEvents, READONLY_WS_EVENTS } from '../websocket.js';
import { getDb } from '../db/index.js';

const ADMIN_KEY = 'admin-key-for-readonly-ws-tests';
const READONLY_KEY = 'mcro-readonly-key-for-ws-tests';

function createFakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.terminate = vi.fn();
  ws.ping = vi.fn();
  return ws;
}

/** 已收消息的事件类型清单（去掉 pong/auth 回执这类非广播消息） */
function receivedTypes(ws) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(raw)).map((m) => m.type);
}

describe('只读角色的 WS 事件过滤', () => {
  let wss;
  let serverManager;
  let wsApi;

  beforeEach(() => {
    vi.useFakeTimers();
    config.apiKeyEnabled = true;
    config.apiKeyHash = hashToken(ADMIN_KEY);
    config.readonlyApiKeyEnabled = true;
    config.readonlyApiKeyHash = hashToken(READONLY_KEY);
    wss = new EventEmitter();
    serverManager = new EventEmitter();
    serverManager.getInstance = vi.fn(() => null);
    wsApi = setupWebSocket(wss, serverManager);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 建立一条已认证连接（subprotocol 通道），不清空 send——需要看连接/订阅期间的补发时用 */
  function connect(apiKey) {
    const ws = createFakeWs();
    wss.emit('connection', ws, { _wsApiKey: apiKey });
    return ws;
  }

  /** 已认证 + 已订阅 s1，并清空 send（广播类断言的起点） */
  function connectAndSubscribe(apiKey, instanceId = 's1') {
    const ws = connect(apiKey);
    ws.emit('message', JSON.stringify({ type: 'subscribe', instanceId }));
    ws.send.mockClear();
    return ws;
  }

  describe('握手与角色落定', () => {
    it('只读凭据可建立连接，角色落定为 readonly（两条鉴权通道同口径）', () => {
      const viaProtocol = createFakeWs();
      wss.emit('connection', viaProtocol, { _wsApiKey: READONLY_KEY });
      expect(viaProtocol.close).not.toHaveBeenCalled();
      expect(viaProtocol._role).toBe('readonly');

      const viaFirstFrame = createFakeWs();
      wss.emit('connection', viaFirstFrame, {});
      viaFirstFrame.emit('message', JSON.stringify({ type: 'auth', apiKey: READONLY_KEY }));
      expect(viaFirstFrame.close).not.toHaveBeenCalled();
      expect(viaFirstFrame._role).toBe('readonly');
    });

    it('管理员连接角色为 admin（既有行为不变）', () => {
      const ws = createFakeWs();
      wss.emit('connection', ws, { _wsApiKey: ADMIN_KEY });
      expect(ws._role).toBe('admin');
    });

    it('只读凭据不被计入认证失败封禁（合法凭据，只受限不失败）', () => {
      const ws = createFakeWs();
      wss.emit('connection', ws, { _wsApiKey: READONLY_KEY });
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe('① fanOut：实例广播', () => {
    it.each([
      ['instance:log', WSEvents.LOG],
      ['instance:playerChat', WSEvents.PLAYER_CHAT],
      ['instance:backupComplete', WSEvents.BACKUP_COMPLETE],
      ['instance:backupFailed', WSEvents.BACKUP_FAILED],
      ['instance:restoreStart', WSEvents.RESTORE_START],
      ['instance:taskFailed', WSEvents.TASK_FAILED],
      ['instance:webhookDeliveryFailed', WSEvents.WEBHOOK_DELIVERY_FAILED],
    ])('只读收不到 %s（%s）', (emitterEvent, wsType) => {
      const ro = connectAndSubscribe(READONLY_KEY);
      serverManager.emit(emitterEvent, {
        instanceId: 's1',
        text: 'secret',
        name: 'x',
        url: 'https://hook/?token=abc',
      });
      expect(receivedTypes(ro)).not.toContain(wsType);
    });

    it.each([
      ['instance:status', WSEvents.STATUS, { event: 'started', isRunning: true }],
      ['instance:performanceUpdate', WSEvents.PERFORMANCE_UPDATE, { tps: 20 }],
      ['instance:weatherUpdate', WSEvents.WEATHER_UPDATE, { weather: 'clear' }],
      ['instance:playerStatsUpdate', WSEvents.PLAYER_STATS_UPDATE, { players: [] }],
      ['instance:playerJoin', WSEvents.PLAYER_JOIN, { player: 'Steve' }],
      ['instance:playerLeave', WSEvents.PLAYER_LEAVE, { player: 'Steve' }],
      ['instance:playerDeath', WSEvents.PLAYER_DEATH, { players: ['Steve'], count: 1 }],
      ['instance:playerRespawn', WSEvents.PLAYER_RESPAWN, { player: 'Steve' }],
      ['instance:playerSleep', WSEvents.PLAYER_SLEEP, { player: 'Steve' }],
      ['instance:achievement', WSEvents.ACHIEVEMENT, { player: 'Steve', achievement: 'stone' }],
    ])('只读收得到 %s（%s）', (emitterEvent, wsType, payload) => {
      const ro = connectAndSubscribe(READONLY_KEY);
      serverManager.emit(emitterEvent, { instanceId: 's1', ...payload });
      expect(receivedTypes(ro)).toContain(wsType);
    });

    it('管理员照收全部（含被只读拦下的 log / backup / task / webhook）', () => {
      const admin = connectAndSubscribe(ADMIN_KEY);
      serverManager.emit('instance:log', { instanceId: 's1', text: 'hi', type: 'stdout' });
      serverManager.emit('instance:backupFailed', { instanceId: 's1', error: 'boom' });
      serverManager.emit('instance:taskFailed', { instanceId: 's1', error: 'boom' });
      serverManager.emit('instance:webhookDeliveryFailed', {
        instanceId: 's1',
        url: 'https://hook',
      });
      expect(receivedTypes(admin)).toEqual(
        expect.arrayContaining([
          WSEvents.LOG,
          WSEvents.BACKUP_FAILED,
          WSEvents.TASK_FAILED,
          WSEvents.WEBHOOK_DELIVERY_FAILED,
        ]),
      );
    });

    it('未订阅该实例时两边都收不到（角色过滤不改变订阅语义）', () => {
      const ro = connect(READONLY_KEY);
      ro.send.mockClear();
      serverManager.emit('instance:status', { instanceId: 's1', event: 'started' });
      expect(receivedTypes(ro)).not.toContain(WSEvents.STATUS);
    });
  });

  describe('① fanOut：全局/跨订阅路径（includeUnsubscribed）', () => {
    it('crash/熔断的全局投递对只读放行（status 是读数事件，且正是监控关心的）', () => {
      const ro = connectAndSubscribe(READONLY_KEY, 'other-instance');
      serverManager.emit('instance:status', {
        instanceId: 's1',
        event: 'circuit_breaker',
        consecutiveCrashes: 3,
        windowMs: 60000,
      });
      expect(receivedTypes(ro)).toContain(WSEvents.STATUS);
    });

    it('systemStatsUpdate（broadcastAll 全局）对只读放行', () => {
      const ro = connectAndSubscribe(READONLY_KEY, 'other-instance');
      // 走真实全局投递入口（startSystemStatsBroadcast 内部即调它，15s/类型限流）
      wsApi.broadcastAll(WSEvents.SYSTEM_STATS_UPDATE, { cpuUsage: 12.5 });
      expect(receivedTypes(ro)).toContain(WSEvents.SYSTEM_STATS_UPDATE);
    });

    it('deployProgress / deploy 终态（全局通知）对只读一律拦下', () => {
      const ro = connectAndSubscribe(READONLY_KEY, 'other-instance');
      serverManager.emit(WSEvents.DEPLOY_PROGRESS, {
        instanceId: 's1',
        stage: 'download',
        percent: 40,
      });
      serverManager.emit(WSEvents.DEPLOY_COMPLETE, { instanceId: 's1', instanceName: 'x' });
      const types = receivedTypes(ro);
      expect(types).not.toContain(WSEvents.DEPLOY_PROGRESS);
      expect(types).not.toContain(WSEvents.DEPLOY_COMPLETE);
    });

    it('upgradeProgress 对只读拦下、管理员照收', () => {
      const ro = connectAndSubscribe(READONLY_KEY);
      const admin = connectAndSubscribe(ADMIN_KEY);
      serverManager.emit('instance:upgradeProgress', {
        instanceId: 's1',
        stage: 'download',
        percent: 40,
      });
      expect(receivedTypes(ro)).not.toContain(WSEvents.UPGRADE_PROGRESS);
      expect(receivedTypes(admin)).toContain(WSEvents.UPGRADE_PROGRESS);
    });
  });

  describe('② 连接补发在途部署快照', () => {
    it('只读连接不补发部署快照，管理员连接补发（回执之后）', () => {
      const dep = { instanceId: 'deploy-1', stage: 'download', percent: 40, updatedAt: Date.now() };
      serverManager.activeDeploys = new Map([['deploy-1', dep]]);

      const ro = createFakeWs();
      wss.emit('connection', ro, { _wsApiKey: READONLY_KEY });
      expect(receivedTypes(ro)).not.toContain(WSEvents.DEPLOY_PROGRESS);

      const admin = createFakeWs();
      wss.emit('connection', admin, { _wsApiKey: ADMIN_KEY });
      expect(receivedTypes(admin)).toContain(WSEvents.DEPLOY_PROGRESS);
    });
  });

  describe('③ 订阅补发升级进度快照', () => {
    it('只读订阅时不补发升级进度，但仍补发 status 快照', () => {
      serverManager.activeUpgrades = new Map([['s1', { stage: 'download', percent: 40 }]]);
      // players 与真实 ManagedInstance 同为 Map（旧实现直接下发 Map → JSON 成 {}）
      serverManager.getInstance = vi.fn(() => ({
        isRunning: true,
        players: new Map([['Steve', { name: 'Steve' }]]),
        tps: 20,
      }));

      const ro = connect(READONLY_KEY);
      ro.emit('message', JSON.stringify({ type: 'subscribe', instanceId: 's1' }));
      const types = receivedTypes(ro);
      expect(types).not.toContain(WSEvents.UPGRADE_PROGRESS);
      expect(types).toContain(WSEvents.STATUS);
    });
  });

  describe('④ 断线补齐重放', () => {
    const row = (id, type, data = {}) => ({
      id,
      instance_id: 's1',
      type,
      data: JSON.stringify(data),
      created_at: '2026-09-17 00:00:00',
    });

    /**
     * 迷你 SQL 模拟器：只实现探针要用的语义——`type IN (…)` 存在时按参数里的类型
     * 过滤，再按 id 游标筛、最后套 LIMIT 500。窗口是否被不可见事件占满，正是
     * 「过滤在 SQL 还是在循环里」的差别所在，故必须让替身体现这一点
     */
    function fakeDb(rows) {
      return {
        prepare: (sql) => ({
          all: (...args) => {
            const types = sql.includes('type IN (') ? args.slice(2) : null;
            const cursor = args[0];
            return rows
              .filter((r) => r.id > cursor)
              .filter((r) => (types ? types.includes(r.type) : true))
              .slice(0, 500);
          },
        }),
      };
    }

    it('重放按角色过滤：落库的 taskFailed / webhookDeliveryFailed 不补发给只读，playerJoin 照补', () => {
      getDb.mockReturnValue(
        fakeDb([
          row(42, WSEvents.TASK_FAILED, { error: 'boom' }),
          row(43, WSEvents.PLAYER_JOIN, { player: 'Steve' }),
          row(44, WSEvents.WEBHOOK_DELIVERY_FAILED, { url: 'https://hook' }),
        ]),
      );

      const ro = createFakeWs();
      wss.emit('connection', ro, { _wsApiKey: READONLY_KEY });
      ro.emit('message', JSON.stringify({ type: 'subscribe', instanceId: 's1', lastEventId: 41 }));

      const replayed = receivedTypes(ro);
      expect(replayed).toContain(WSEvents.PLAYER_JOIN);
      expect(replayed).not.toContain(WSEvents.TASK_FAILED);
      expect(replayed).not.toContain(WSEvents.WEBHOOK_DELIVERY_FAILED);
    });

    it('管理员重放不受过滤（三条全补）', () => {
      getDb.mockReturnValue(
        fakeDb([
          row(42, WSEvents.TASK_FAILED, { error: 'boom' }),
          row(43, WSEvents.PLAYER_JOIN, { player: 'Steve' }),
          row(44, WSEvents.WEBHOOK_DELIVERY_FAILED, { url: 'https://hook' }),
        ]),
      );

      const admin = createFakeWs();
      wss.emit('connection', admin, { _wsApiKey: ADMIN_KEY });
      admin.emit(
        'message',
        JSON.stringify({ type: 'subscribe', instanceId: 's1', lastEventId: 41 }),
      );

      expect(receivedTypes(admin)).toEqual(
        expect.arrayContaining([
          WSEvents.TASK_FAILED,
          WSEvents.PLAYER_JOIN,
          WSEvents.WEBHOOK_DELIVERY_FAILED,
        ]),
      );
    });

    it('窗口不被不可见事件占满：前面 500 条都是 playerChat 时，只读仍补到后面的 playerJoin', () => {
      // 只在循环里过滤会让 LIMIT 500 全被不可见事件吃掉 → 只读一条也收不到、
      // 游标不前进（客户端只在收到带 eventId 的消息时推进）→ 重连永远撞同一堵墙。
      // 忙碌服的 playerChat 是最易达的触发情形
      const rows = [row(1, WSEvents.PLAYER_JOIN)];
      for (let id = 2; id <= 601; id += 1)
        rows.push(row(id, WSEvents.PLAYER_CHAT, { message: 'noise' }));
      rows.push(row(602, WSEvents.PLAYER_JOIN, { player: 'Alex' }));
      getDb.mockReturnValue(fakeDb(rows));

      const ro = createFakeWs();
      wss.emit('connection', ro, { _wsApiKey: READONLY_KEY });
      ro.emit('message', JSON.stringify({ type: 'subscribe', instanceId: 's1', lastEventId: 1 }));

      const messages = ro.send.mock.calls.map(([raw]) => JSON.parse(raw));
      const replayed = messages.filter((m) => m.eventId != null);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]).toMatchObject({ eventId: 602, type: WSEvents.PLAYER_JOIN });
    });
  });

  describe('归类哨兵：每个 WSEvents 成员都必须二分归类', () => {
    // 「拦下」清单与人读的白名单分离维护：新增事件时若只改 WSEvents，本用例变红，
    // 逼出一次「这个事件只读该不该看」的决策（与 #24 的显式字段清单同思路）
    const DENIED = [
      WSEvents.LOG,
      WSEvents.PLAYER_CHAT,
      WSEvents.BACKUP_START,
      WSEvents.BACKUP_PROGRESS,
      WSEvents.BACKUP_COMPLETE,
      WSEvents.BACKUP_FAILED,
      WSEvents.BACKUP_SKIPPED,
      WSEvents.BACKUP_CANCELLED,
      WSEvents.RESTORE_START,
      WSEvents.RESTORE_PROGRESS,
      WSEvents.RESTORE_COMPLETE,
      WSEvents.RESTORE_FAILED,
      WSEvents.RESTORE_CANCELLED,
      WSEvents.TASK_EXECUTE,
      WSEvents.TASK_FAILED,
      WSEvents.WEBHOOK_DELIVERY_FAILED,
      WSEvents.DEPLOY_PROGRESS,
      WSEvents.DEPLOY_COMPLETE,
      WSEvents.DEPLOY_FAILED,
      WSEvents.DEPLOY_CANCELLED,
      WSEvents.UPGRADE_PROGRESS,
      WSEvents.UPGRADE_COMPLETE,
      WSEvents.UPGRADE_FAILED,
      WSEvents.UPGRADE_CANCELLED,
      WSEvents.CIRCUIT_BREAKER,
      WSEvents.ERROR,
    ];

    it('白名单 ∪ 拦下列表 == 全部 WSEvents，且两集合不相交', () => {
      const all = Object.values(WSEvents);
      const allowed = [...READONLY_WS_EVENTS];
      expect(new Set([...allowed, ...DENIED]).size).toBe(allowed.length + DENIED.length); // 无交集
      expect([...all].sort()).toEqual([...allowed, ...DENIED].sort()); // 全覆盖、无多余项
    });

    it('白名单里不含任何日志/命令/备份/任务/Webhook/部署/升级事件（口径自检）', () => {
      for (const type of READONLY_WS_EVENTS) {
        expect(type).not.toMatch(
          /log|backup|restore|task|webhook|deploy|upgrade|chat|error|circuit/i,
        );
      }
    });
  });
});
