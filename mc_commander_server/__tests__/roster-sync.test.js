/**
 * 在线名单对账域测试（根修）
 * 覆盖两条现场：接管后名单恒空（面板缺席期间的加入）、运行期漏解析导致的名单漂移。
 * 数据全部为虚构占位（Steve/Alex、192.0.2.x TEST-NET-1）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-roster-test-'));
  return {
    default: {
      port: 0,
      serversDir: path.join(tmpRoot, 'servers'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      logLevel: 'error',
      rateLimit: { windowMs: 60000, max: 100 },
      autoStartDelayMs: 2000,
      crashLoop: { windowMs: 300000, maxCrashes: 5 },
    },
  };
});

import {
  ROSTER_RECONCILE_INTERVAL_MS,
  ROSTER_FIRST_RECONCILE_MS,
  _reconcilePlayers,
  _scheduleRosterReconcile,
  _stopRosterSync,
} from '../services/mc-server/roster-sync.js';
import { MCServerInstance } from '../services/mc_server.js';
import { shadowProfilePath } from '../utils/player-utils.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-roster-fixture-'));

/** RCON 就绪：裸原型实例不带 properties，_loadProperties 回退内存缓存即够判定 */
function enableRcon(inst) {
  inst.properties = { 'enable-rcon': 'true', 'rcon.password': 'test-rcon-password' };
}

/** 裸原型实例：验证 Object.assign 挂载后的 this 绑定，不经 constructor 副作用 */
function makeInstance(name = 'inst') {
  const inst = Object.create(MCServerInstance.prototype);
  inst.id = name;
  inst.serverPath = fs.mkdtempSync(path.join(tmpBase, `${name}-`));
  inst.isRunning = true;
  inst.adopted = true;
  inst.players = new Map();
  inst.playerEvents = new Map();
  inst._pendingIps = new Map();
  inst._todayNewCache = null;
  inst._rosterTimer = null;
  inst._rosterEpoch = 0;
  inst._msmpAvailable = false;
  inst._deathAggBuffer = [];
  inst._sleepingPlayers = 0;
  enableRcon(inst);
  // 默认为空名单：各用例按需覆写
  inst.sendCommandWithResponse = vi.fn(async () => LIST_EMPTY);
  return inst;
}

const LIST_EMPTY = 'There are 0 of a max of 20 players online: ';
/** 实机返回形态（逐字样本见 list-response.test.js） */
function listOf(...names) {
  return `There are ${names.length} of a max of 20 players online: ${names.join(', ')}${
    names.length ? '' : ' '
  }`;
}

/** 写一份面板落盘的影子档案：open=true 表示末段会话未闭合（面板缺席期间的加入） */
function writeShadow(inst, name, { open = true, ip = '192.0.2.10', totalPlayTime = 300 } = {}) {
  const start = Date.now() - 600000;
  fs.mkdirSync(path.join(inst.serverPath, 'playerdata'), { recursive: true });
  fs.writeFileSync(
    shadowProfilePath({ serverPath: inst.serverPath, playerName: name }),
    JSON.stringify({
      name,
      joinTime: start,
      ip,
      totalPlayTime,
      sessions: [
        { start: start - 100000, end: start - 50000, duration: 50 },
        open ? { start, end: null, duration: 0 } : { start, end: start + 1000, duration: 1 },
      ],
    }),
  );
}
beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('_fetchOnlineRoster 通道择优（MSMP 优先，RCON 兜底）', () => {
  it('MSMP 可用 → 用 MSMP 结果，且不再走 RCON', async () => {
    const inst = makeInstance('msmp-first');
    inst._msmpFetchOnlinePlayers = vi.fn(async () => ({ names: ['Steve'] }));
    expect(await inst._fetchOnlineRoster()).toEqual({ names: ['Steve'] });
    expect(inst.sendCommandWithResponse).not.toHaveBeenCalled();
  });

  it('MSMP 取到结构化名单 → 记能力可用（界面据此显示 MSMP 已启用）', async () => {
    const inst = makeInstance('msmp-cap-on');
    inst._msmpAvailable = false;
    inst._msmpFetchOnlinePlayers = vi.fn(async () => ({ names: ['Steve'] }));
    await inst._fetchOnlineRoster();
    expect(inst._msmpAvailable).toBe(true);
  });

  it('MSMP 不可用 → 回退 RCON，并把能力记回不可用（能力是测得而非推断）', async () => {
    const inst = makeInstance('msmp-fallback');
    inst._msmpAvailable = true;
    inst._msmpFetchOnlinePlayers = vi.fn(async () => null);
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Alex'));
    expect(await inst._fetchOnlineRoster()).toEqual({ names: ['Alex'] });
    expect(inst._msmpAvailable).toBe(false);
  });

  it('空名单也算实测成功：MSMP 返回 0 人时不得回退 RCON', async () => {
    const inst = makeInstance('msmp-empty');
    // 「0 人」是合法答案；若把它当失败去回退，等于用一个更弱的来源推翻权威答案
    inst._msmpFetchOnlinePlayers = vi.fn(async () => ({ names: [] }));
    expect(await inst._fetchOnlineRoster()).toEqual({ names: [] });
    expect(inst.sendCommandWithResponse).not.toHaveBeenCalled();
  });

  it('两条通道都取不到 → null（保持现状，不清空名单）', async () => {
    const inst = makeInstance('both-down');
    inst._msmpFetchOnlinePlayers = vi.fn(async () => null);
    inst.properties = {};
    expect(await inst._fetchOnlineRoster()).toBeNull();
  });

  it('实例已停 → 两条通道都不试', async () => {
    const inst = makeInstance('stopped');
    inst.isRunning = false;
    inst._msmpFetchOnlinePlayers = vi.fn(async () => ({ names: ['Steve'] }));
    expect(await inst._fetchOnlineRoster()).toBeNull();
    expect(inst._msmpFetchOnlinePlayers).not.toHaveBeenCalled();
  });
});

