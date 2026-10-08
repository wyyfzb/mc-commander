/**
 * MSMP 通知面（一期）：常驻连接、白名单、重连、半开、停止。
 *
 * 协议事实全部来自**实机实测**（MC 26.3，见模块头注释）：无需订阅调用；通知带 `method`
 * 且**没有 `id`**；零参通知的 **`params` 整个键缺席**。最后这条是本文件里最容易被忽略、
 * 也最容易崩的一条——第一版探针就死在 `undefined.slice()` 上。
 *
 * 用假 socket 驱动（不连真服务器）：本文件要钉的是**连接生命周期**这些分支，
 * 它们只有靠注入 close/error/心跳才能稳定走到。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { FakeWebSocket, instances } = vi.hoisted(() => {
  class FakeWebSocket {
    constructor(url, protocols, options) {
      this.url = url;
      this.options = options;
      this.handlers = new Map();
      this.closed = false;
      this.terminated = false;
      this.pinged = 0;
      FakeWebSocket.instances.push(this);
    }
    static instances = [];
    on(event, fn) {
      this.handlers.set(event, fn);
      return this;
    }
    removeAllListeners() {
      this.handlers.clear();
      return this;
    }
    emit(event, ...args) {
      this.handlers.get(event)?.(...args);
    }
    send() {}
    ping() {
      this.pinged++;
    }
    close() {
      this.closed = true;
    }
    terminate() {
      this.terminated = true;
    }
  }
  return { FakeWebSocket, instances: FakeWebSocket.instances };
});

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

const {
  _msmpNotifStart,
  _msmpNotifStop,
  _msmpNotifClearTimers,
  _msmpNotifConnect,
  _msmpNotifHandleMessage,
  _msmpNotifPing,
  _msmpNotifScheduleReconnect,
  _msmpNotifWaitForEndpoint,
  _emitPushChannelState,
  _msmpNotificationTarget,
  MSMP_NOTIFICATION_ALLOWLIST,
} = await import('../services/mc-server/msmp-notifications.js');

/** 最小实例替身：只带连接域需要的状态 + 一个事件收集器 */
function makeInstance(
  endpoint = { host: 'localhost', port: 25585, secret: 's'.repeat(40), tls: false },
  reason = null,
) {
  const emitted = [];
  const inst = {
    isRunning: true,
    _msmpNotifActive: false,
    _msmpNotifSocket: null,
    _msmpNotifHeartbeat: null,
    _msmpNotifPongTimer: null,
    _msmpNotifReconnectTimer: null,
    _msmpNotifBackoffMs: 0,
    _msmpNotifAlive: false,
    _msmpNotifConnected: false,
    _msmpNotifEndpointWaitedMs: 0,
    // 解析结果带原因：未开启与「还没就绪」要走不同分支
    _msmpResolveEndpointResult: () => ({
      endpoint,
      reason: endpoint ? null : (reason ?? 'no-port'),
    }),
    emit: (name, payload) => emitted.push({ name, payload }),
    emitted,
  };
  // 真实实现是原型挂载，这里直接绑上去
  for (const [k, v] of Object.entries({
    _msmpNotifStart,
    _msmpNotifStop,
    _msmpNotifClearTimers,
    _msmpNotifConnect,
    _msmpNotifHandleMessage,
    _msmpNotifPing,
    _msmpNotifScheduleReconnect,
    _msmpNotifWaitForEndpoint,
    // 新函数必须一并绑到假实例上：订阅 open/close 会调它，漏绑会让既有重连用例直接抛错
    _emitPushChannelState,
  })) {
    inst[k] = v;
  }
  return inst;
}

