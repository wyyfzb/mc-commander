/**
 * 玩家名注入与路径越界的回归测试。
 *
 * 承重点：玩家名是不可信文本。它有两个危险用法——
 *  ① 事件解析：事件模式若在整个日志行内任意位置匹配，玩家在聊天框打出事件短语
 *     就会被当成真实事件（本文件用**实机抓到的原始日志行**作夹具）；
 *  ② 档案路径：名字被拼进路径，`../` 可越出 playerdata 写到服务端根下。
 * 两个方向都必须被钉住：只守一处则另一处照旧可利用。
 *
 * 夹具全部为实机逐字样本（MC 26.1，`logs/latest.log`）与虚构占位名。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  const tmpRoot = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mc-inject-test-'));
  return {
    default: {
      port: 0,
      serversDir: pathMod.join(tmpRoot, 'servers'),
      dataDir: pathMod.join(tmpRoot, 'data'),
      backupsDir: pathMod.join(tmpRoot, 'backups'),
      logLevel: 'error',
      rateLimit: { windowMs: 60000, max: 100 },
      autoStartDelayMs: 2000,
      crashLoop: { windowMs: 300000, maxCrashes: 5 },
    },
  };
});

import { MCServerInstance } from '../services/mc_server.js';
import {
  readShadowProfile,
  resolveShadowProfilePath,
  shadowProfilePath,
} from '../utils/player-utils.js';
import { logger } from '../utils/logger.js';

/** 实机原始日志行（逐字，仅把真实探针名换成本仓通用的虚构名） */
const REAL_JOIN = '[05:05:23] [Server thread/INFO]: Steve joined the game';
const REAL_LEAVE = '[19:12:52] [Server thread/INFO]: Steve left the game';
const REAL_LOGIN_IP =
  '[05:05:23] [Server thread/INFO]: Steve[/127.0.0.1:33482] logged in with entity id 86 at (783.5, 74.0, 742.5)';
const REAL_LOST = '[19:13:18] [Server thread/INFO]: Steve lost connection: Disconnected';
const REAL_DEATH = '[19:20:00] [Server thread/INFO]: Steve was slain by Zombie';
const REAL_ADV = '[19:21:00] [Server thread/INFO]: Steve has made the advancement [Diamonds!]';
const REAL_CHALLENGE =
  '[19:22:00] [Server thread/INFO]: Steve has completed the challenge [Monsters Hunted]';
const REAL_RESPAWN = '[19:23:00] [Server thread/INFO]: Steve respawned';
const REAL_CHAT_INJECT =
  '[05:05:25] [Server thread/INFO]: [Not Secure] <Alex> ../instance joined the game';

