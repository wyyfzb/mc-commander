/**
 * 「已知玩家」名单与 lastSeen 的来源正确性（任务 12）。
 *
 * 承重点两条：
 * ① `usercache.json` 的 `expiresOn` 是**缓存过期时刻**（条目创建 + 1 个月），不是最后在线。
 *    拿它当 lastSeen 会让界面显示一个看似权威、实为「缓存创建 + 1 个月」的时间。
 * ② MC 会按该时刻剪枝 usercache，只依赖它会让历史玩家从名单里**静默消失**；
 *    自有影子档案（按 UUID 落盘，玩家离开时写 lastSeen）必须能补足。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  const tmpRoot = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mc-known-'));
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

function makeInstance() {
  const inst = Object.create(MCServerInstance.prototype);
  inst.id = 'known';
  inst.serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-known-sp-'));
  inst.isRunning = true;
  inst.players = new Map();
  return inst;
}

function writeUsercache(inst, entries) {
  fs.writeFileSync(path.join(inst.serverPath, 'usercache.json'), JSON.stringify(entries));
}

function writeProfile(inst, uuid, { name, lastSeen = null }) {
  const dir = path.join(inst.serverPath, 'playerdata');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${uuid}.json`),
    JSON.stringify({ name, lastSeen, totalPlayTime: 10, sessions: [] }),
  );
}

describe('已知玩家名单的来源', () => {
  it('expiresOn 不得被当作 lastSeen（它是缓存过期时刻，与最后在线无关）', () => {
    const inst = makeInstance();
    writeUsercache(inst, [
      {
        name: 'Steve',
        uuid: '11111111-1111-3111-8111-111111111111',
        expiresOn: '2026-11-05 05:05:23 +0800',
      },
    ]);
    const known = inst.getAllKnownPlayers();
    expect(known.get('Steve').lastSeen).toBeNull();
  });

  it('自有档案的 lastSeen 才是最后在线（离开时写入）', () => {
    const inst = makeInstance();
    const uuid = '11111111-1111-3111-8111-111111111111';
    writeUsercache(inst, [{ name: 'Steve', uuid, expiresOn: '2026-11-05 05:05:23 +0800' }]);
    writeProfile(inst, uuid, { name: 'Steve', lastSeen: '2026-10-01T10:00:00.000Z' });
    expect(inst.getAllKnownPlayers().get('Steve').lastSeen).toBe('2026-10-01T10:00:00.000Z');
  });

  it('usercache 条目被剪枝后名单不缩水（自有档案补足）', () => {
    const inst = makeInstance();
    // usercache 已空（MC 剪掉了过期条目）
    writeUsercache(inst, []);
    writeProfile(inst, '22222222-2222-3222-8222-222222222222', {
      name: 'Alex',
      lastSeen: '2026-09-20T08:00:00.000Z',
    });
    const known = inst.getAllKnownPlayers();
    expect(known.has('Alex')).toBe(true);
    expect(known.get('Alex').uuid).toBe('22222222-2222-3222-8222-222222222222');
    expect(known.get('Alex').lastSeen).toBe('2026-09-20T08:00:00.000Z');
  });

  it('剪枝后仍保留 usercache 没有的权限标记来源（白名单/OP/封禁文件）', () => {
    const inst = makeInstance();
    writeUsercache(inst, []);
    fs.writeFileSync(
      path.join(inst.serverPath, 'ops.json'),
      JSON.stringify([{ name: 'Alex', uuid: 'x', level: 4 }]),
    );
    writeProfile(inst, '33333333-3333-3333-8333-333333333333', { name: 'Alex' });
    const known = inst.getAllKnownPlayers();
    expect(known.get('Alex').isOp).toBe(true);
    // 补足不得把已有标记覆盖掉
    expect(known.get('Alex').uuid).toBe('x');
  });

  it('档案损坏 / 缺 name → 跳过该条，不影响其余玩家', () => {
    const inst = makeInstance();
    writeUsercache(inst, []);
    const dir = path.join(inst.serverPath, 'playerdata');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'noname.json'), JSON.stringify({ lastSeen: 'x' }));
    writeProfile(inst, '44444444-4444-3444-8444-444444444444', { name: 'Steve' });
    const known = inst.getAllKnownPlayers();
    expect([...known.keys()]).toEqual(['Steve']);
  });

  it('无 playerdata 目录时不抛错（从未有玩家落盘）', () => {
    const inst = makeInstance();
    writeUsercache(inst, [{ name: 'Steve', uuid: 'u1', expiresOn: 'x' }]);
    expect(() => inst.getAllKnownPlayers()).not.toThrow();
    expect(inst.getAllKnownPlayers().size).toBe(1);
  });
});