beforeEach(() => {
  vi.useFakeTimers();
  instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('连接建立', () => {
  it('start 建立一条带 Bearer 的连接，且幂等（重复调用不再建）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    expect(instances).toHaveLength(1);
    expect(instances[0].options.headers.Authorization).toBe(`Bearer ${'s'.repeat(40)}`);
    inst._msmpNotifStart();
    expect(instances).toHaveLength(1);
  });

  it('未开启 MSMP（disabled）时不建连接，也不空转重连', () => {
    const inst = makeInstance(null, 'disabled');
    inst._msmpNotifStart();
    expect(instances).toHaveLength(0);
    expect(inst._msmpNotifActive).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(0);
  });

  it('tls=true 时用 wss', () => {
    const inst = makeInstance({ host: 'localhost', port: 1, secret: 'x'.repeat(40), tls: true });
    inst._msmpNotifStart();
    expect(instances[0].url.startsWith('wss://')).toBe(true);
  });
});

describe('通知处理：白名单与形态', () => {
  it('白名单内的通知 → 转成 msmpNotification 事件', () => {
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'minecraft:notification/world/upgrade_progress',
          params: { progress: 0.42 },
        }),
      ),
    );
    // 世界升级会同时发 worldUpgrade（归一化）与 msmpNotification（原样）；
    // 这里只钉通用的那条，归一化那条由下面专门的世界升级用例负责
    expect(inst.emitted).toContainEqual({
      name: 'msmpNotification',
      payload: {
        method: 'minecraft:notification/world/upgrade_progress',
        params: { progress: 0.42 },
      },
    });
  });

  it('零参通知的 params 键缺席 → 归一成 null（第一版探针就死在这上面）', () => {
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/server/stopping' }),
      ),
    );
    expect(inst.emitted[0].payload).toEqual({
      method: 'minecraft:notification/server/stopping',
      params: null,
    });
  });

  it('二期接入 server/saved：只更新状态、不生成通知条目', () => {
    // 与 stdout 的 `Saved the game` 是同一次保存，去重在 stdout 侧做（推送在线时它不发事件），
    // 这里只管把状态与缓存失效处理掉
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/server/saved' }),
      ),
    );
    expect(MSMP_NOTIFICATION_ALLOWLIST.has('minecraft:notification/server/saved')).toBe(true);
    expect(inst.emitted).toEqual([
      { name: 'status', payload: { event: 'save' } },
      {
        name: 'msmpNotification',
        payload: { method: 'minecraft:notification/server/saved', params: null },
      },
    ]);
    expect(inst._worldSizeDirty).toBe(true);
  });

  it('server/saving 接进来但不做事（无 stdout 对应物、也没有要更新的用户可见状态）', () => {
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/server/saving' }),
      ),
    );
    expect(inst.emitted).toEqual([
      {
        name: 'msmpNotification',
        payload: { method: 'minecraft:notification/server/saving', params: null },
      },
    ]);
  });

  it('世界升级 4 个通知归一化成 worldUpgrade（消费方不必认识方法名）', () => {
    const cases = [
      ['minecraft:notification/world/upgrade_started', 'started'],
      ['minecraft:notification/world/upgrade_progress', 'progress'],
      ['minecraft:notification/world/upgrade_finished', 'finished'],
      ['minecraft:notification/world/upgrade_failed', 'failed'],
    ];
    for (const [method, state] of cases) {
      // 每个 case 用新实例：同一个实例上累积多次发送后，find 会命中上一轮的旧事件
      const inst = makeInstance();
      inst._msmpNotifHandleMessage(
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params: [0.5] })),
      );
      expect(inst.emitted.find((e) => e.name === 'worldUpgrade')).toEqual({
        name: 'worldUpgrade',
        payload: { state, progress: 0.5 },
      });
    }
  });

  it.each([
    // 实机形态是**位置参数数组**（`params: [0]`）；写成对象会让进度恒为 null，
    // 而单测若也跟着自造对象就永远发现不了——这组夹具按真机原文来
    ['真机形态 [0]', [0], 0],
    ['真机形态 [0.42]', [0.42], 0.42],
    ['params 键整个缺席（started/finished 的实测形态）', undefined, null],
    ['数组首元素不是数字', ['0.5'], null],
    ['空数组', [], null],
    ['不是数组（对象形态，真机上不出现）', { progress: 0.5 }, null],
  ])('progress 取值：%s', (_label, params, expected) => {
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'minecraft:notification/world/upgrade_progress',
          ...(params === undefined ? {} : { params }),
        }),
      ),
    );
    const evt = inst.emitted.find((e) => e.name === 'worldUpgrade');
    expect(evt.payload).toEqual({ state: 'progress', progress: expected });
  });

  it('非世界升级的通知不发 worldUpgrade（只有 server/stopping 这类别的）', () => {
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', method: 'minecraft:notification/server/stopping' }),
      ),
    );
    expect(inst.emitted.map((e) => e.name)).toEqual(['msmpNotification']);
  });

  it('仍未接入的通知（gamerules/updated、server/activity 等）一律不转', () => {
    // 白名单是唯一入口：gamerule 改动今天有属性面板自己写、server/activity 是限流的心跳，
    // 都没有面板要跟的语义
    const inst = makeInstance();
    for (const method of [
      'minecraft:notification/gamerules/updated',
      'minecraft:notification/server/activity',
    ]) {
      inst._msmpNotifHandleMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method })));
      expect(MSMP_NOTIFICATION_ALLOWLIST.has(method)).toBe(false);
    }
    expect(inst.emitted).toEqual([]);
  });

  it('在线名单：加入/离开走幂等入口（两来源同报一次只登记一次）', () => {
    const joined = [];
    const left = [];
    const inst = makeInstance();
    inst._registerPlayerJoin = (name) => joined.push(name);
    inst._handlePlayerLeave = (name) => left.push(name);

    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'minecraft:notification/players/joined',
          params: [{ id: 'uuid-1', name: 'Steve' }],
        }),
      ),
    );
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'minecraft:notification/players/left',
          params: [{ id: 'uuid-1', name: 'Steve' }],
        }),
      ),
    );

    expect(joined).toEqual(['Steve']);
    expect(left).toEqual(['Steve']);
  });

  it('名单变化：按方法分流取目标，载荷形态逐条实测（ip_bans 的字段名是陷阱）', () => {
    // 实测 26.3：allowlist/* 与 bans/removed 是 player 对象、operators/* 与 bans/added 把
    // player 包一层、ip_bans/added 是 {ip}、ip_bans/removed 是**裸字符串**
    const cases = [
      [
        'minecraft:notification/allowlist/added',
        [{ id: 'u', name: 'Steve' }],
        'allowlist',
        'added',
        'Steve',
      ],
      [
        'minecraft:notification/operators/added',
        [{ player: { name: 'Steve' } }],
        'operators',
        'added',
        'Steve',
      ],
      [
        'minecraft:notification/bans/added',
        [{ player: { name: 'Alex' } }],
        'bans',
        'added',
        'Alex',
      ],
      [
        'minecraft:notification/bans/removed',
        [{ id: 'u', name: 'Alex' }],
        'bans',
        'removed',
        'Alex',
      ],
      ['minecraft:notification/ip_bans/added', [{ ip: '1.2.3.4' }], 'ipBans', 'added', '1.2.3.4'],
      ['minecraft:notification/ip_bans/removed', ['1.2.3.4'], 'ipBans', 'removed', '1.2.3.4'],
    ];
    for (const [method, params, list, action, target] of cases) {
      const inst = makeInstance();
      inst._msmpNotifHandleMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params })));
      expect(inst.emitted[0]).toEqual({
        name: 'nameListChanged',
        payload: { list, action, target },
      });
    }
  });

  it('载荷解析不出目标时不猜：仍转发原事件，但目标为空串', () => {
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'minecraft:notification/bans/added',
          params: [{ player: { id: 'u' } }],
        }),
      ),
    );
    expect(
      _msmpNotificationTarget('minecraft:notification/bans/added', [{ player: { id: 'u' } }]),
    ).toBe('');
    expect(inst.emitted[0].payload.target).toBe('');
  });

  it('带 id 的响应（本模块不发请求）不转', () => {
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })),
    );
    expect(inst.emitted).toEqual([]);
  });

  it('非 JSON / 非对象 / method 非字符串一律丢弃且不抛', () => {
    const inst = makeInstance();
    for (const raw of ['not json', '[]', 'null', JSON.stringify({ method: 42 })]) {
      expect(() => inst._msmpNotifHandleMessage(Buffer.from(raw))).not.toThrow();
    }
    expect(inst.emitted).toEqual([]);
  });
});