describe('_fetchOnlineRoster 取名单的失败语义', () => {
  it('未运行 / RCON 未连接 → null（不做无意义的命令尝试）', async () => {
    const inst = makeInstance('gate');
    inst.isRunning = false;
    expect(await inst._fetchOnlineRoster()).toBeNull();
    inst.isRunning = true;
    inst.properties = {};
    expect(await inst._fetchOnlineRoster()).toBeNull();
    expect(inst.sendCommandWithResponse).not.toHaveBeenCalled();
  });

  it('空名单解析为 []：是合法答案而非「取不到」', async () => {
    const inst = makeInstance('empty');
    expect(await inst._fetchOnlineRoster()).toEqual({ names: [] });
  });

  it('查询带调用方级超时：rcon-client 只在请求出队时才计时，队列滞留期无上限', async () => {
    const inst = makeInstance('timeout');
    await inst._fetchOnlineRoster();
    expect(inst.sendCommandWithResponse).toHaveBeenCalledWith('list', {
      timeout: expect.any(Number),
    });
    const [, opts] = inst.sendCommandWithResponse.mock.calls[0];
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('命令抛错（队列拒绝/RCON 卡顿）→ null，不向上抛', async () => {
    const inst = makeInstance('throw');
    inst.sendCommandWithResponse = vi.fn(async () => {
      throw new Error('Command response unavailable: RCON is not connected');
    });
    expect(await inst._fetchOnlineRoster()).toBeNull();
  });

  it('返回措辞不认识 → null（不误判成空名单）', async () => {
    const inst = makeInstance('garbled');
    inst.sendCommandWithResponse = vi.fn(async () => 'Unknown command. Type "/help" for help.');
    expect(await inst._fetchOnlineRoster()).toBeNull();
  });
});

describe('_reconcilePlayers 补齐面板缺席期间的加入', () => {
  it('落盘有未闭合会话 → 仍从对账时刻起算会话，不把缺席时段计成在线时长', async () => {
    const inst = makeInstance('restore');
    writeShadow(inst, 'Steve', { totalPlayTime: 300 });
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));

    await inst._reconcilePlayers();

    const p = inst.players.get('Steve');
    expect(p).toBeDefined();
    // 日志只有时分秒、档案区分不出「一直在同一会话」与「离开过又回来」，
    // 故不猜缺席期间那次会话的起点：落到对账时刻只是少算一段无人观测的时长
    expect(Date.now() - p.joinTime).toBeLessThan(5000);
    // 落盘累计时长保留，遗留的未闭合会话以零时长闭合，再开一段新会话
    expect(p.totalPlayTime).toBe(300);
    expect(p.sessions).toHaveLength(3);
    expect(p.sessions[0].duration).toBe(50);
    expect(p.sessions[1].duration).toBe(0);
    expect(p.sessions[1].end).not.toBeNull();
    expect(p.sessions.at(-1).end).toBeNull();
  });

  it('无落盘档案 → 走 _registerPlayerJoin（记 join 事件 + playerJoin 广播）', async () => {
    const inst = makeInstance('fresh');
    const events = [];
    inst.on('playerJoin', (p) => events.push(p));
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Alex'));

    await inst._reconcilePlayers();

    const p = inst.players.get('Alex');
    expect(p).toBeDefined();
    expect(Date.now() - p.joinTime).toBeLessThan(5000);
    expect(inst.playerEvents.get('Alex')[0].type).toBe('join');
    expect(events).toEqual([p]);
  });

  it('取不到名单 → 保持现状，不清空已有在线玩家', async () => {
    const inst = makeInstance('keep');
    inst.players.set('Steve', { name: 'Steve', joinTime: Date.now(), ip: '', sessions: [] });
    inst.sendCommandWithResponse = vi.fn(async () => {
      throw new Error('RCON is not connected');
    });

    await inst._reconcilePlayers();

    expect(inst.players.has('Steve')).toBe(true);
  });

  it('补缺来的玩家离开时，只累计可观测的那段，会话闭合', async () => {
    const inst = makeInstance('restore-leave');
    writeShadow(inst, 'Steve', { totalPlayTime: 300 });
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));
    await inst._reconcilePlayers();
    inst._savePlayerData = vi.fn();

    inst.sendCommandWithResponse = vi.fn(async () => LIST_EMPTY);
    await inst._reconcilePlayers();

    expect(inst.players.has('Steve')).toBe(false);
    const saved = inst._savePlayerData.mock.calls[0][1];
    // 300（落盘累计）+ 本轮补缺到离开之间的秒数；不含缺席时段
    expect(saved.totalPlayTime).toBeGreaterThanOrEqual(300);
    expect(saved.totalPlayTime).toBeLessThan(300 + 60);
    expect(saved.sessions.at(-1).end).not.toBeNull();
  });
});

