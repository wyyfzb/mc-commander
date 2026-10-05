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
  MSMP_NOTIFICATION_ALLOWLIST,
} = await import('../services/mc-server/msmp-notifications.js');

/** 最小实例替身：只带连接域需要的状态 + 一个事件收集器 */
function makeInstance(
  endpoint = { host: 'localhost', port: 25585, secret: 's'.repeat(40), tls: false },
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
    _msmpResolveEndpoint: () => endpoint,
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

  it('端点为 null（未开启 MSMP/未起）时不建连接，也不空转重连', () => {
    const inst = makeInstance(null);
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
    expect(inst.emitted).toEqual([
      {
        name: 'msmpNotification',
        payload: {
          method: 'minecraft:notification/world/upgrade_progress',
          params: { progress: 0.42 },
        },
      },
    ]);
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

  it('有 stdout 对应物的通知不接（避免两个来源报同一件事）', () => {
    // server/saved ↔ 解析器的 `Saved the game` → status:'save'；server/started ↔ `Done (…)`
    // → status:'ready'。接它们就要先定去重，属二期。
    const inst = makeInstance();
    for (const m of [
      'minecraft:notification/server/saved',
      'minecraft:notification/server/started',
    ]) {
      inst._msmpNotifHandleMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: m })));
      expect(MSMP_NOTIFICATION_ALLOWLIST.has(m)).toBe(false);
    }
    expect(inst.emitted).toEqual([]);
  });

  it('白名单外的通知（名单类）一律不转——一期刻意不接，接了就要先定去重', () => {
    const inst = makeInstance();
    inst._msmpNotifHandleMessage(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'minecraft:notification/players/joined',
          params: { player: { name: 'Steve' } },
        }),
      ),
    );
    expect(inst.emitted).toEqual([]);
    expect(MSMP_NOTIFICATION_ALLOWLIST.has('minecraft:notification/players/joined')).toBe(false);
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
