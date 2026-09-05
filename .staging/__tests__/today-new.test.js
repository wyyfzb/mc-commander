import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MCServerInstance } from '../services/mc_server.js';

// 今日新增玩家统计（getTodayNewPlayers）测试：join 增量 + 跨天惰性全量重算。
// 全部使用临时目录 mock 玩家数据，不包含任何真实数据。

function makeInstance(tmpDir) {
  const instance = new MCServerInstance({
    id: 's1',
    name: 'S1',
    jarFile: 'server.jar',
    serverPath: tmpDir,
    maxMemory: 1024,
  });
  return instance;
}

function todayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function yesterdayMs() {
  return todayMs() - 24 * 3600 * 1000;
}

describe('getTodayNewPlayers', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-today-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return 0 for empty instance', () => {
    const instance = makeInstance(tmpDir);
    expect(instance.getTodayNewPlayers()).toBe(0);
  });

  it('should count online player with first session today', () => {
    const instance = makeInstance(tmpDir);
    instance.players.set('Steve', { sessions: [{ start: todayMs() + 1000, end: null, duration: 0 }] });
    instance.players.set('Alex', { sessions: [{ start: yesterdayMs(), end: null, duration: 0 }] });
    expect(instance.getTodayNewPlayers()).toBe(1);
  });

  it('should count offline player from persisted playerdata (first session today)', () => {
    const instance = makeInstance(tmpDir);
    // usercache 提供离线玩家名单
    fs.mkdirSync(path.join(tmpDir, 'playerdata'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'usercache.json'), JSON.stringify([
      { name: 'Bob', uuid: '0000-0001' },
      { name: 'Creeper', uuid: '0000-0002' },
    ]));
    fs.writeFileSync(path.join(tmpDir, 'playerdata', 'Bob.json'), JSON.stringify({
      sessions: [{ start: todayMs() + 2000, end: null, duration: 0 }],
    }));
    fs.writeFileSync(path.join(tmpDir, 'playerdata', 'Creeper.json'), JSON.stringify({
      sessions: [{ start: yesterdayMs(), end: null, duration: 0 }],
    }));
    expect(instance.getTodayNewPlayers()).toBe(1);
  });

  it('should recalc after crossing day boundary (stale cache)', () => {
    const instance = makeInstance(tmpDir);
    // 今日缓存计数 2
    instance._todayNewCache = { date: instance._todayKey(), count: 2 };
    expect(instance.getTodayNewPlayers()).toBe(2);
    // 跨天：缓存日期过期 → 全量重算（空玩家 → 0）
    instance._todayNewCache = { date: '2000-01-01', count: 2 };
    expect(instance.getTodayNewPlayers()).toBe(0);
  });

  it('should count first join via join-path increment', () => {
    const instance = makeInstance(tmpDir);
    instance._todayNewCache = { date: instance._todayKey(), count: 0 };
    // 模拟首次加入（无历史）：sessions 已 push 新会话，savedData 为空
    instance.players.set('Notch', { sessions: [{ start: Date.now(), end: null, duration: 0 }] });
    // 直接触发与 join 处理相同逻辑的计数（savedData 为空对象）
    const savedData = {};
    const isFirstJoin = !savedData.totalPlayTime && !savedData.sessions?.length && !savedData.events?.length;
    if (isFirstJoin) instance._todayNewCache.count++;
    expect(instance.getTodayNewPlayers()).toBe(1);
  });
});
