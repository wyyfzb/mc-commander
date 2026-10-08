/**
 * 进程输出解析域模块行为级测试（issue 494 拆分交付）
 * - 模块直接 import 可用（与 mc_server.js 原型注入同源），注入后裸实例 this 绑定正确
 * - 真实 stdout 行样本驱动事件断言；聚焦宿主测试文件未覆盖面：
 *   TPS+MSPT+时间行 / 聊天·挑战·重生 / 天气·存档·ready / join→leave 落盘
 * 数据全部为虚构占位（Steve/1.2.3.4）
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'node:events';

// logger 经 utils/logger.js 读取 config，mock 指向临时目录避免触碰真实数据目录
vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-output-parser-test-'));
  return {
    default: {
      port: 0,
      serversDir: path.join(tmpRoot, 'servers'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      logLevel: 'info',
      rateLimit: { windowMs: 60000, max: 100 },
    },
  };
});

import {
  _parseOutput,
  _handlePlayerLeave,
  _addPlayerEvent,
} from '../services/mc-server/output-parser.js';
import { MCServerInstance } from '../services/mc_server.js';
import { shadowProfilePath } from '../utils/player-utils.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-output-parser-fixture-'));

function makeBareInstance() {
  // 裸原型实例：验证 Object.assign 挂载后的 this 绑定，不经 constructor 副作用；
  // EventEmitter.call 显式初始化事件系统（parseOutput 大量 emit）
  const inst = Object.create(MCServerInstance.prototype);
  EventEmitter.call(inst);
  inst.id = 'fixture';
  inst.serverPath = fs.mkdtempSync(path.join(tmpBase, 'inst-'));
  inst.players = new Map();
  inst.playerEvents = new Map();
  inst._pendingIps = new Map();
  inst._todayNewCache = null;
  inst._commandResponsePromises = new Map();
  inst._deathAggBuffer = [];
  inst._deathAggTimer = null;
  inst._sleepingPlayers = 0;
  inst.tps = 20;
  inst._mspt = 0;
  inst._weather = 'clear';
  inst._worldTime = null;
  inst._lastSaveTime = null;
  return inst;
}

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('输出解析域模块 require 复用语义', () => {
  it('3 个域方法经 Object.assign 注入 MCServerInstance 原型，实例调用 this 绑定正确', () => {
    const inst = makeBareInstance();
    expect(typeof inst._parseOutput).toBe('function');
    expect(typeof inst._handlePlayerLeave).toBe('function');
    expect(typeof inst._addPlayerEvent).toBe('function');
    inst._addPlayerEvent('Steve', 'join', '进入服务器');
    const events = inst.playerEvents.get('Steve');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('join');
    expect(events[0].message).toBe('进入服务器');
    expect(typeof events[0].timestamp).toBe('number');
    // 不在在线表的玩家离开：直接返回不抛错
    expect(() => inst._handlePlayerLeave('Nobody')).not.toThrow();
  });
});

describe('_parseOutput stdout 行解析（真实样本驱动）', () => {
  it('已删除的自造 mcsmp 协议行不再被特殊处理（当作普通日志行，不抛错、不产生副作用）', () => {
    const inst = makeBareInstance();
    expect(() => inst._parseOutput('[mcsmp_response:7] say hi\n[mcsmp_end:7]')).not.toThrow();
  });

  it('TPS/MSPT/时间日志行更新状态字段并广播 performanceUpdate', () => {
    const inst = makeBareInstance();
    const perf = [];
    inst.on('performanceUpdate', (e) => perf.push(e));
    inst._parseOutput('[12:00:00] [Server thread/INFO]: 19.5 TPS from the latest 3 ticks');
    inst._parseOutput('[12:00:00] [Server thread/INFO]: MSPT mean: 3.7');
    inst._parseOutput('[12:00:01] [Server thread/INFO]: Set the time to 13000');
    expect(inst.tps).toBe(19.5);
    expect(inst._mspt).toBe(3.7);
    expect(inst._worldTime).toBe(13000);
    expect(perf.length).toBeGreaterThanOrEqual(1);
    expect(perf[perf.length - 1].tps).toBe(19.5);
    // 备用 MSPT 格式同样生效
    inst._parseOutput('[12:00:02] [Server thread/INFO]: Average tick time: 6.5ms');
    expect(inst._mspt).toBe(6.5);
  });

  it('聊天/挑战/重生行触发 playerChat/achievement/playerRespawn 并记录玩家事件', () => {
    const inst = makeBareInstance();
    const chats = [];
    const achievements = [];
    const respawns = [];
    inst.on('playerChat', (e) => chats.push(e));
    inst.on('achievement', (e) => achievements.push(e));
    inst.on('playerRespawn', (e) => respawns.push(e));
    // 聊天两种形态均须识别：裸聊天行（部分服务端不打日志头）与带日志头的真实服务端输出
    inst._parseOutput('<Steve> hello world');
    inst._parseOutput('[12:00:00] [Server thread/INFO]: <Alex> hi there');
    inst._parseOutput('[12:00:00 INFO]: <Alex> paper format');
    inst._parseOutput(
      '[12:00:01] [Server thread/INFO]: Steve has completed the challenge [Sniper Duel]',
    );
    inst._parseOutput('[12:00:02] [Server thread/INFO]: Steve respawned');
    expect(chats).toEqual([
      { name: 'Steve', message: 'hello world' },
      { name: 'Alex', message: 'hi there' },
      { name: 'Alex', message: 'paper format' },
    ]);
    expect(achievements).toEqual([
      { name: 'Steve', advancement: 'Sniper Duel', isChallenge: true },
    ]);
    expect(respawns).toEqual([{ name: 'Steve' }]);
    const events = inst.playerEvents.get('Steve');
    expect(events.map((e) => e.type)).toEqual(['respawn', 'achievement']);
    expect(events[1].message).toBe('完成挑战: Sniper Duel');
    expect(events[0].message).toBe('已重生');
  });

  it('天气/存档/ready 日志行：weatherUpdate 与 status 事件及状态字段同步', () => {
    const inst = makeBareInstance();
    const weather = [];
    const status = [];
    inst.on('weatherUpdate', (e) => weather.push(e));
    inst.on('status', (e) => status.push(e));
    inst._parseOutput('[12:00:00] [Server thread/INFO]: Changing to rainy weather');
    expect(inst._weather).toBe('rain');
    inst._parseOutput('[12:00:01] [Server thread/INFO]: Set the weather to thunder');
    expect(inst._weather).toBe('thunder');
    inst._parseOutput('[12:00:02] [Server thread/INFO]: Saving the game');
    inst._parseOutput('[12:00:03] [Server thread/INFO]: Saved the game');
    inst._parseOutput('[12:00:04] [Server thread/INFO]: Done (2.345s)! For help, type "help"');
    expect(weather).toEqual([{ weather: 'rain' }, { weather: 'thunder' }]);
    expect(inst._lastSaveTime).toBeTruthy();
    // "Saving the game"（存档开始）不记录时刻，仅 "Saved the game"（完成）记录
    expect(status).toEqual([{ event: 'save' }, { event: 'ready' }]);
  });

  it('推送面在线时 `Saved the game` 不再发 save 事件：同一次保存只报一次，事实照记', () => {
    const inst = makeBareInstance();
    const status = [];
    inst.on('status', (e) => status.push(e));
    inst._msmpNotifConnected = true;

    inst._parseOutput('[12:00:03] [Server thread/INFO]: Saved the game');

    expect(status).toEqual([]);
    // 事实（上次保存时刻、体积缓存失效）不因事件让位而丢
    expect(inst._lastSaveTime).toBeTruthy();
    expect(inst._worldSizeDirty).toBe(true);

    // 推送掉线 → 立刻接回，名单与状态都不依赖推送
    inst._msmpNotifConnected = false;
    inst._parseOutput('[12:00:05] [Server thread/INFO]: Saved the game');
    expect(status).toEqual([{ event: 'save' }]);
  });

  it('就绪事件不因推送在线而让位：推送面在 Done 之后才开始守通道，让它就等于永远收不到', () => {
    const inst = makeBareInstance();
    const status = [];
    inst.on('status', (e) => status.push(e));
    inst._msmpNotifConnected = true;

    inst._parseOutput('[12:00:04] [Server thread/INFO]: Done (2.345s)! For help, type "help"');

    expect(status).toEqual([{ event: 'ready' }]);
  });

  it('join→leave 全链路：IP 缓存消费、今日新增计数、落盘与会话关闭、入睡计数递减', () => {
    const inst = makeBareInstance();
    const joins = [];
    const leaves = [];
    inst.on('playerJoin', (e) => joins.push(e));
    inst.on('playerLeave', (e) => leaves.push(e));
    // 登录行先于 join 行到达（IP 解析），缓存等待
    inst._parseOutput(
      '[12:00:00] [Server thread/INFO]: Steve[/1.2.3.4:51234] logged in with entity id 123',
    );
    expect(inst._pendingIps.get('Steve')).toBe('1.2.3.4');
    inst._parseOutput('[12:00:01] [Server thread/INFO]: Steve joined the game');
    expect(joins).toHaveLength(1);
    const player = inst.players.get('Steve');
    expect(player.ip).toBe('1.2.3.4');
    expect(player.totalPlayTime).toBe(0);
    expect(player.sessions).toHaveLength(1);
    expect(player.sessions[0].end).toBeNull();
    expect(inst._pendingIps.has('Steve')).toBe(false);
    // 无历史数据 = 首次加入，今日新增计数启动
    expect(inst._todayNewCache.count).toBe(1);
    // 预置 joinTime 10 秒前，验证离场时长累计
    player.joinTime = Date.now() - 10000;
    inst._sleepingPlayers = 2;
    inst._parseOutput('[12:00:05] [Server thread/INFO]: Steve left the game');
    expect(leaves).toEqual([{ name: 'Steve' }]);
    expect(inst.players.has('Steve')).toBe(false);
    expect(inst._sleepingPlayers).toBe(1);
    // 会话关闭 + 落盘：影子档案（键是 UUID）存在且携带累计时长
    const saved = JSON.parse(
      fs.readFileSync(
        shadowProfilePath({ serverPath: inst.serverPath, playerName: 'Steve' }),
        'utf-8',
      ),
    );
    expect(saved.totalPlayTime).toBe(10);
    expect(saved.sessions[0].end).not.toBeNull();
    expect(saved.events.some((e) => e.type === 'leave' && e.message === '离开服务器')).toBe(true);
  });
});
