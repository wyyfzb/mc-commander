/**
 * 游戏规则读链路域测试。
 *
 * 承重点四条：
 * ① 三种读值文案（26.3 无冒号 / 1.21.11 有冒号 / 1.21.9 的 camelCase）都能解析出值，
 *    而 `Incorrect argument` 必须落到 missing 而不是 unreadable——三态在界面上是三种不同结论；
 * ② 长回包按 4096 字节切成多包时**必须拼接**：只取第一包会让 26.3 的 58 条名单静默变成 47 条；
 * ③ 名单只由服务器自述，`minecraft:` 前缀与重复项必须去掉（1.21.10 的前缀实参是非法实参）；
 * ④ 读值只能走 sendCommandWithResponse：走 sendCommand 会在 finally 里落命令史并向终端回显。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock 隔离：子进程 / RCON / SQLite 模型（同 mc_server 系列用例口径）──
vi.mock('child_process', () => {
  const spawn = vi.fn();
  const spawnSync = vi.fn();
  const exec = vi.fn();
  return { spawn, spawnSync, exec, default: { spawn, spawnSync, exec } };
});

vi.mock('rcon-client', () => {
  const Rcon = vi.fn();
  Rcon.connect = vi.fn();
  return { Rcon };
});

vi.mock('../src/db/index.js', () => ({
  InstanceModel: {
    getAll: vi.fn(() => []),
    getById: vi.fn(() => null),
    migrateFromJson: vi.fn(),
    addUptime: vi.fn(),
    getTotalUptime: vi.fn(() => 0),
  },
  CommandHistoryModel: { create: vi.fn() },
}));

import { MCServerInstance } from '../src/services/mc_server.js';
import { CommandHistoryModel } from '../src/db/index.js';
import {
  parseGameruleRoster,
  parseGameruleReply,
  _rconCommandCollect,
  _readGamerulesViaMsmp,
  _fetchGameruleRoster,
  _readGameruleEntry,
  _readGamerules,
} from '../src/services/mc-server/gamerule-reader.js';

/** 把读链路域挂到桩上（与生产一致：方法在实例原型上，函数体内 this 绑定实例） */
function makeInstance(stub = {}) {
  const instance = {
    id: 'gamerule-stub',
    isRunning: true,
    isRconConnected: true,
    _msmpRequest: vi.fn(async () => null),
    sendCommandWithResponse: vi.fn(async () => ''),
    sendCommand: vi.fn(async () => 'sent-via-log-command'),
    ...stub,
  };
  Object.assign(instance, {
    _rconCommandCollect,
    _readGamerulesViaMsmp,
    _fetchGameruleRoster,
    _readGameruleEntry,
    _readGamerules,
  });
  return instance;
}