function makeInstance(name = 'inst') {
  const inst = Object.create(MCServerInstance.prototype);
  inst.id = name;
  inst.serverPath = fs.mkdtempSync(path.join(os.tmpdir(), `mc-inject-${name}-`));
  inst.isRunning = true;
  inst.players = new Map();
  inst.playerEvents = new Map();
  inst._pendingIps = new Map();
  inst._todayNewCache = null;
  inst._sleepingPlayers = 0;
  inst._deathAggBuffer = [];
  inst._msmpAvailable = false;
  inst._worldSizeDirty = false;
  inst.properties = {};
  inst.emit = () => {};
  inst._todayKey = () => '2026-10-05';
  return inst;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('事件解析只认消息体行首（聊天不可伪造事件）', () => {
  it.each([
    ['加入', REAL_JOIN, (i) => i.players.has('Steve')],
    ['登录 IP', REAL_LOGIN_IP, (i) => i._pendingIps.get('Steve') === '127.0.0.1'],
    // 离开/掉线断言「已从在线表移除」而不是「有事件」——后者会被前置的加入用例
    // 顺手满足，变成不承重的空断言（变异探针抓到过一次）
    ['离开', REAL_LEAVE, (i) => !i.players.has('Steve')],
    ['掉线', REAL_LOST, (i) => !i.players.has('Steve')],
  ])('真实形态仍能解析：%s', (_label, line, check) => {
    const inst = makeInstance('real');
    if (!line.includes('joined the game') && !line.includes('logged in')) {
      inst._parseOutput(REAL_JOIN);
    }
    inst._parseOutput(line);
    expect(check(inst)).toBe(true);
  });

  it.each([
    ['死亡', REAL_DEATH],
    ['成就', REAL_ADV],
    ['挑战', REAL_CHALLENGE],
    ['重生', REAL_RESPAWN],
  ])('真实形态仍能解析（事件数净增一条）：%s', (_label, line) => {
    const inst = makeInstance('real-evt');
    inst._parseOutput(REAL_JOIN);
    const before = (inst.playerEvents.get('Steve') || []).length;
    inst._parseOutput(line);
    expect((inst.playerEvents.get('Steve') || []).length).toBe(before + 1);
  });

  it('聊天里打出 join 短语 → 不注册任何玩家（实机抓到的原文）', () => {
    const inst = makeInstance('inject-join');
    inst._parseOutput(REAL_CHAT_INJECT);
    expect([...inst.players.keys()]).toEqual([]);
    // 没有玩家 ⇒ 没有任何落盘路径被触发（playerdata 目录都不该被创建）
    expect(fs.existsSync(path.join(inst.serverPath, 'playerdata'))).toBe(false);
  });

  it('聊天里打出 join 短语 → 不缓存伪造 IP、不产生事件', () => {
    const inst = makeInstance('inject-all');
    inst._parseOutput(
      '[05:05:26] [Server thread/INFO]: [Not Secure] <Alex> 1.2.3.4[/1.2.3.4:1] logged in with entity id 1',
    );
    inst._parseOutput(
      '[05:05:27] [Server thread/INFO]: [Not Secure] <Alex> NotARealPlayer joined the game',
    );
    inst._parseOutput(
      '[05:05:28] [Server thread/INFO]: [Not Secure] <Alex> NotARealPlayer left the game',
    );
    inst._parseOutput(
      '[05:05:29] [Server thread/INFO]: [Not Secure] <Alex> NotARealPlayer was slain by Zombie',
    );
    inst._parseOutput(
      '[05:05:30] [Server thread/INFO]: [Not Secure] <Alex> NotARealPlayer has made the advancement [X]',
    );
    inst._parseOutput(
      '[05:05:30] [Server thread/INFO]: [Not Secure] <Alex> NotARealPlayer has completed the challenge [Y]',
    );
    inst._parseOutput(
      '[05:05:30] [Server thread/INFO]: [Not Secure] <Alex> NotARealPlayer respawned',
    );
    expect(inst.players.size).toBe(0);
    expect(inst._pendingIps.size).toBe(0);
    expect(inst.playerEvents.size).toBe(0);
  });

  it('聊天里伪造他人的离开 → 该玩家仍在线（不能借聊天把真人踢出在线表）', () => {
    const inst = makeInstance('inject-leave');
    inst._parseOutput(REAL_JOIN);
    expect(inst.players.has('Steve')).toBe(true);
    inst._parseOutput('[05:05:35] [Server thread/INFO]: [Not Secure] <Alex> Steve left the game');
    inst._parseOutput(
      '[05:05:36] [Server thread/INFO]: [Not Secure] <Alex> Steve lost connection: Disconnected',
    );
    expect(inst.players.has('Steve')).toBe(true);
  });

  it('聊天里伪造他人的死亡/成就 → 不为该玩家记账', () => {
    const inst = makeInstance('inject-other');
    inst._parseOutput(REAL_JOIN);
    const before = (inst.playerEvents.get('Steve') || []).length;
    inst._parseOutput(
      '[05:05:37] [Server thread/INFO]: [Not Secure] <Alex> Steve was slain by Zombie',
    );
    inst._parseOutput(
      '[05:05:38] [Server thread/INFO]: [Not Secure] <Alex> Steve has made the advancement [X]',
    );
    inst._parseOutput(
      '[05:05:39] [Server thread/INFO]: [Not Secure] <Alex> Steve has completed the challenge [Y]',
    );
    inst._parseOutput('[05:05:40] [Server thread/INFO]: [Not Secure] <Alex> Steve respawned');
    expect((inst.playerEvents.get('Steve') || []).length).toBe(before);
  });

  it('/me 表情同样不可伪造（消息体不以名字起始）', () => {
    const inst = makeInstance('inject-me');
    inst._parseOutput('[05:05:31] [Server thread/INFO]: * Alex ../instance joined the game');
    expect(inst.players.size).toBe(0);
  });

  it('已签名聊天（无 [Not Secure] 前缀）同样不可伪造', () => {
    const inst = makeInstance('inject-signed');
    inst._parseOutput('[05:05:32] [Server thread/INFO]: <Alex> Fake joined the game');
    expect(inst.players.size).toBe(0);
  });

  it('聊天解析本身不受影响（前缀剥离后仍锚定提取）', () => {
    const inst = makeInstance('chat-still-works');
    const chats = [];
    inst.emit = (event, payload) => {
      if (event === 'playerChat') chats.push(payload);
    };
    inst._parseOutput('[05:05:33] [Server thread/INFO]: [Not Secure] <Alex> 大家好');
    inst._parseOutput('[05:05:34] [Server thread/INFO]: <Alex> hello');
    expect(chats).toEqual([
      { name: 'Alex', message: '大家好' },
      { name: 'Alex', message: 'hello' },
    ]);
  });
});

describe('档案路径越界（写侧与读侧同守）', () => {
  const ESCAPES = ['../instance', '../../etc/passwd', 'a/b', '/abs'];

  it.each(ESCAPES)('写侧拒绝越界名：%s', (evil) => {
    const inst = makeInstance('sink-write');
    const victim = path.join(inst.serverPath, 'instance.json');
    fs.writeFileSync(victim, 'ORIGINAL');
    // 直接调被测落点：事件解析已不可伪造，落点仍须自证（名字来源会继续增加）
    inst._savePlayerData(evil, { name: evil, totalPlayTime: 1, sessions: [] });
    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
  });

  it.each(ESCAPES)('读侧拒绝越界名：%s', (evil) => {
    const inst = makeInstance('sink-read');
    const victim = path.join(inst.serverPath, 'instance.json');
    fs.writeFileSync(victim, JSON.stringify({ secret: 'panel-metadata' }));
    expect(inst._loadPlayerData(evil)).toBeNull();
  });

  // 落点守卫在「名字」这一侧其实**不可达**：影子档案的键取 UUID（usercache → 离线算法派生），
  // 名字永远不成为文件名。它能被触发的唯一场景是 **usercache 被篡改**（它的注释写的就是这个），
  // 而这一段此前没有用例 ⇒ 删掉守卫不会有任何用例变红。以下三条把那条路径钉住。
  it('共享入口：实例与路由共用同一处校验（篡改 usercache ⇒ null + 告警；正常名仍可用）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-inject-shared-'));
    fs.writeFileSync(
      path.join(dir, 'usercache.json'),
      JSON.stringify([{ name: 'Evil', uuid: '../escaped' }]),
    );
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    expect(resolveShadowProfilePath({ serverPath: dir, playerName: 'Evil' })).toBeNull();
    expect(readShadowProfile({ serverPath: dir, playerName: 'Evil' })).toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('拒绝越界影子档案路径'))).toBe(true);

    // 同一个入口对正常名字照常给出 playerdata/ 下的路径（收敛校验不等于收紧语义）
    const ok = resolveShadowProfilePath({ serverPath: dir, playerName: 'Steve' });
    expect(ok.startsWith(path.join(dir, 'playerdata') + path.sep)).toBe(true);
  });

  it('usercache 被篡改成越界 UUID 时，写侧拒绝且不落盘到根下', () => {
    const inst = makeInstance('tamper-write');
    fs.writeFileSync(
      path.join(inst.serverPath, 'usercache.json'),
      JSON.stringify([{ name: 'Evil', uuid: '../escaped' }]),
    );
    const escaped = path.join(inst.serverPath, 'escaped.json');
    inst._savePlayerData('Evil', { name: 'Evil', totalPlayTime: 1, sessions: [] });
    expect(fs.existsSync(escaped)).toBe(false);
    // 也不该在 playerdata/ 之外留下任何新文件
    const entries = fs
      .readdirSync(inst.serverPath)
      .filter((f) => f !== 'usercache.json' && f !== 'playerdata');
    expect(entries).toEqual([]);
  });

  it('usercache 被篡改成越界 UUID 时，读侧拒绝并留告警', () => {
    const inst = makeInstance('tamper-read');
    fs.writeFileSync(
      path.join(inst.serverPath, 'usercache.json'),
      JSON.stringify([{ name: 'Evil', uuid: '../escaped' }]),
    );
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    expect(inst._loadPlayerData('Evil')).toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('拒绝越界影子档案路径'))).toBe(true);
  });

  it('正常名字照常读写（不算误伤）', () => {
    const inst = makeInstance('sink-ok');
    inst._savePlayerData('Steve', { name: 'Steve', totalPlayTime: 7, sessions: [] });
    expect(inst._loadPlayerData('Steve').totalPlayTime).toBe(7);
  });

  it('带空格/中文/Floodgate 前缀的名字照常读写（安全谓词不是正版合法性谓词）', () => {
    const inst = makeInstance('sink-mods');
    for (const name of ['Shop Keeper', '玩家甲', '.BedrockPlayer']) {
      inst._savePlayerData(name, { name, totalPlayTime: 3, sessions: [] });
      expect(inst._loadPlayerData(name), name).not.toBeNull();
      expect(inst._loadPlayerData(name).totalPlayTime, name).toBe(3);
    }
  });
});

