import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { writeUncompressed } from 'prismarine-nbt';

// ── Mock 隔离：子进程 / RCON / SQLite 模型（config 用真实值，不触 serversDir）──
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

// 构造 gzip 压缩的 NBT 存档文件（与 mc_server.test.js 同范式）
function writeNbtFile(filePath, nbtData) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, zlib.gzipSync(writeUncompressed(nbtData)));
}

describe('MCServerInstance - 物品栏解析域（NBT/SNBT/装配）', () => {
  let tmpDir;
  let instance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-inv-'));
    instance = new MCServerInstance({
      id: 'inv-test',
      name: 'Inventory Test',
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

  describe('_extractTextName', () => {
    it('空值返回 null', () => {
      expect(instance._extractTextName(null)).toBeNull();
      expect(instance._extractTextName(undefined)).toBeNull();
      expect(instance._extractTextName('')).toBeNull();
    });

    it('纯字符串（非 JSON）原样返回', () => {
      expect(instance._extractTextName('diamond_sword')).toBe('diamond_sword');
    });

    it('JSON 字符串解包后返回', () => {
      expect(instance._extractTextName('"锋利之剑"')).toBe('锋利之剑');
    });

    it('{"text":...} 提取 text 字段', () => {
      expect(instance._extractTextName('{"text":"附魔钻石剑"}')).toBe('附魔钻石剑');
    });

    it('{"extra":[{text}]} 无 text 时取 extra[0].text', () => {
      expect(instance._extractTextName('{"extra":[{"text":"保护 III"}]}')).toBe('保护 III');
    });

    it('无 text/extra 的 JSON 对象回退原字符串', () => {
      expect(instance._extractTextName('{"foo":1}')).toBe('{"foo":1}');
    });

    it('非法 JSON 回退原字符串', () => {
      expect(instance._extractTextName('{broken json')).toBe('{broken json');
    });
  });

  describe('_parseNbtItem', () => {
    it('null 输入返回 null', () => {
      expect(instance._parseNbtItem(null)).toBeNull();
      expect(instance._parseNbtItem(undefined)).toBeNull();
    });

    it('value 包装结构：剥离 minecraft: 前缀并解析 Count/Slot', () => {
      const item = instance._parseNbtItem({
        value: {
          id: { value: 'minecraft:diamond' },
          Count: { value: 3 },
          Slot: { value: 5 },
        },
      });
      expect(item).toEqual({
        id: 'diamond',
        count: 3,
        slot: 5,
        durability: null,
        enchanted: false,
        customName: null,
      });
    });

    it('无包装结构（list 元素直传）同样解析', () => {
      const item = instance._parseNbtItem({
        id: { value: 'minecraft:stone' },
        count: { value: 1 },
        slot: { value: 3 },
      });
      expect(item.id).toBe('stone');
      expect(item.count).toBe(1);
      expect(item.slot).toBe(3);
    });

    it('id 缺失返回 null', () => {
      expect(instance._parseNbtItem({ value: { Count: { value: 1 } } })).toBeNull();
    });

    it('air 物品现状行为：前缀剥离后不命中 minecraft:air 字面比较（行为锁定，SNBT 侧正常过滤）', () => {
      const r = instance._parseNbtItem({ value: { id: { value: 'minecraft:air' } } });
      expect(r.id).toBe('air');
    });

    it('count/slot 缺省回退 1/0', () => {
      const item = instance._parseNbtItem({ value: { id: { value: 'minecraft:apple' } } });
      expect(item.count).toBe(1);
      expect(item.slot).toBe(0);
    });

    it('旧版附魔 tag.Enchantments 检测', () => {
      const item = instance._parseNbtItem({
        value: {
          id: { value: 'minecraft:diamond_sword' },
          tag: { value: { Enchantments: { value: [{ id: { value: 'minecraft:sharpness' } }] } } },
        },
      });
      expect(item.enchanted).toBe(true);
    });

    it('新版组件 minecraft:enchantments 检测', () => {
      const item = instance._parseNbtItem({
        value: {
          id: { value: 'minecraft:bow' },
          components: { value: { 'minecraft:enchantments': { value: {} } } },
        },
      });
      expect(item.enchanted).toBe(true);
    });

    it('新版组件 minecraft:stored_enchantments 检测', () => {
      const item = instance._parseNbtItem({
        value: {
          id: { value: 'minecraft:enchanted_book' },
          components: { value: { 'minecraft:stored_enchantments': { value: {} } } },
        },
      });
      expect(item.enchanted).toBe(true);
    });

    it('旧版 tag.display.Name 提取自定义名称', () => {
      const item = instance._parseNbtItem({
        value: {
          id: { value: 'minecraft:diamond_sword' },
          tag: { value: { display: { value: { Name: { value: '{"text":"屠龙宝刀"}' } } } } },
        },
      });
      expect(item.customName).toBe('屠龙宝刀');
    });

    it('新版组件 minecraft:custom_name 提取自定义名称', () => {
      const item = instance._parseNbtItem({
        value: {
          id: { value: 'minecraft:stick' },
          components: { value: { 'minecraft:custom_name': { value: '{"text":"教鞭"}' } } },
        },
      });
      expect(item.customName).toBe('教鞭');
    });
  });

  describe('_buildInventoryResult', () => {
    const mk = (slot, extra = {}) => ({ id: 'diamond', count: 1, slot, ...extra });

    it('slot 0-8 分配到快捷栏', () => {
      const r = instance._buildInventoryResult([mk(0), mk(8)], [], 'realtime');
      expect(r.quickbar[0]).toEqual({ id: 'diamond', count: 1 });
      expect(r.quickbar[8]).toEqual({ id: 'diamond', count: 1 });
      expect(r.quickbar[4]).toBeNull();
    });

    it('slot 9-35 分配到主背包（偏移 -9）', () => {
      const r = instance._buildInventoryResult([mk(9), mk(35)], [], 'snapshot');
      expect(r.main[0]).toEqual({ id: 'diamond', count: 1 });
      expect(r.main[26]).toEqual({ id: 'diamond', count: 1 });
    });

    it('装备槽 103/102/101/100 映射盔甲位', () => {
      const r = instance._buildInventoryResult(
        [mk(103), mk(102), mk(101), mk(100)],
        [],
        'snapshot',
      );
      expect(r.equipment.helmet).toEqual({ id: 'diamond', count: 1 });
      expect(r.equipment.chestplate).toEqual({ id: 'diamond', count: 1 });
      expect(r.equipment.leggings).toEqual({ id: 'diamond', count: 1 });
      expect(r.equipment.boots).toEqual({ id: 'diamond', count: 1 });
    });

    it('副手槽 -106 映射 offhand', () => {
      const r = instance._buildInventoryResult([mk(-106)], [], 'snapshot');
      expect(r.equipment.offhand).toEqual({ id: 'diamond', count: 1 });
    });

    it('末影箱物品 slot 0-26 分配', () => {
      const r = instance._buildInventoryResult([], [mk(0), mk(26)], 'snapshot');
      expect(r.enderChest[0]).toEqual({ id: 'diamond', count: 1 });
      expect(r.enderChest[26]).toEqual({ id: 'diamond', count: 1 });
    });

    it('末影箱越界槽位安全丢弃', () => {
      const r = instance._buildInventoryResult([], [mk(27), mk(-1)], 'snapshot');
      expect(r.enderChest.every((c) => c === null)).toBe(true);
    });

    it('null 列表容错：返回全空结构不抛异常', () => {
      const r = instance._buildInventoryResult(null, null, 'snapshot');
      expect(r.quickbar).toHaveLength(9);
      expect(r.main).toHaveLength(27);
      expect(r.enderChest).toHaveLength(27);
      expect(r.source).toBe('snapshot');
      expect(r.partial).toBe(false);
    });

    it('partial 标志与 source 透传', () => {
      const r = instance._buildInventoryResult([], [], 'realtime', true);
      expect(r.partial).toBe(true);
      expect(r.source).toBe('realtime');
    });
  });

  describe('_extractNbtFromResponse', () => {
    it('空响应返回 null', () => {
      expect(instance._extractNbtFromResponse('')).toBeNull();
      expect(instance._extractNbtFromResponse(null)).toBeNull();
    });

    it('无花括号响应返回 null', () => {
      expect(instance._extractNbtFromResponse('Player not found')).toBeNull();
    });

    it('从第一个 { 起截取 NBT', () => {
      const r = instance._extractNbtFromResponse(
        'Steve has the following entity data: {id: 1, tag: {x: 2}}',
      );
      expect(r).toBe('{id: 1, tag: {x: 2}}');
    });
  });

  describe('_parseSnbtItem', () => {
    it('无 id 返回 null', () => {
      expect(instance._parseSnbtItem('{Count:1b}')).toBeNull();
    });

    it('id 剥离 minecraft: 前缀（单双引号兼容）', () => {
      expect(instance._parseSnbtItem(`{id:"minecraft:diamond",Count:3b}`).id).toBe('diamond');
      expect(instance._parseSnbtItem(`{id:'minecraft:gold_ingot'}`).id).toBe('gold_ingot');
    });

    it('air 物品过滤', () => {
      expect(instance._parseSnbtItem(`{id:"minecraft:air"}`)).toBeNull();
    });

    it('count 旧版 Count / 新版 count 解析，缺省回退 1', () => {
      expect(instance._parseSnbtItem(`{id:"minecraft:dirt",Count:64b}`).count).toBe(64);
      expect(instance._parseSnbtItem(`{id:"minecraft:dirt",count:12}`).count).toBe(12);
      expect(instance._parseSnbtItem(`{id:"minecraft:dirt"}`).count).toBe(1);
    });

    it('slot 旧版 Slot / 新版 slot / 负数槽位解析', () => {
      expect(instance._parseSnbtItem(`{id:"minecraft:dirt",Slot:5b}`).slot).toBe(5);
      expect(instance._parseSnbtItem(`{id:"minecraft:dirt",slot:12}`).slot).toBe(12);
      expect(instance._parseSnbtItem(`{id:"minecraft:dirt",Slot:-106b}`).slot).toBe(-106);
      expect(instance._parseSnbtItem(`{id:"minecraft:dirt"}`).slot).toBe(0);
    });

    it('附魔检测：旧版 Enchantments 列表', () => {
      expect(
        instance._parseSnbtItem(`{id:"minecraft:sword",Enchantments:[{id:"sharpness"}]}`).enchanted,
      ).toBe(true);
    });

    it('附魔检测：新版组件名（enchantments / stored_enchantments）', () => {
      expect(
        instance._parseSnbtItem(`{id:"minecraft:bow","minecraft:enchantments":{}}`).enchanted,
      ).toBe(true);
      expect(
        instance._parseSnbtItem(`{id:"minecraft:book","minecraft:stored_enchantments":{}}`)
          .enchanted,
      ).toBe(true);
    });

    it('未附魔物品 enchanted 为 false', () => {
      expect(instance._parseSnbtItem(`{id:"minecraft:dirt",Count:1b}`).enchanted).toBe(false);
    });

    it('旧版 Name 提取自定义名称', () => {
      expect(
        instance._parseSnbtItem(`{id:"minecraft:sword",Name:'{"text":"神剑"}'}`).customName,
      ).toBe('神剑');
    });

    it('新版 custom_name 提取自定义名称', () => {
      expect(
        instance._parseSnbtItem(`{id:"minecraft:stick","minecraft:custom_name":'{"text":"教鞭"}'}`)
          .customName,
      ).toBe('教鞭');
    });
  });

  describe('_parseSnbtItemList', () => {
    it('空输入返回空数组', () => {
      expect(instance._parseSnbtItemList('')).toEqual([]);
      expect(instance._parseSnbtItemList(null)).toEqual([]);
    });

    it('无方括号结构返回空数组', () => {
      expect(instance._parseSnbtItemList('no list here')).toEqual([]);
    });

    it('单物品解析', () => {
      const r = instance._parseSnbtItemList(`[{id:"minecraft:diamond",Count:3b,Slot:1b}]`);
      expect(r).toHaveLength(1);
      expect(r[0]).toEqual({
        id: 'diamond',
        count: 3,
        slot: 1,
        durability: null,
        enchanted: false,
        customName: null,
      });
    });

    it('多物品（含嵌套大括号）逐项提取', () => {
      const r = instance._parseSnbtItemList(
        `[{id:"minecraft:a",Count:1b,Slot:0b,tag:{display:{Name:'{"text":"x"}'}}},{id:"minecraft:b",Count:2b,Slot:1b}]`,
      );
      expect(r).toHaveLength(2);
      expect(r[0].id).toBe('a');
      expect(r[1].id).toBe('b');
    });

    it('字符串内大括号/引号不干扰括号匹配', () => {
      const r = instance._parseSnbtItemList(
        `[{id:"minecraft:a",Name:'{"text":"a{b}c"}',Count:1b,Slot:0b}]`,
      );
      expect(r).toHaveLength(1);
      expect(r[0].customName).toBe('a{b}c');
    });

    it('无 id 的无效物品被过滤', () => {
      const r = instance._parseSnbtItemList(`[{Count:1b},{id:"minecraft:dirt",Count:1b,Slot:2b}]`);
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe('dirt');
    });
  });

  describe('_loadInventoryFromRcon', () => {
    // isRconConnected 是读 server.properties 的 getter：用实例属性遮蔽模拟连接态
    function rconConnected(instance, on) {
      if (on) {
        Object.defineProperty(instance, 'isRconConnected', { value: true, configurable: true });
      }
    }

    it('RCON 未连接返回 null', async () => {
      expect(await instance._loadInventoryFromRcon('Steve')).toBeNull();
    });

    it('在线查询现状行为：完整列表响应经 _extractNbtFromResponse（从 { 截取丢外层 [）后列表解析为空 → 降级 null（行为锁定）', async () => {
      rconConnected(instance, true);
      vi.spyOn(instance, 'sendCommandWithResponse').mockImplementation(async (cmd) => {
        if (cmd.includes('Inventory')) {
          return 'Steve has the following entity data: [{id:"minecraft:diamond",Count:3b,Slot:1b}]';
        }
        return 'Steve has the following entity data: []';
      });
      expect(await instance._loadInventoryFromRcon('Steve')).toBeNull();
    });

    it('Inventory 响应截断（未以 ] 结尾）降级返回 null', async () => {
      rconConnected(instance, true);
      vi.spyOn(instance, 'sendCommandWithResponse').mockImplementation(async (cmd) => {
        if (cmd.includes('Inventory')) {
          return 'Steve has the following entity data: [{id:"minecraft:diamond",Count:3b,Sl';
        }
        return 'Steve has the following entity data: []';
      });
      expect(await instance._loadInventoryFromRcon('Steve')).toBeNull();
    });

    it('EnderItems 响应截断同样降级返回 null', async () => {
      rconConnected(instance, true);
      vi.spyOn(instance, 'sendCommandWithResponse').mockImplementation(async (cmd) => {
        if (cmd.includes('Inventory')) {
          return 'Steve has the following entity data: [{id:"minecraft:diamond",Count:1b,Slot:0b}]';
        }
        return 'Steve has the following entity data: [{id:"minecraft:stone",Co';
      });
      expect(await instance._loadInventoryFromRcon('Steve')).toBeNull();
    });

    it('Inventory 响应无 NBT 结构返回 null', async () => {
      rconConnected(instance, true);
      vi.spyOn(instance, 'sendCommandWithResponse').mockImplementation(
        async () => 'Steve is not found',
      );
      expect(await instance._loadInventoryFromRcon('Steve')).toBeNull();
    });

    it('命令执行失败（reject 吞掉）降级返回 null', async () => {
      rconConnected(instance, true);
      vi.spyOn(instance, 'sendCommandWithResponse').mockRejectedValue(new Error('EPIPE'));
      expect(await instance._loadInventoryFromRcon('Steve')).toBeNull();
    });
  });

  describe('_loadInventoryFromDat', () => {
    const UUID = '11111111-2222-3333-4444-555555555555';

    function nbtCompound(items, enderItems = []) {
      const item = (id, count, slot) => ({
        id: { type: 'string', value: `minecraft:${id}` },
        Count: { type: 'int', value: count },
        Slot: { type: 'byte', value: slot },
      });
      return {
        type: 'compound',
        name: '',
        value: {
          Inventory: {
            type: 'list',
            value: { type: 'compound', value: items.map(([i, c, s]) => item(i, c, s)) },
          },
          EnderItems: {
            type: 'list',
            value: { type: 'compound', value: enderItems.map(([i, c, s]) => item(i, c, s)) },
          },
        },
      };
    }

    it('读取 world/playerdata 快照并解析物品', () => {
      writeNbtFile(
        path.join(tmpDir, 'world', 'playerdata', `${UUID}.dat`),
        nbtCompound([
          ['diamond', 3, 1],
          ['stone', 1, 10],
        ]),
      );
      const r = instance._loadInventoryFromDat(UUID, 'Steve');
      expect(r).not.toBeNull();
      expect(r.source).toBe('snapshot');
      expect(r.quickbar[1]).toMatchObject({ id: 'diamond', count: 3 });
      expect(r.main[1]).toMatchObject({ id: 'stone', count: 1 });
    });

    it('dat 文件不存在返回 null', () => {
      expect(instance._loadInventoryFromDat(UUID, 'Steve')).toBeNull();
    });

    it('损坏的 dat 文件（非法 gzip）捕获异常返回 null', () => {
      const p = path.join(tmpDir, 'world', 'playerdata', `${UUID}.dat`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from('not-a-gzip-file'));
      expect(instance._loadInventoryFromDat(UUID, 'Steve')).toBeNull();
    });

    it('MC 26.x equipment 独立装备字段并入物品列表', () => {
      const base = nbtCompound([['apple', 5, 0]]);
      base.value.equipment = {
        type: 'compound',
        value: {
          head: {
            type: 'compound',
            value: {
              id: { type: 'string', value: 'minecraft:diamond_helmet' },
              Count: { type: 'int', value: 1 },
            },
          },
        },
      };
      writeNbtFile(path.join(tmpDir, 'world', 'playerdata', `${UUID}.dat`), base);
      const r = instance._loadInventoryFromDat(UUID, 'Steve');
      expect(r.equipment.helmet).toMatchObject({ id: 'diamond_helmet', count: 1 });
      expect(r.quickbar[0]).toMatchObject({ id: 'apple', count: 5 });
    });

    it('末影箱物品从 EnderItems 解析', () => {
      writeNbtFile(
        path.join(tmpDir, 'world', 'playerdata', `${UUID}.dat`),
        nbtCompound([['apple', 1, 0]], [['obsidian', 64, 3]]),
      );
      const r = instance._loadInventoryFromDat(UUID, 'Steve');
      expect(r.enderChest[3]).toMatchObject({ id: 'obsidian', count: 64 });
    });
  });

  describe('getLogs', () => {
    it('空缓冲返回空数组', () => {
      expect(instance.getLogs()).toEqual([]);
    });

    it('默认返回全部缓冲日志', () => {
      instance.logBuffer = [
        { time: 1, text: 'a', type: 'stdout' },
        { time: 2, text: 'b', type: 'stderr' },
      ];
      expect(instance.getLogs()).toHaveLength(2);
    });

    it('lines 参数截断返回末尾 N 条', () => {
      instance.logBuffer = [
        { time: 1, text: 'a', type: 'stdout' },
        { time: 2, text: 'b', type: 'stdout' },
        { time: 3, text: 'c', type: 'stdout' },
      ];
      const r = instance.getLogs(2);
      expect(r).toHaveLength(2);
      expect(r[0].text).toBe('b');
      expect(r[1].text).toBe('c');
    });
  });
});