describe('_reconcilePlayers 运行期纠偏', () => {
  it('漏解析的加入被补上、漏解析的离开被移除，已有条目不被重置', async () => {
    const inst = makeInstance('drift');
    const joinTime = Date.now() - 120000;
    const existing = { name: 'Steve', joinTime, ip: '', totalPlayTime: 999, sessions: [] };
    inst.players.set('Steve', existing);
    inst.players.set('Herobrine', { name: 'Herobrine', joinTime, ip: '', sessions: [] });
    writeShadow(inst, 'Alex', { open: false });
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve', 'Alex'));

    await inst._reconcilePlayers();

    // 已有条目是同一引用（累计时长没被重置），离开的被移除
    expect(inst.players.get('Steve')).toBe(existing);
    expect(inst.players.get('Steve').totalPlayTime).toBe(999);
    expect(inst.players.has('Herobrine')).toBe(false);
    expect(inst.players.has('Alex')).toBe(true);
  });

  it('空名单 → 全部按离开处理（关会话 + 累计时长 + playerLeave 广播）', async () => {
    const inst = makeInstance('allleft');
    const events = [];
    inst.on('playerLeave', (e) => events.push(e));
    const player = {
      name: 'Steve',
      joinTime: Date.now() - 60000,
      ip: '',
      totalPlayTime: 0,
      sessions: [{ start: Date.now() - 60000, end: null, duration: 0 }],
    };
    inst.players.set('Steve', player);

    await inst._reconcilePlayers();

    expect(inst.players.size).toBe(0);
    expect(player.sessions[0].end).not.toBeNull();
    expect(player.totalPlayTime).toBeGreaterThanOrEqual(60);
    expect(events).toEqual([{ name: 'Steve' }]);
  });

  it('名单与内存一致时不产生任何事件', async () => {
    const inst = makeInstance('stable');
    const events = [];
    inst.on('playerJoin', (p) => events.push(p));
    inst.on('playerLeave', (p) => events.push(p));
    inst.players.set('Steve', {
      name: 'Steve',
      joinTime: Date.now(),
      ip: '',
      totalPlayTime: 0,
      sessions: [],
    });
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));

    await inst._reconcilePlayers();

    expect(events).toEqual([]);
  });

  it('玩家离开后重新加入 → 开新会话，不累积重复条目', async () => {
    const inst = makeInstance('rejoin');
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));
    await inst._reconcilePlayers();
    expect(inst.players.get('Steve').sessions).toHaveLength(1);

    inst.sendCommandWithResponse = vi.fn(async () => LIST_EMPTY);
    await inst._reconcilePlayers();
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));
    await inst._reconcilePlayers();

    const second = inst.players.get('Steve');
    expect(second.sessions).toHaveLength(2);
    expect(second.sessions[0].end).not.toBeNull();
    expect(Date.now() - second.joinTime).toBeLessThan(5000);
  });

  it('对账补缺的玩家随后被日志再次报加入 → 幂等，不重复计今日新增', async () => {
    const inst = makeInstance('dedupe');
    inst._todayKey = () => '2026-10-04';
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Alex'));

    await inst._reconcilePlayers(); // 名单先到
    const entry = inst.players.get('Alex');
    inst._parseOutput('[12:00:00] [Server thread/INFO]: Alex joined the game'); // 日志后到

    expect(inst.players.get('Alex')).toBe(entry);
    expect(inst.players.get('Alex').sessions).toHaveLength(1);
    expect((inst.playerEvents.get('Alex') || []).filter((e) => e.type === 'join')).toHaveLength(1);
    expect(inst._todayNewCache.count).toBe(1);
  });

  it('日志先到、名单后到同样幂等', async () => {
    const inst = makeInstance('dedupe2');
    inst._todayKey = () => '2026-10-04';
    inst._parseOutput('[12:00:00] [Server thread/INFO]: Alex joined the game');
    const entry = inst.players.get('Alex');
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Alex'));

    await inst._reconcilePlayers();

    expect(inst.players.get('Alex')).toBe(entry);
    expect(inst.players.get('Alex').sessions).toHaveLength(1);
    expect(inst._todayNewCache.count).toBe(1);
  });
});