/** 编一个 RCON 响应包（type 0），body 为字符串 */
function responseFrame(id, body) {
  const payload = Buffer.from(body, 'utf8');
  const packet = Buffer.alloc(payload.length + 14);
  packet.writeInt32LE(payload.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(0, 8);
  payload.copy(packet, 12);
  return packet;
}

/**
 * 假 RCON 连接：socket 是 EventEmitter + write()，写入后按脚本把响应包 emit 回来。
 * 生产里写进去的是我们自己的请求包，id 由实现指定，故这里回包直接沿用写入包里的 id。
 */
function makeFakeRcon(respond) {
  const socket = new EventEmitter();
  socket.write = vi.fn((packet) => {
    const id = packet.readInt32LE(4);
    // 载荷后跟两个结尾空字节（RCON 协议固定形态），比对命令前先剥掉
    const command = packet.subarray(12).toString('utf8').replace(/\0+$/, '');
    const frames = respond(command, id);
    if (frames) setImmediate(() => frames.forEach((frame) => socket.emit('data', frame)));
  });
  return { socket, send: vi.fn(), end: vi.fn() };
}

// 逐版本实测原文（虚构实例、真实文案）
const REPLY_26_3 = 'Game rule random_tick_speed is currently set to 3';
const REPLY_12111 = 'Gamerule random_tick_speed is currently set to: 3';
const REPLY_1219 = 'Gamerule randomTickSpeed is currently set to: 2147483647';
const REPLY_MISSING = 'Incorrect argument for commandgamerule doDaylightCycle<--[HERE]';

// 26.x 的 help 回包：每条列两遍（裸名 + minecraft: 前缀），58 条规则共 116 条用法
const ROSTER_26X = [
  '/gamerule spawn_phantoms [<value>]',
  '/gamerule minecraft:spawn_phantoms [<value>]',
  '/gamerule random_tick_speed [<value>]',
  '/gamerule minecraft:random_tick_speed [<value>]',
].join('');

// 1.21.10 的 help 回包：camelCase、无前缀项
const ROSTER_LEGACY = [
  '/gamerule randomTickSpeed [<value>]',
  '/gamerule pvp [<value>]',
  '/gamerule doDaylightCycle [<value>]',
].join('');
const ROSTER_LEGACY_NAMES = ['randomTickSpeed', 'pvp', 'doDaylightCycle'];

describe('单条读值回包解析：三式文案与三态', () => {
  it.each([
    ['26.3 无冒号', REPLY_26_3, 'integer', '3'],
    ['1.21.11 有冒号', REPLY_12111, 'integer', '3'],
    ['1.21.9 camelCase', REPLY_1219, 'integer', '2147483647'],
    ['26.3 布尔', 'Game rule pvp is currently set to true', 'boolean', 'true'],
    ['1.21.11 布尔', 'Gamerule pvp is currently set to: false', 'boolean', 'false'],
  ])('%s → current + 类型由值形状判定', (_label, reply, type, value) => {
    expect(parseGameruleReply(reply)).toEqual({ status: 'current', type, value });
  });

  it('回包里的名字带命名空间也照样取到值（服务端会剥前缀，名字不参与判定）', () => {
    expect(parseGameruleReply('Gamerule minecraft:pvp is currently set to: true')).toEqual({
      status: 'current',
      type: 'boolean',
      value: 'true',
    });
  });

  it('Incorrect argument → missing（与读取失败是两件事）', () => {
    expect(parseGameruleReply(REPLY_MISSING)).toEqual({
      status: 'missing',
      type: null,
      value: null,
    });
  });

  it.each([
    ['空回包', ''],
    ['措辞不认识', 'Game rule pvp is currently set to yes'],
    ['未开服的连接提示', 'Command response unavailable: RCON is not connected'],
    ['null', null],
  ])('%s → unreadable（不猜默认值）', (_label, reply) => {
    expect(parseGameruleReply(reply)).toEqual({ status: 'unreadable', type: null, value: null });
  });
});

describe('help gamerule 名单解析：去前缀、去重、丢残名', () => {
  it('26.x 双份写法（裸名 + minecraft: 前缀）去重成裸名', () => {
    expect(parseGameruleRoster(ROSTER_26X)).toEqual(['spawn_phantoms', 'random_tick_speed']);
  });

  it('1.21.10 的 camelCase 名单原样保留', () => {
    expect(parseGameruleRoster(ROSTER_LEGACY)).toEqual(ROSTER_LEGACY_NAMES);
  });

  // 包边界可能落在名字中间，也可能正好落在名字后的空格上；两种残片都必须是「不是规则」。
  // 判据只能靠后面的 `[<value>]`：残名本身是合法标识符（`projectiles_can_brea`），
  // 而查询它必回 Incorrect argument——放松后缀判据就会凭空多出一条「本版本不存在」的规则。
  it.each([
    ['截在名字中间', `${ROSTER_LEGACY}/gamerule minecraft:projectiles_can_brea`],
    ['截在名字后的空格上', `${ROSTER_LEGACY}/gamerule minecraft:projectiles_can_brea `],
    ['截在值占位符中间', `${ROSTER_LEGACY}/gamerule minecraft:pvp [<val`],
  ])('%s → 残片不算规则', (_label, truncated) => {
    expect(parseGameruleRoster(truncated)).toEqual(ROSTER_LEGACY_NAMES);
  });

  it.each([
    ['空回包', ''],
    ['无用法行', 'Unknown or incomplete command.'],
  ])('%s → 空名单', (_label, text) => {
    expect(parseGameruleRoster(text)).toEqual([]);
  });
});

describe('长回包按 4096 字节切包：必须拼接，不能只取第一包', () => {
  // 26.3 实测：help gamerule 总长 5082 字节 = 4096 + 986，两包同一 request id。
  // 夹具必须让「只在第二包里」的那条规则**起始于 4096 之后**：若它落在第一包内，
  // 只取第一包的实现照样能解出它，这条用例就成了假承重。
  const HEAD =
    ROSTER_LEGACY +
    '/gamerule water_source_conversion [<value>]'.padEnd(4096 - ROSTER_LEGACY.length, ' ');
  const TAIL_NAME = 'block_drops';
  const TAIL = `/gamerule ${TAIL_NAME} [<value>]`;
  const FULL_HELP = HEAD + TAIL;

  it('夹具自证：唯一条目确实整条落在 4096 之后（否则本组用例不承重）', () => {
    expect(Buffer.byteLength(HEAD, 'utf8')).toBe(4096);
    expect(FULL_HELP.indexOf(TAIL_NAME)).toBeGreaterThanOrEqual(4096);
    expect(FULL_HELP.slice(0, 4096)).not.toContain(TAIL_NAME);
  });

  it('两包拼接后拿到完整名单（只取第一包会少掉后一包里的名字）', async () => {
    const instance = makeInstance();
    instance._rconClient = makeFakeRcon((_cmd, id) => [
      responseFrame(id, FULL_HELP.slice(0, 4096)),
      responseFrame(id, FULL_HELP.slice(4096)),
    ]);

    const text = await instance._rconCommandCollect('help gamerule', 2000);

    expect(Buffer.byteLength(text, 'utf8')).toBe(Buffer.byteLength(FULL_HELP, 'utf8'));
    expect(parseGameruleRoster(text)).toContain(TAIL_NAME);
  });

  it('短包（< 4096）即收尾，不额外等满超时', async () => {
    const instance = makeInstance();
    instance._rconClient = makeFakeRcon((_cmd, id) => [responseFrame(id, 'short reply')]);

    const startedAt = Date.now();
    const text = await instance._rconCommandCollect('gamerule pvp', 5000);

    expect(text).toBe('short reply');
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('别的调用方的包（不同 request id）不混进本次响应', async () => {
    const instance = makeInstance();
    instance._rconClient = makeFakeRcon((_cmd, id) => [
      responseFrame(id + 1, 'other caller payload'),
      responseFrame(id, 'mine'),
    ]);

    await expect(instance._rconCommandCollect('gamerule pvp', 2000)).resolves.toBe('mine');
  });

  // 长度恰好是 4096 的回包没有短包可认，只能靠空闲兜底收尾：必须用已收到的内容 resolve，
  // 而不是等到整体超时抛错——抛错会让整份名单变成 source:'none'，比少几条更糟。
  it('满 4096 且无后续包 → 空闲兜底用已收内容收尾（不是超时失败）', async () => {
    const instance = makeInstance();
    const exact = 'x'.repeat(4096);
    instance._rconClient = makeFakeRcon((_cmd, id) => [responseFrame(id, exact)]);

    const startedAt = Date.now();
    const text = await instance._rconCommandCollect('help gamerule', 5000);
    const elapsed = Date.now() - startedAt;

    expect(text).toBe(exact);
    // 等的是空闲判据（300ms 量级），不是整体超时（5000ms）
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2000);
  });

  it('无响应 → 超时抛错（由调用方按通道不可用处理）', async () => {
    const instance = makeInstance();
    instance._rconClient = makeFakeRcon(() => null);

    await expect(instance._rconCommandCollect('help gamerule', 50)).rejects.toThrow(/timeout/i);
  });

  // 同一条 socket 上还有 rcon-client 自己的监听器（splitter 是 Transform，多个订阅者都收到）。
  // 我们的监听器只跳过不匹配的包、不从流里取走任何东西，故对方照收不误——吞包会让
  // 「面板其它命令」在规则页刷新时随机超时，这类故障极难归因。
  it('不吞别人的包：同一 socket 上的其他订阅者仍收到全部帧', async () => {
    const instance = makeInstance();
    const fake = makeFakeRcon((_cmd, id) => [responseFrame(id, 'for-us')]);
    instance._rconClient = fake;
    const seenByOther = [];
    fake.socket.on('data', (chunk) => seenByOther.push(chunk));

    await expect(instance._rconCommandCollect('gamerule pvp', 2000)).resolves.toBe('for-us');

    expect(seenByOther).toHaveLength(1);
    expect(seenByOther[0].subarray(12, seenByOther[0].length - 2).toString('utf8')).toBe('for-us');
  });

  // 同一连接上同时存在两条在途命令会让 MC 直接关连接（实测同一 write 写两包 → 立刻 end，
  // 一条响应都没有），而断的是实例共用的那条连接。故并发调用必须排队：写入时序上串行。
  it('并发两次收集：写入串行，同一时刻只有一个请求在途', async () => {
    const instance = makeInstance();
    const socket = new EventEmitter();
    const writes = [];
    socket.write = vi.fn((packet) => {
      writes.push(packet);
      // 第一条立刻回，第二条的写入发生在它之后（排队而非并发）
      setImmediate(() =>
        socket.emit('data', responseFrame(packet.readInt32LE(4), `reply-${writes.length}`)),
      );
    });
    instance._rconClient = { socket, send: vi.fn(), end: vi.fn() };

    const [first, second] = await Promise.all([
      instance._rconCommandCollect('help gamerule', 2000),
      instance._rconCommandCollect('help gamerule', 2000),
    ]);

    expect(writes).toHaveLength(2);
    // 两条请求包的 id 不同（各自的响应不会串台），且第二次写入在第一次结束之后
    expect(writes[0].readInt32LE(4)).not.toBe(writes[1].readInt32LE(4));
    expect(new Set([first, second])).toEqual(new Set(['reply-1', 'reply-2']));
  });

  // rcon-client 自己的命令也在同一条队列上：收集期间必须把它按暂停，否则下一个命令会在
  // 收集写包的同时出队写入 → 流水线 → MC 断连。
  it('收集期间暂停命令通道队列，结束后恢复（不把通道永久停摆）', async () => {
    const instance = makeInstance();
    const socket = new EventEmitter();
    socket.write = vi.fn((packet) =>
      setImmediate(() => socket.emit('data', responseFrame(packet.readInt32LE(4), 'ok'))),
    );
    const sendQueue = {
      pendingPromiseCount: 0,
      pause: vi.fn(function () {
        this.paused = true;
      }),
      resume: vi.fn(function () {
        this.paused = false;
      }),
    };
    instance._rconClient = { socket, sendQueue, authenticated: true, send: vi.fn(), end: vi.fn() };

    await expect(instance._rconCommandCollect('help gamerule', 2000)).resolves.toBe('ok');

    expect(sendQueue.pause).toHaveBeenCalled();
    expect(sendQueue.resume).toHaveBeenCalled();
    expect(sendQueue.paused).toBe(false);
  });

  // 队列里还有在途请求时写入就是流水线：必须等它落地再写，不能抢跑
  it('命令通道有在途请求时先等它落地再写自己的包', async () => {
    const instance = makeInstance();
    const socket = new EventEmitter();
    const order = [];
    socket.write = vi.fn((packet) =>
      setImmediate(() => socket.emit('data', responseFrame(packet.readInt32LE(4), 'ok'))),
    );
    const sendQueue = {
      pendingPromiseCount: 1,
      pause: vi.fn(),
      resume: vi.fn(),
    };
    instance._rconClient = { socket, sendQueue, authenticated: true, send: vi.fn(), end: vi.fn() };

    const collecting = instance._rconCommandCollect('help gamerule', 2000).then((v) => {
      order.push('collected');
      return v;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 在途请求未落地前，收集器不许写包
    expect(socket.write).not.toHaveBeenCalled();
    sendQueue.pendingPromiseCount = 0;

    await expect(collecting).resolves.toBe('ok');
    expect(socket.write).toHaveBeenCalledTimes(1);
  });

  // 通道卡住时不能无限等：宁可本次名单失败（转 none），也不继续占着队列拖住所有命令
  it('命令通道长时间不排空 → 本次收集失败，不无限等待', async () => {
    const instance = makeInstance();
    const socket = new EventEmitter();
    socket.write = vi.fn();
    const sendQueue = { pendingPromiseCount: 1, pause: vi.fn(), resume: vi.fn() };
    instance._rconClient = { socket, sendQueue, authenticated: true, send: vi.fn(), end: vi.fn() };

    await expect(instance._rconCommandCollect('help gamerule', 500)).rejects.toThrow(/busy/i);
    // 失败路径同样要恢复队列，否则一次卡住就把命令通道永久停摆
    expect(sendQueue.resume).toHaveBeenCalled();
  });

  it('连接不存在 → 抛错（不做静默空名单）', async () => {
    const instance = makeInstance();
    instance._rconClient = null;

    await expect(instance._fetchGameruleRoster()).rejects.toThrow('RCON connection unavailable');
  });
});

describe('MSMP 优先：一次拿全，不碰 RCON', () => {
  it('结构化数组 → source=msmp，前缀已剥，type/value 取自字段', async () => {
    const instance = makeInstance({
      _msmpRequest: vi.fn(async () => [
        { key: 'minecraft:pvp', type: 'boolean', value: true },
        { key: 'minecraft:random_tick_speed', type: 'integer', value: 3 },
      ]),
    });

    const snapshot = await instance._readGamerules();

    expect(snapshot.source).toBe('msmp');
    expect(snapshot.rules).toEqual([
      { name: 'pvp', status: 'current', type: 'boolean', value: 'true' },
      { name: 'random_tick_speed', status: 'current', type: 'integer', value: '3' },
    ]);
    expect(instance._msmpRequest).toHaveBeenCalledWith('minecraft:gamerules', []);
    expect(instance.sendCommandWithResponse).not.toHaveBeenCalled();
    expect(instance.sendCommand).not.toHaveBeenCalled();
  });

  it('契约外的 type 不猜控件类型：该条 unreadable，仍留在名单里', async () => {
    const instance = makeInstance({
      _msmpRequest: vi.fn(async () => [
        { key: 'minecraft:pvp', type: 'float', value: 1.5 },
        { key: 'minecraft:random_tick_speed', type: 'integer', value: 3 },
      ]),
    });

    const snapshot = await instance._readGamerules();

    expect(snapshot.source).toBe('msmp');
    expect(snapshot.rules[0]).toEqual({
      name: 'pvp',
      status: 'unreadable',
      type: null,
      value: null,
    });
  });

  it('MSMP 返回 null → 转 RCON（不重试，_msmpRequest 只调一次）', async () => {
    const instance = makeInstance({
      _rconClient: makeFakeRcon((cmd, id) => [
        responseFrame(id, cmd === 'help gamerule' ? ROSTER_LEGACY : REPLY_12111),
      ]),
      sendCommandWithResponse: vi.fn(async (cmd) =>
        cmd === 'help gamerule' ? ROSTER_LEGACY : REPLY_12111,
      ),
    });

    const snapshot = await instance._readGamerules();

    expect(instance._msmpRequest).toHaveBeenCalledTimes(1);
    expect(snapshot.source).toBe('rcon');
    expect(snapshot.rules.map((r) => r.name)).toEqual(ROSTER_LEGACY_NAMES);
  });
});

describe('RCON 兜底：逐条串行、单条失败只影响那一条', () => {
  /** 名单走真 RCON 收包路径，逐条读值仍是 sendCommandWithResponse（便于按命令造返回值） */
  function withRoster(replyFor, roster = ROSTER_LEGACY) {
    return makeInstance({
      _rconClient: makeFakeRcon((_cmd, id) => [responseFrame(id, roster)]),
      sendCommandWithResponse: vi.fn(replyFor),
    });
  }

  it('三态在同一次快照里并存：有值 / 本版本没有 / 读取失败', async () => {
    const instance = withRoster(async (cmd) => {
      if (cmd === 'gamerule randomTickSpeed') return REPLY_1219;
      if (cmd === 'gamerule pvp') return REPLY_12111;
      return REPLY_MISSING;
    });

    const snapshot = await instance._readGamerules();

    expect(snapshot.source).toBe('rcon');
    expect(snapshot.rules).toEqual([
      { name: 'randomTickSpeed', status: 'current', type: 'integer', value: '2147483647' },
      { name: 'pvp', status: 'current', type: 'integer', value: '3' },
      { name: 'doDaylightCycle', status: 'missing', type: null, value: null },
    ]);
  });

  it('单条抛错/超时 → unreadable，其余条目照常读到', async () => {
    const instance = withRoster(async (cmd) => {
      if (cmd === 'gamerule pvp') throw new Error('Command timeout');
      return 'Gamerule randomTickSpeed is currently set to: 3';
    });

    const snapshot = await instance._readGamerules();

    expect(snapshot.rules.map((r) => r.status)).toEqual(['current', 'unreadable', 'current']);
    expect(snapshot.rules[1]).toEqual({
      name: 'pvp',
      status: 'unreadable',
      type: null,
      value: null,
    });
  });

  it('串行执行：上一条未 settle 之前不发下一条', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const instance = withRoster(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return REPLY_12111;
    });

    await instance._readGamerules();

    expect(maxInFlight).toBe(1);
    // 名单 + 三条读值
    expect(instance.sendCommandWithResponse).toHaveBeenCalledTimes(3);
  });

  // 名单读空既不是「没有规则」也不是「通道不通」：通道是通的，只是这一问没答上来。
  // 归成 none 会让界面显示「两通道都不可用」，用户于是去查网络——那是假结论。
  it('名单读空（回包不认识）→ rosterFailed，source 仍是 rcon（通道是通的）', async () => {
    const instance = withRoster(async () => REPLY_12111, 'Unknown or incomplete command.');

    await expect(instance._readGamerules()).resolves.toEqual({
      source: 'rcon',
      rules: [],
      rosterFailed: true,
    });
    // 名单为空时不去逐条发命令
    expect(instance.sendCommandWithResponse).not.toHaveBeenCalled();
  });

  it('help 抛错/超时 → rosterFailed，不冒到路由层变 500、也不误报通道不可用', async () => {
    const instance = withRoster(async () => REPLY_12111);
    instance._rconCommandCollect = vi.fn(async () => {
      throw new Error('Command timeout');
    });

    await expect(instance._readGamerules()).resolves.toEqual({
      source: 'rcon',
      rules: [],
      rosterFailed: true,
    });
  });
});

describe('通道可用性判定', () => {
  it('未运行 → none，且两条通道都不碰', async () => {
    const instance = makeInstance({ isRunning: false, isRconConnected: true });

    await expect(instance._readGamerules()).resolves.toEqual({ source: 'none', rules: [] });
    expect(instance._msmpRequest).not.toHaveBeenCalled();
    expect(instance.sendCommandWithResponse).not.toHaveBeenCalled();
  });

  it('RCON 未连接且 MSMP 取不到 → none', async () => {
    const instance = makeInstance({ isRconConnected: false });

    await expect(instance._readGamerules()).resolves.toEqual({ source: 'none', rules: [] });
    expect(instance.sendCommandWithResponse).not.toHaveBeenCalled();
  });
});

describe('真实实例：读值不漏命令史、不写终端回声', () => {
  let tmpDir;
  let instance;
  let sendSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gamerule-reader-'));
    sendSpy = vi.fn(async (cmd) => {
      if (cmd === 'gamerule pvp') return REPLY_12111;
      return REPLY_MISSING;
    });
    instance = new MCServerInstance({
      id: 'gamerule-live',
      name: 'Gamerule Live',
      javaPath: 'java',
      jarFile: 'server.jar',
      maxMemory: '2G',
      minMemory: '1G',
      serverPath: tmpDir,
    });
    instance.isRunning = true;
    // isRconConnected 是读 server.properties 的 getter，用实例属性遮蔽模拟已连接
    Object.defineProperty(instance, 'isRconConnected', { value: true, configurable: true });
    instance.adopted = true;
    instance._msmpRequest = vi.fn(async () => null);
    // 名单走多包收包路径（同一连接上的独立请求 id），逐条读值走 sendCommandWithResponse
    const fake = makeFakeRcon((_cmd, id) => [responseFrame(id, ROSTER_LEGACY)]);
    fake.send = sendSpy;
    instance._rconClient = fake;
    instance._rconEnsureConnected = vi.fn(async () => {});
    // 包一层而不是替身：读值要真的跑过 sendCommandWithResponse（命令史/回声的判据就在它里面）
    const realSend = instance.sendCommandWithResponse.bind(instance);
    instance.sendCommandWithResponse = vi.fn(realSend);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('名单走 RCON 收包、逐条读值走 sendCommandWithResponse；命令史零写入、无终端回声', async () => {
    const logEvents = [];
    instance.on('log', (entry) => logEvents.push(entry));

    const snapshot = await instance._readGamerules();

    expect(snapshot.source).toBe('rcon');
    expect(snapshot.rules.map((r) => r.name)).toEqual(ROSTER_LEGACY_NAMES);
    expect(instance.sendCommandWithResponse.mock.calls.map((c) => c[0])).toEqual([
      'gamerule randomTickSpeed',
      'gamerule pvp',
      'gamerule doDaylightCycle',
    ]);
    // 命令史与终端回声都只属于 sendCommand；读值走 sendCommandWithResponse 两者都不产生
    expect(CommandHistoryModel.create).not.toHaveBeenCalled();
    expect(logEvents.filter((e) => e.type === 'command')).toEqual([]);
  });

  it('逐条读值用短超时（3000ms），一条卡住不拖住整份名单', async () => {
    await instance._readGamerules();

    for (const [, options] of instance.sendCommandWithResponse.mock.calls) {
      expect(options).toEqual({ timeout: 3000 });
    }
  });
});
