/**
 * level-dat 世界存档数据读取域模块行为级测试（issue 490 拆分交付）
 * - 模块直接 import 可用（require 复用语义，与 mc_server.js 原型注入同源）
 * - 原型注入后实例调用 this 绑定正确（_getSafeLevelName 走实例 properties）
 * - makeSeedCache 缓存条目构造（mtime/size 快照）
 * - readLevelDatData 真实 NBT fixture 解析 + 损坏文件兜底
 * 数据全部为虚构占位
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { writeUncompressed } from 'prismarine-nbt';

// logger 经 utils/logger.js 读取 config，mock 指向临时目录避免触碰真实数据目录
vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-level-dat-test-'));
  return {
    default: {
      apiKey: '',
      port: 0,
      serversDir: path.join(tmpRoot, 'servers'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      logLevel: 'info',
      rateLimit: { windowMs: 60000, max: 100 },
    },
  };
});

import { _makeSeedCache, _readLevelDatData, _getSafeLevelName } from '../services/mc-server/level-dat.js';
import { MCServerInstance } from '../services/mc_server.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-level-dat-fixture-'));

function writeNbtFile(filePath, nbtData) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, zlib.gzipSync(writeUncompressed(nbtData)));
}

function makeBareInstance(serverPath, properties = {}) {
  // 裸原型实例：验证 Object.assign 挂载后的 this 绑定，不经 constructor 副作用
  const inst = Object.create(MCServerInstance.prototype);
  inst.serverPath = serverPath;
  inst.properties = properties;
  inst.id = 'fixture';
  return inst;
}

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('level-dat 模块 require 复用语义', () => {
  it('12 个域方法经 Object.assign 注入 MCServerInstance 原型，实例调用 this 绑定正确', () => {
    const inst = makeBareInstance(path.join(tmpBase, 'inst-a'));
    for (const m of [
      '_getSafeLevelName', '_getWorldSize', '_readSeedFromLevelDat', '_readSeedFromWorldGenSettings',
      '_makeSeedCache', 'readDifficulty', '_readGameTypeFromLevelDat', '_readDifficultyFromLevelDat',
      '_readLevelDatData', '_getLastSaveTime', '_readWeatherFromLevelDat', '_readWorldSpawnFromLevelDat',
    ]) {
      expect(typeof inst[m]).toBe('function');
    }
    // this.properties/serverPath 读取验证：缺省回退 'world'
    expect(inst._getSafeLevelName()).toBe('world');
  });

  it('_getSafeLevelName 服务层兜底：非法 level-name 回退 world（实例 properties 读取）', () => {
    const inst = makeBareInstance(path.join(tmpBase, 'inst-b'), { 'level-name': '../evil' });
    expect(inst._getSafeLevelName()).toBe('world');
    inst.properties = { 'level-name': 'myworld' };
    expect(inst._getSafeLevelName()).toBe('myworld');
  });
});

describe('level-dat 纯解析函数', () => {
  it('_makeSeedCache 构造含源文件 mtime/size 的缓存条目', () => {
    const p = path.join(tmpBase, 'seed-src.dat');
    fs.writeFileSync(p, 'fixture-seed-source');
    const entry = _makeSeedCache('424242', p);
    expect(entry.value).toBe('424242');
    expect(entry.sourcePath).toBe(p);
    expect(typeof entry.mtimeMs).toBe('number');
    expect(entry.size).toBe(fs.statSync(p).size);
  });

  it('_readLevelDatData 解析真实 NBT fixture 的 Data 节点；损坏文件返 null', () => {
    const worldDir = path.join(tmpBase, 'inst-c', 'world');
    writeNbtFile(path.join(worldDir, 'level.dat'), {
      type: 'compound',
      name: '',
      value: { Data: { type: 'compound', name: '', value: { GameType: { type: 'int', value: 1 } } } },
    });
    const inst = makeBareInstance(path.join(tmpBase, 'inst-c'));
    const data = inst._readLevelDatData();
    expect(data?.GameType?.value).toBe(1);

    fs.mkdirSync(path.join(tmpBase, 'inst-d', 'world'), { recursive: true });
    fs.writeFileSync(path.join(tmpBase, 'inst-d', 'world', 'level.dat'), Buffer.from('corrupted'));
    const bad = makeBareInstance(path.join(tmpBase, 'inst-d'));
    expect(bad._readLevelDatData()).toBeNull();
  });
});

describe('_getWorldSize 缓存失效：dirty 标记（实测缺陷回归：子目录增长顶层 mtime 不变）', () => {
  const dir = path.join(tmpBase, 'ws-dirty');
  const worldDir = path.join(dir, 'world');

  it('存档写入发生在 region/ 子目录时顶层缓存判定不失效，_worldSizeDirty 强制重算并清除', () => {
    fs.mkdirSync(path.join(worldDir, 'region'), { recursive: true });
    // 51MB → 缓存精度（两位小数 GB）下 0.05；两个 51MB → 0.1，增量可区分
    fs.writeFileSync(path.join(worldDir, 'region', 'r.-1.-1.mca'), Buffer.alloc(51 * 1024 * 1024));
    const inst = makeBareInstance(dir);

    const first = inst._getWorldSize();
    expect(first).toBe(0.05);

    // 模拟游戏推进：region/ 子目录内新增文件——world/ 顶层目录 mtime/size 不变
    fs.writeFileSync(path.join(worldDir, 'region', 'r.0.-1.mca'), Buffer.alloc(51 * 1024 * 1024));
    expect(inst._getWorldSize()).toBe(0.05); // 复现缺陷路径：仅靠顶层 stat 判定感知不到

    // 存档事件置 dirty → 下次调用强制重算
    inst._worldSizeDirty = true;
    expect(inst._getWorldSize()).toBe(0.1);
    // 重算后 dirty 清除、缓存刷新
    expect(inst._worldSizeDirty).toBe(false);
    expect(inst._worldSizeCache.value).toBe(0.1);
  });

  it('世界目录不存在 → 0 且不写缓存', () => {
    const inst = makeBareInstance(path.join(tmpBase, 'ws-missing'));
    expect(inst._getWorldSize()).toBe(0);
    expect(inst._worldSizeCache).toBeUndefined();
  });
});