describe('重连与退避', () => {
  it('掉线 → 退避后重连，且退避翻倍（上限 60s）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    instances[0].emit('open');
    instances[0].emit('close');

    expect(inst._msmpNotifBackoffMs).toBe(4000); // 2000 → 翻倍
    vi.advanceTimersByTime(1999);
    expect(instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(instances).toHaveLength(2); // 到点才重连

    instances[1].emit('close');
    expect(inst._msmpNotifBackoffMs).toBe(8000);
  });

  it('退避有上限，不会无限翻倍', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    for (let i = 0; i < 10; i++) {
      instances.at(-1).emit('close');
      vi.advanceTimersByTime(inst._msmpNotifBackoffMs);
    }
    expect(inst._msmpNotifBackoffMs).toBeLessThanOrEqual(60_000);
  });

  it('连上就重置退避（长期掉线后恢复不该继续等很久）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    instances.at(-1).emit('close');
    vi.advanceTimersByTime(2000);
    instances.at(-1).emit('open');
    expect(inst._msmpNotifBackoffMs).toBe(2000);
  });

  it('error 也会触发重连（不只是 close）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    instances[0].emit('error', new Error('boom'));
    vi.advanceTimersByTime(2000);
    expect(instances.length).toBeGreaterThanOrEqual(2);
  });
});