describe('影子档案按 UUID 落盘（改名不断链）', () => {
  it('正版模式下改名后仍读到同一份档案（usercache 给了稳定 UUID）', () => {
    const inst = makeInstance('rename');
    // Mojang UUID 与名字无关：同一个玩家先后用两个名字出现
    fs.writeFileSync(
      path.join(inst.serverPath, 'usercache.json'),
      JSON.stringify([
        { name: 'OldName', uuid: '853c80ef-3c37-49fd-aa49-938b674adae6' },
        { name: 'NewName', uuid: '853c80ef-3c37-49fd-aa49-938b674adae6' },
      ]),
    );
    inst._savePlayerData('OldName', { name: 'OldName', totalPlayTime: 4242, sessions: [] });

    const after = inst._loadPlayerData('NewName');
    expect(after).not.toBeNull();
    expect(after.totalPlayTime).toBe(4242);
  });

  it('落盘文件名是 UUID 而不是玩家名（与官方 playerdata 同键）', () => {
    const inst = makeInstance('uuidfile');
    inst._savePlayerData('Steve', { name: 'Steve', totalPlayTime: 1, sessions: [] });
    const files = fs.readdirSync(path.join(inst.serverPath, 'playerdata'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}\.json$/);
    // 用名字命名的旧版式不再产生
    expect(files).not.toContain('Steve.json');
  });

  it('无 usercache（Carpet 假人/被剪枝）→ 用离线算法派生的 UUID 兜底', () => {
    const inst = makeInstance('offlinekey');
    inst._savePlayerData('FakeBot', { name: 'FakeBot', totalPlayTime: 9, sessions: [] });
    expect(
      fs.existsSync(shadowProfilePath({ serverPath: inst.serverPath, playerName: 'FakeBot' })),
    ).toBe(true);
  });

  it('usercache 里的 UUID 被篡改成路径分量 → 仍不得越界（UUID 化不能替代落点断言）', () => {
    const inst = makeInstance('tampered');
    const victim = path.join(inst.serverPath, 'instance.json');
    fs.writeFileSync(victim, 'ORIGINAL');
    fs.writeFileSync(
      path.join(inst.serverPath, 'usercache.json'),
      JSON.stringify([{ name: 'Steve', uuid: '../instance' }]),
    );
    inst._savePlayerData('Steve', { name: 'Steve', totalPlayTime: 1, sessions: [] });
    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(inst._loadPlayerData('Steve')).toBeNull();
  });
});