describe('_reconcilePlayers 与实例停止的竞态', () => {
  it('名单在途时实例停止（退出路径清空在线表）→ 不写回幽灵在线玩家', async () => {
    const inst = makeInstance('stop-race');
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    inst.sendCommandWithResponse = vi.fn(async () => {
      await gate;
      return listOf('Steve');
    });

    const pending = inst._reconcilePlayers();
    await new Promise((r) => setImmediate(r));
    // 停止：与 _attachExitListener / adopt 看门狗同序——清空在线表并停采集
    inst.isRunning = false;
    inst.players.clear();
    inst._stopRosterSync();
    release();
    await pending;

    expect(inst.players.size).toBe(0);
  });

  it('名单在途时 spawn 失败（未推进代际，仅 isRunning=false）→ 不写回幽灵在线玩家', async () => {
    const inst = makeInstance('spawn-error-race');
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    inst.sendCommandWithResponse = vi.fn(async () => {
      await gate;
      return listOf('Steve');
    });

    const pending = inst._reconcilePlayers();
    await new Promise((r) => setImmediate(r));
    // spawn 失败路径：置 isRunning=false 但不动代际，也可能不经过 clear()
    inst.isRunning = false;
    release();
    await pending;

    expect(inst.players.has('Steve')).toBe(false);
  });

  it('名单在途时 stop→start（代际推进）→ 旧名单不写进新一轮', async () => {
    const inst = makeInstance('restart-race');
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    inst.sendCommandWithResponse = vi.fn(async () => {
      await gate;
      return listOf('Steve');
    });

    const pending = inst._reconcilePlayers();
    await new Promise((r) => setImmediate(r));
    inst._startRosterSync(); // 新一轮：代际自增
    release();
    await pending;

    expect(inst.players.has('Steve')).toBe(false);
  });
});