describe('停止', () => {
  it('stop 后不再重连，且已建连接被关掉', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    const sock = instances[0];
    inst._msmpNotifStop();

    expect(inst._msmpNotifActive).toBe(false);
    expect(sock.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(instances).toHaveLength(1); // 没有新的连接
  });

  it('stop 之后即使被直接调用 connect 也不建连接（守卫而不是靠「没人调它」）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    inst._msmpNotifStop();
    inst._msmpNotifConnect();
    expect(instances).toHaveLength(1);
  });

  it('stop 之后 close 回调不会把它当成掉线去重连', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    const sock = instances[0];
    sock.emit('open');
    inst._msmpNotifStop();
    // stop 已摘掉监听；即便外部再触发 close 也不该排重连
    sock.emit('close');
    vi.advanceTimersByTime(120_000);
    expect(instances).toHaveLength(1);
    expect(inst._msmpNotifReconnectTimer).toBe(null);
  });
});

describe('心跳与半开', () => {
  it('open 后起心跳；pong 回来则保持存活', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    const sock = instances[0];
    sock.emit('open');
    expect(inst._msmpNotifHeartbeat).not.toBe(null);

    vi.advanceTimersByTime(30_000);
    expect(sock.pinged).toBe(1);
    sock.emit('pong');
    expect(inst._msmpNotifAlive).toBe(true);

    vi.advanceTimersByTime(30_000);
    expect(sock.pinged).toBe(2);
  });

  it('半开：ping 后宽限期内没有 pong → terminate 让它走重连', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    const sock = instances[0];
    sock.emit('open');

    vi.advanceTimersByTime(30_000); // ping 发出（无 pong）
    vi.advanceTimersByTime(10_000); // 宽限到点
    expect(sock.terminated).toBe(true);
  });

  it('stop 清掉心跳（不留定时器）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    instances[0].emit('open');
    inst._msmpNotifStop();
    expect(inst._msmpNotifHeartbeat).toBe(null);
    vi.advanceTimersByTime(120_000);
    expect(instances[0].pinged).toBe(0);
  });
});

