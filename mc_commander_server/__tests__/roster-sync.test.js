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
  inst._deathAggBuffer = [];
  inst._sleepingPlayers = 0;
  enableRcon(inst);
  // 默认为空名单：各用例按需覆写
  inst.sendCommandWithResponse = vi.fn(async () => LIST_EMPTY);
  return inst;
}

const LIST_EMPTY = 'There are 0 of a max of 20 players online: ';
/** 实机样本形态（见 .ai/References/2026-10-04-实机取模样本.md） */
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
    path.join(inst.serverPath, 'playerdata', `${name}.json`),
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
  it('有未闭合会话 → 按落盘档案还原，joinTime/ip/累计时长取落盘值且不重开会话', async () => {
    const inst = makeInstance('restore');
    writeShadow(inst, 'Steve', { ip: '192.0.2.10', totalPlayTime: 300 });
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));

    await inst._reconcilePlayers();

    const p = inst.players.get('Steve');
    expect(p).toBeDefined();
    // 真实加入时刻（面板缺席期间仍在同一会话）——落到对账时刻会把在线时长清零
    expect(Date.now() - p.joinTime).toBeGreaterThan(500000);
    expect(p.ip).toBe('192.0.2.10');
    expect(p.totalPlayTime).toBe(300);
    expect(p.sessions).toHaveLength(2);
    expect(p.sessions.at(-1).end).toBeNull();
    // 静默还原：不补发 join 事件、不计今日新增（加入发生在面板缺席期间）
    expect(inst.playerEvents.has('Steve')).toBe(false);
    expect(inst._todayNewCache).toBeNull();
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

  it('落盘档案末段会话已闭合（面板记过 leave）→ 不当作缺席加入，走常规入口', async () => {
    const inst = makeInstance('closed');
    writeShadow(inst, 'Steve', { open: false });
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));

    await inst._reconcilePlayers();

    // 常规入口开新会话：末段闭合会话被保留、新增一段未闭合的
    expect(Date.now() - inst.players.get('Steve').joinTime).toBeLessThan(5000);
    expect(inst.players.get('Steve').sessions).toHaveLength(3);
    expect(inst.playerEvents.get('Steve')[0].type).toBe('join');
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

  it('还原来的玩家真正离开时，累计时长按真实加入时刻算且会话闭合', async () => {
    const inst = makeInstance('restore-leave');
    writeShadow(inst, 'Steve', { totalPlayTime: 300 });
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));
    await inst._reconcilePlayers();
    inst._savePlayerData = vi.fn();

    inst.sendCommandWithResponse = vi.fn(async () => LIST_EMPTY);
    await inst._reconcilePlayers();

    expect(inst.players.has('Steve')).toBe(false);
    const saved = inst._savePlayerData.mock.calls[0][1];
    expect(saved.totalPlayTime).toBeGreaterThanOrEqual(900);
    expect(saved.sessions.at(-1).end).not.toBeNull();
    // 落盘后档案不再有未闭合会话 ⇒ 下次对账不会把一次新加入误判成缺席加入
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(inst.serverPath, 'playerdata', 'Steve.json'), 'utf8'),
    );
    expect(onDisk.sessions.at(-1).duration).toBe(0);
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

  it('还原来的玩家被移除后又重新加入 → 走常规入口（不重复计缺席）', async () => {
    const inst = makeInstance('rejoin');
    writeShadow(inst, 'Steve', { open: true });
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));
    await inst._reconcilePlayers();
    const first = inst.players.get('Steve');
    expect(first.sessions).toHaveLength(2);

    // 离开（落盘闭合会话）后再加入：此时档案无未闭合会话，且 _savePlayerData 已写盘
    inst.sendCommandWithResponse = vi.fn(async () => LIST_EMPTY);
    await inst._reconcilePlayers();
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));
    await inst._reconcilePlayers();

    const second = inst.players.get('Steve');
    expect(second.sessions).toHaveLength(3);
    expect(Date.now() - second.joinTime).toBeLessThan(5000);
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

describe('_restoreOnlinePlayerEntry 边界', () => {
  it('末段会话 start 为 0（脏数据）时不认作未闭合', async () => {
    const inst = makeInstance('dirty');
    fs.mkdirSync(path.join(inst.serverPath, 'playerdata'), { recursive: true });
    fs.writeFileSync(
      path.join(inst.serverPath, 'playerdata', 'Steve.json'),
      JSON.stringify({ sessions: [{ start: 0, end: null, duration: 0 }] }),
    );
    inst.sendCommandWithResponse = vi.fn(async () => listOf('Steve'));

    await inst._reconcilePlayers();

    // 走常规入口 ⇒ joinTime 为当前时刻而非 0
    expect(inst.players.get('Steve').joinTime).toBeGreaterThan(0);
  });

  it('无 playerdata 文件 → null（无缺席线索，交由常规加入入口）', () => {
    const inst = makeInstance('nofile');
    expect(inst._restoreOnlinePlayerEntry('Alex')).toBeNull();
  });

  it('落盘字段缺失/类型异常 → null（不因脏数据抛出）', () => {
    const inst = makeInstance('malformed');
    const dir = path.join(inst.serverPath, 'playerdata');
    fs.mkdirSync(dir, { recursive: true });
    for (const [label, body] of [
      ['sessions 为空', { sessions: [] }],
      ['sessions 为 null', { sessions: null }],
      ['末段为 null', { sessions: [null] }],
      ['末段缺 start', { sessions: [{ end: null }] }],
      ['JSON 损坏', null],
    ]) {
      const file = path.join(dir, `${label}.json`);
      fs.writeFileSync(file, body === null ? '{ not json' : JSON.stringify(body));
      expect(inst._restoreOnlinePlayerEntry(label), label).toBeNull();
    }
  });

  it('sessions 非数组时不得把它带进内存条目（下游按数组消费）', () => {
    const inst = makeInstance('notarray');
    const dir = path.join(inst.serverPath, 'playerdata');
    fs.mkdirSync(dir, { recursive: true });
    // 带 length 与下标、但本身不是数组：`saved.sessions || []` 会放行它，
    // 于是 sessions.at(-1)/for..of 在路由与详情页上抛错
    fs.writeFileSync(
      path.join(dir, 'Steve.json'),
      JSON.stringify({ sessions: { length: 1, 0: { start: Date.now(), end: null } } }),
    );

    expect(inst._restoreOnlinePlayerEntry('Steve')).toBeNull();
  });

  it('落盘值缺失时按零值兜底，不把 undefined 带进内存条目', () => {
    const inst = makeInstance('sparse');
    const dir = path.join(inst.serverPath, 'playerdata');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'Alex.json'),
      JSON.stringify({ sessions: [{ start: Date.now() - 1000, end: null }] }),
    );

    const entry = inst._restoreOnlinePlayerEntry('Alex');

    expect(entry.ip).toBe('');
    expect(entry.totalPlayTime).toBe(0);
    expect(entry.name).toBe('Alex');
  });
});