describe('对账调度链（串行化递归 setTimeout + 代际 epoch）', () => {
  it('_startRosterSync 先行清理旧链并排程首轮', async () => {
    const inst = makeInstance('start');
    const stale = setTimeout(() => {
      throw new Error('旧链不应触发');
    }, 5);
    inst._rosterTimer = stale;
    inst._rosterEpoch = 5;
    inst._reconcilePlayers = vi.fn(async () => {});

    inst._startRosterSync();

    expect(inst._rosterTimer).not.toBe(stale);
    expect(inst._rosterEpoch).toBe(6);
    expect(inst._rosterTimer).not.toBeNull();
  });

  it('_scheduleRosterReconcile 到达间隔触发，本轮完成后自续链', async () => {
    vi.useFakeTimers();
    const inst = makeInstance('chain');
    const reconcile = vi.fn(async () => {});
    inst._reconcilePlayers = reconcile;

    inst._scheduleRosterReconcile(ROSTER_RECONCILE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(ROSTER_RECONCILE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(inst._rosterTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(ROSTER_RECONCILE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('对账抛错不中断链；代际推进后停链', async () => {
    vi.useFakeTimers();
    const inst = makeInstance('resilient');
    let call = 0;
    inst._reconcilePlayers = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('broadcast failed');
      if (call === 2) inst._rosterEpoch += 1; // 模拟对账期间被 stop
    });

    inst._scheduleRosterReconcile(ROSTER_RECONCILE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(ROSTER_RECONCILE_INTERVAL_MS);
    expect(call).toBe(1);
    await vi.advanceTimersByTimeAsync(ROSTER_RECONCILE_INTERVAL_MS); // reject 后仍续链
    expect(call).toBe(2);
    await vi.advanceTimersByTimeAsync(ROSTER_RECONCILE_INTERVAL_MS); // 代际已变 → 停链
    expect(call).toBe(2);
    expect(inst._rosterTimer).toBeNull();
  });

  it('_stopRosterSync 清定时器并推进代际，零状态安全且幂等', () => {
    const inst = makeInstance('stop');
    inst._rosterTimer = setTimeout(() => {}, 1000);
    inst._rosterEpoch = 3;

    inst._stopRosterSync();

    expect(inst._rosterTimer).toBeNull();
    expect(inst._rosterEpoch).toBe(4);
    expect(() => inst._stopRosterSync()).not.toThrow();
    expect(inst._rosterEpoch).toBe(5);
  });

  it('首轮提前量早于常规对账间隔（接管时 RCON 尚未握手，需先给握手窗口）', () => {
    expect(ROSTER_FIRST_RECONCILE_MS).toBeLessThan(ROSTER_RECONCILE_INTERVAL_MS);
  });
});

describe('采集矩阵启停联动', () => {
  it('_startStatsCollection 建立对账链，_stopStatsCollection 拆除', () => {
    const inst = makeInstance('matrix');
    inst._collectStats = vi.fn();
    inst._collectWorldState = vi.fn(async () => {});
    inst.logBuffer = [];
    inst._statsTimer = null;
    inst._msptTimer = null;
    inst._saveTimer = null;
    inst._playerStatsTimer = null;
    inst._worldStateTimer = null;
    inst._playerStatsEpoch = 0;
    inst._msptEpoch = 0;
    inst._worldStateEpoch = 0;

    inst._startStatsCollection();
    expect(inst._rosterTimer).not.toBeNull();

    inst._stopStatsCollection();
    expect(inst._rosterTimer).toBeNull();
  });
});

describe('落盘档案脏数据不影响对账', () => {
  it('sessions 字段为各种异常形态时不抛错，仍能把玩家登记为在线', async () => {
    const dirName = 'malformed';
    const inst = makeInstance(dirName);
    const dir = path.join(inst.serverPath, 'playerdata');
    fs.mkdirSync(dir, { recursive: true });
    for (const [label, body] of [
      ['sessions 为空', { sessions: [] }],
      ['sessions 为 null', { sessions: null }],
      ['sessions 非数组', { sessions: { length: 1, 0: { start: Date.now(), end: null } } }],
      ['末段为 null', { sessions: [null] }],
      ['末段缺 start', { sessions: [{ end: null }] }],
      ['JSON 损坏', null],
    ]) {
      inst.playerEvents.clear();
      inst.players.clear();
      fs.writeFileSync(
        path.join(dir, `${label}.json`),
        body === null ? '{ not json' : JSON.stringify(body),
      );
      inst.sendCommandWithResponse = vi.fn(async () => listOf(label));

      await inst._reconcilePlayers();

      const p = inst.players.get(label);
      expect(p, label).toBeDefined();
      expect(Array.isArray(p.sessions), label).toBe(true);
      expect(Date.now() - p.joinTime, label).toBeLessThan(5000);
      expect(p.totalPlayTime, label).toBe(0);
    }
  });

  it('落盘 sessions 非数组时不得把它带进内存条目（下游按数组消费）', async () => {
    const inst = makeInstance('notarray');
    const dir = path.join(inst.serverPath, 'playerdata');
    fs.mkdirSync(dir, { recursive: true });
    // 带 length 与下标、但本身不是数组：`saved.sessions || []` 会放行它，
    // 于是 sessions.at(-1)/for..of 在路由与详情页上抛错
    fs.writeFileSync(
      path.join(dir, 'Steve.json'),
      JSON.stringify({ sessions: { length: 1, 0: { start: Date.now(), end: null } } }),
    );
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));

    await inst._reconcilePlayers();

    expect(Array.isArray(inst.players.get('Steve').sessions)).toBe(true);
  });
});
