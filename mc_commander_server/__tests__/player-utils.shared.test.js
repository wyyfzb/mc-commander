import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { offlineUuid, getTotalPlayTime } from '../utils/player-utils.js';

// 全仓公共实现契约测试（players.js / mc_server.js 共用本模块）：
// - offlineUuid：MC 原版离线模式 UUID（MD5 v3）算法向量锁定
// - getTotalPlayTime：候选路径读取 + tick/20 换算 + offline uuid 兜底
//   （无 usercache 记录时 uuid 空串仍可读到时长）+ 路径穿越防御
// 测试数据均为虚构玩家名/目录，UUID 向量为算法数学计算结果。
describe('player-utils offlineUuid', () => {
  it('固定向量：test_player 的离线 UUID（MD5 v3 算法锁定）', () => {
    // 期望值 = MD5("OfflinePlayer:test_player") 按 MC 规范设置 v3/variant 位
    expect(offlineUuid('test_player')).toBe('1e54a02d-d0e4-377c-96f3-84c905106576');
  });

  it('结构：第三段以 3 开头（v3），第四段以 8/9/a/b 开头（RFC 4122 variant）', () => {
    const u = offlineUuid('some_fake_player');
    const parts = u.split('-');
    expect(parts).toHaveLength(5);
    expect(parts[2][0]).toBe('3');
    expect('89ab'.includes(parts[3][0])).toBe(true);
  });

  it('确定性：同一玩家名两次计算结果一致', () => {
    expect(offlineUuid('deterministic_player')).toBe(offlineUuid('deterministic_player'));
  });
});

describe('player-utils getTotalPlayTime', () => {
  let base;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-player-utils-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function writeStats(relDir, fileName, playTimeTick) {
    const dir = path.join(base, relDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify({
      stats: { 'minecraft:custom': { 'minecraft:play_time': playTimeTick } },
    }));
  }

  it('uuid 命中：MC 26.1+ 新格式 world/players/stats/<uuid>.json，tick/20 换算', () => {
    writeStats(path.join('world', 'players', 'stats'), 'u1.json', 400);
    expect(getTotalPlayTime({ serverPath: base, uuid: 'u1', playerName: 'Steve' })).toBe(20);
  });

  it('uuid 命中：旧格式 world/stats/<uuid>.json', () => {
    writeStats(path.join('world', 'stats'), 'u1.json', 800);
    expect(getTotalPlayTime({ serverPath: base, uuid: 'u1', playerName: 'Steve' })).toBe(40);
  });

  it('自定义世界目录（合法 level-name）正常读取', () => {
    writeStats(path.join('my_world', 'players', 'stats'), 'u1.json', 200);
    expect(getTotalPlayTime({
      serverPath: base, uuid: 'u1', playerName: 'Steve', levelName: 'my_world',
    })).toBe(10);
  });

  it('uuid 空串 + playerName → offline uuid 候选命中（无 usercache 兜底）', () => {
    const offline = offlineUuid('Steve');
    writeStats(path.join('world', 'players', 'stats'), `${offline}.json`, 600);
    expect(getTotalPlayTime({ serverPath: base, uuid: '', playerName: 'Steve' })).toBe(30);
  });

  it('uuid 空串且无 offline 文件 → 0（不抛错）', () => {
    expect(getTotalPlayTime({ serverPath: base, uuid: '', playerName: 'Steve' })).toBe(0);
  });

  it('uuid 候选优先于 offline 候选（两个文件都存在时取 uuid 文件值）', () => {
    const offline = offlineUuid('Steve');
    writeStats(path.join('world', 'players', 'stats'), 'u1.json', 400);
    writeStats(path.join('world', 'players', 'stats'), `${offline}.json`, 999999);
    expect(getTotalPlayTime({ serverPath: base, uuid: 'u1', playerName: 'Steve' })).toBe(20);
  });

  it('非法 level-name（../../evil）回退 world 读取（路径穿越防御）', () => {
    writeStats(path.join('world', 'players', 'stats'), 'u1.json', 400);
    expect(getTotalPlayTime({
      serverPath: base, uuid: 'u1', playerName: 'Steve', levelName: '../../evil',
    })).toBe(20);
  });

  it('level-name=.. 不读取上级目录文件（越界候选被过滤）', () => {
    // 在 base 上级放置「越界」统计文件，模拟恶意读取目标
    const evilPath = path.join(path.dirname(base), `${path.basename(base)}.evil.json`);
    fs.writeFileSync(evilPath, JSON.stringify({
      stats: { 'minecraft:custom': { 'minecraft:play_time': 999999 } },
    }));
    try {
      expect(getTotalPlayTime({
        serverPath: base, uuid: 'u1', playerName: 'Steve', levelName: '..',
      })).toBe(0);
    } finally {
      fs.rmSync(evilPath, { force: true });
    }
  });

  it('stats 文件 JSON 损坏 → 跳过返回 0（不抛错）', () => {
    const dir = path.join(base, 'world', 'players', 'stats');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'u1.json'), '{broken');
    expect(getTotalPlayTime({ serverPath: base, uuid: 'u1', playerName: 'Steve' })).toBe(0);
  });

  it('文件缺失 → 0', () => {
    expect(getTotalPlayTime({ serverPath: base, uuid: 'u1', playerName: 'Steve' })).toBe(0);
  });
});
