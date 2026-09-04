import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock 隔离：子进程 / RCON / SQLite 模型（config 用真实值）──
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

vi.mock('../db/index.js', () => ({
  InstanceModel: {
    getAll: vi.fn(() => []),
    getById: vi.fn(() => null),
    migrateFromJson: vi.fn(),
    addUptime: vi.fn(),
    update: vi.fn(),
    getTotalUptime: vi.fn(() => 0),
  },
  CommandHistoryModel: { create: vi.fn() },
}));

import { MCServerInstance } from '../services/mc_server.js';

describe('MCServerInstance - getPlayerDetails RCON 链路与异常降级', () => {
  let tmpDir;
  let instance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-detail-'));
    instance = new MCServerInstance({
      id: 'detail-test',
      name: 'Detail Test',
      javaPath: 'java',
      jarFile: 'server.jar',
      maxMemory: '2G',
      minMemory: '1G',
      serverPath: tmpDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // 按 data get / attribute 命令分发 RCON 响应
  function mockRconData(instance, overrides = {}) {
    instance.isRunning = true;
    // isRconConnected 是读 server.properties 的 getter：用实例属性遮蔽模拟连接态
    Object.defineProperty(instance, 'isRconConnected', { value: true, configurable: true });
    const defaultData = {
      Pos: '[100.5d, 64.0d, -50.25d]',
      Health: '18.5f',
      foodLevel: '17',
      XpLevel: '42',
      playerGameType: '1',
      Dimension: 'minecraft:the_nether',
      'respawn.pos': '[I; 100, 64, -50]',
      SpawnX: null,
      SpawnY: null,
      SpawnZ: null,
      ...overrides,
    };
    return vi.spyOn(instance, 'sendCommandWithResponse').mockImplementation(async (cmd) => {
      // attribute 查询（旧版 generic.* 失败 → 新版命中）
      if (cmd.startsWith('attribute ')) {
        if (cmd.includes('generic.')) return null;
        if (cmd.includes('max_health')) return 'Base value of attribute minecraft:max_health is 20.0';
        if (cmd.includes('armor')) return 'Total value of attribute minecraft:armor is 8.5';
        return null;
      }
      if (cmd.includes('Inventory')) return 'Steve has the following entity data: []';
      if (cmd.includes('EnderItems')) return 'Steve has the following entity data: []';
      for (const [key, val] of Object.entries(defaultData)) {
        if (cmd.endsWith(` ${key}`)) {
          return val == null ? null : `Steve has the following entity data: ${val}`;
        }
      }
      return null;
    });
  }

  it('服务器未运行：返回基本详情，health/position 等字段为 null', async () => {
    instance.isRunning = false;
    const d = await instance.getPlayerDetails('Steve');
    expect(d.name).toBe('Steve');
    expect(d.isOnline).toBe(false);
    expect(d.health).toBeNull();
    expect(d.position).toBeNull();
    expect(d.gameMode).toBeNull();
    expect(d.inventory).toBeNull();
    expect(d.events).toEqual([]);
    expect(d.sessions).toEqual([]);
    expect(d.totalPlayTime).toBe(0);
  });

  it('世界出生点缓存传播到详情（离线可用）', async () => {
    instance.isRunning = false;
    instance._worldSpawn = { x: 8, y: 70, z: -12 };
    const d = await instance.getPlayerDetails('Steve');
    expect(d.spawnPoint).toEqual({ x: 8, y: 70, z: -12 });
  });

  it('服务器运行但 RCON 未连接：直接返回基本详情不触发 RCON', async () => {
    instance.isRunning = true; // 无 server.properties，getter 判定 RCON 未连接
    const spy = vi.spyOn(instance, 'sendCommandWithResponse');
    const d = await instance.getPlayerDetails('Steve');
    expect(d.isOnline).toBe(false);
    expect(d.health).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('RCON 全部命令失败（reject 被吞）：字段保持 null 正常返回', async () => {
    instance.isRunning = true;
    Object.defineProperty(instance, 'isRconConnected', { value: true, configurable: true });
    vi.spyOn(instance, 'sendCommandWithResponse').mockRejectedValue(new Error('ECONNREFUSED'));
    const d = await instance.getPlayerDetails('Steve');
    expect(d.health).toBeNull();
    expect(d.position).toBeNull();
    expect(d.maxHealth).toBe(20); // attribute 查询失败回退默认 20
    expect(d.inventory).toBeNull();
  });

  it('attribute 查询链异常（reject）降级：外层 catch 返回已采集详情', async () => {
    mockRconData(instance);
    // maxHealth 属性查询抛出未捕获异常 → 外层 catch → 降级返回
    const orig = instance.sendCommandWithResponse.getMockImplementation();
    vi.spyOn(instance, 'sendCommandWithResponse').mockImplementation(async (cmd) => {
      if (cmd.startsWith('attribute ') && cmd.includes('max_health')) {
        throw new Error('rcon stream broken');
      }
      return orig(cmd);
    });
    const d = await instance.getPlayerDetails('Steve');
    // catch 降级：仍返回已装配的基础详情对象
    expect(d.name).toBe('Steve');
    expect(d.isOnline).toBe(false);
  });

  it('RCON 成功：全字段解析（坐标/血量/饥饿/等级/模式/维度/复活点）', async () => {
    mockRconData(instance);
    instance.players.set('Steve', { joinTime: Date.now() - 60000 });
    const d = await instance.getPlayerDetails('Steve');
    expect(d.isOnline).toBe(true);
    expect(d.position).toEqual({ x: 100.5, y: 64, z: -50.25 });
    expect(d.health).toBe(18.5);
    expect(d.maxHealth).toBe(20);
    expect(d.armor).toBe(8.5);
    expect(d.hunger).toBe(17);
    expect(d.xpLevel).toBe(42);
    expect(d.gameMode).toBe('creative');
    expect(d.dimension).toBe('nether');
    expect(d.respawnPoint).toEqual({ x: 100, y: 64, z: -50 });
  });

  it('维度判定：the_end 与 overworld 分支', async () => {
    mockRconData(instance, { Dimension: 'minecraft:the_end' });
    expect((await instance.getPlayerDetails('Steve')).dimension).toBe('end');

    mockRconData(instance, { Dimension: 'minecraft:overworld' });
    expect((await instance.getPlayerDetails('Steve')).dimension).toBe('overworld');
  });

  it('非 data get 成功输出（错误文本）不被误解析', async () => {
    mockRconData(instance, {
      Pos: 'No entity was found',
      Health: 'No entity was found',
      playerGameType: 'No entity was found',
    });
    const d = await instance.getPlayerDetails('Steve');
    expect(d.position).toBeNull();
    expect(d.health).toBeNull();
    expect(d.gameMode).toBeNull();
  });

  it('gameMode 越界值回退 survival', async () => {
    mockRconData(instance, { playerGameType: '9' });
    expect((await instance.getPlayerDetails('Steve')).gameMode).toBe('survival');
  });

  it('复活点旧版兜底：respawn.pos 无效时读 SpawnX/Y/Z', async () => {
    mockRconData(instance, {
      'respawn.pos': 'No entity was found',
      SpawnX: '120',
      SpawnY: '71',
      SpawnZ: '-88',
    });
    expect((await instance.getPlayerDetails('Steve')).respawnPoint)
      .toEqual({ x: 120, y: 71, z: -88 });
  });

  it('respawn.pos 新旧格式坐标均解析（[I; x,y,z] 与 [x,y,z]）', async () => {
    mockRconData(instance, { 'respawn.pos': '[100, 64, -50]' });
    expect((await instance.getPlayerDetails('Steve')).respawnPoint)
      .toEqual({ x: 100, y: 64, z: -50 });

    mockRconData(instance, { 'respawn.pos': '[100.0d, 64.0d, -50.0d]' });
    expect((await instance.getPlayerDetails('Steve')).respawnPoint)
      .toEqual({ x: 100, y: 64, z: -50 });
  });

  it('在线 RCON 实时物品栏现状行为：_extractNbtFromResponse 从 { 截取丢失外层 [，列表解析为空 → 降级保留 dat 快照（行为锁定，与 _loadInventoryFromRcon 直测一致）', async () => {
    mockRconData(instance, {
      Inventory: '[{id:"minecraft:diamond_sword",Count:1b,Slot:0b,Enchantments:[{id:"minecraft:sharpness"}]}]',
    });
    const d = await instance.getPlayerDetails('Steve');
    // 现状：实时查询降级返回 null，inventory 不被覆盖（无 dat 快照文件时保持 null）
    expect(d.inventory).toBeNull();
    expect(d.health).toBe(18.5); // 其余字段正常采集
  });

  it('在线 RCON 物品栏截断：保留 dat 快照不覆盖', async () => {
    // 预置 dat 快照
    const datDir = path.join(tmpDir, 'world', 'playerdata');
    fs.mkdirSync(datDir, { recursive: true });
    fs.writeFileSync(path.join(datDir, 'unknown-uuid.dat'), 'placeholder');
    mockRconData(instance, { Inventory: '[{id:"minecraft:diamond",Co' });
    const d = await instance.getPlayerDetails('Steve');
    // 截断降级后 inventory 仍为 null（无有效快照文件），但请求不失败
    expect(d.inventory).toBeNull();
    expect(d.health).toBe(18.5); // 其余字段正常
  });
});