describe('端点未就绪：有界等待播报行', () => {
  it('端口还没出现在播报行里 → 等它出现，出现即连上（不钉端口、不放弃）', () => {
    let ready = false;
    const inst = {
      id: 'inst-1',
      isRunning: true,
      _msmpNotifActive: false,
      _msmpNotifSocket: null,
      _msmpNotifHeartbeat: null,
      _msmpNotifPongTimer: null,
      _msmpNotifReconnectTimer: null,
      _msmpNotifBackoffMs: 0,
      _msmpNotifAlive: false,
      _msmpNotifConnected: false,
      _msmpNotifEndpointWaitedMs: 0,
      _msmpResolveEndpointResult: () =>
        ready
          ? {
              endpoint: { host: 'localhost', port: 25585, secret: 's'.repeat(40), tls: false },
              reason: null,
            }
          : { endpoint: null, reason: 'no-port' },
    };
    for (const [k, v] of Object.entries({
      _msmpNotifStart,
      _msmpNotifStop,
      _msmpNotifClearTimers,
      _msmpNotifConnect,
      _msmpNotifWaitForEndpoint,
      _msmpNotifHandleMessage,
      _msmpNotifPing,
      _msmpNotifScheduleReconnect,
    })) {
      inst[k] = v;
    }

    inst._msmpNotifStart();
    expect(instances).toHaveLength(0);
    // 播报行还没进日志：等待窗口内反复重试，而不是就此收手
    vi.advanceTimersByTime(4_000);
    expect(instances).toHaveLength(0);
    expect(inst._msmpNotifActive).toBe(true);

    ready = true; // 播报行进日志了
    vi.advanceTimersByTime(2_000);
    expect(instances).toHaveLength(1);
    expect(inst._msmpNotifEndpointWaitedMs).toBe(0);
  });

  it('等满窗口仍未就绪 → 收手（不无限空转）', () => {
    const inst = makeInstance(null, 'no-port');
    inst._msmpNotifStart();
    expect(instances).toHaveLength(0);

    vi.advanceTimersByTime(120_000);
    expect(instances).toHaveLength(0);
    expect(inst._msmpNotifActive).toBe(false);
  });
});

describe('可信连通状态', () => {
  it('open 置真；close/error 置假；stop 归零（界面据此显示「已连通」）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    expect(inst._msmpNotifConnected).toBe(false); // 还没握手成功

    instances[0].emit('open');
    expect(inst._msmpNotifConnected).toBe(true);

    instances[0].emit('close');
    expect(inst._msmpNotifConnected).toBe(false);

    // 退避后重连：新一轮握手成功才算连通
    vi.advanceTimersByTime(2_000);
    instances[1].emit('open');
    expect(inst._msmpNotifConnected).toBe(true);
    instances[1].emit('error', new Error('boom'));
    expect(inst._msmpNotifConnected).toBe(false);

    vi.advanceTimersByTime(4_000);
    instances[2].emit('open');
    expect(inst._msmpNotifConnected).toBe(true);
    inst._msmpNotifStop();
    expect(inst._msmpNotifConnected).toBe(false);
  });
});

// 推送面连通状态改变必须**立刻**告诉客户端：REST 详情是轮询取的，断连不会让它失效，
// 界面会滞后一个轮询周期才把「实时」翻成「轮询」——期间它在说一件已经不再成立的事。
describe('推送面连通状态变化：即时广播快照', () => {
  function lastSnapshot(inst) {
    const snapshots = inst.emitted.filter((e) => e.name === 'status' && !('event' in e.payload));
    return snapshots[snapshots.length - 1]?.payload;
  }

  it('连上 ⇒ 广播一份带 msmpPush=true 的快照（载荷与订阅快照同形）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    inst.emitted.length = 0;

    instances[0].emit('open');

    const payload = lastSnapshot(inst);
    expect(payload.msmpPush).toBe(true);
    expect(payload).toMatchObject({ status: 'running', isRunning: true, tps: null, players: [] });
    // 无 event 字段 ⇒ websocket 侧按**快照**分支广播，不会被当成状态跃迁落库
    expect('event' in payload).toBe(false);
  });

  it('断开 ⇒ 广播 msmpPush=false（这是那条滞后窗口的消除点）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    instances[0].emit('open');
    inst.emitted.length = 0;

    instances[0].emit('close');

    expect(lastSnapshot(inst).msmpPush).toBe(false);
  });

  it('error 与 close 成对到达 ⇒ 只广播一次，不为同一次断开重复写缓存', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    instances[0].emit('open');
    inst.emitted.length = 0;

    instances[0].emit('error');
    instances[0].emit('close');

    expect(inst.emitted.filter((e) => e.name === 'status')).toHaveLength(1);
  });

  it('实例已停 ⇒ 即便连接态还是 true 也报 false（不留上一次运行的残留）', () => {
    const inst = makeInstance();
    inst._msmpNotifStart();
    instances[0].emit('open');
    inst.isRunning = false;
    inst.emitted.length = 0;

    inst._emitPushChannelState();

    expect(lastSnapshot(inst).msmpPush).toBe(false);
  });
});
