/**
 * level-dat 世界存档数据读取域模块行为级测试（拆分交付）
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
vi.mock('../src/config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-level-dat-test-'));
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
  _makeSeedCache,
  _readLevelDatData,
  _getSafeLevelName,
} from '../src/services/mc-server/level-dat.js';
import { MCServerInstance } from '../src/services/mc_server.js';

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
      '_getSafeLevelName',
      '_getWorldSize',
      '_readSeedFromLevelDat',
      '_readSeedFromWorldGenSettings',
      '_makeSeedCache',
      'readDifficulty',
      '_readGameTypeFromLevelDat',
      '_readDifficultyFromLevelDat',
      '_readLevelDatData',
      '_getLastSaveTime',
      '_readWeatherFromLevelDat',
      '_readWorldSpawnFromLevelDat',
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
      value: {
        Data: { type: 'compound', name: '', value: { GameType: { type: 'int', value: 1 } } },
      },
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

  it('存档写入发生在 region/ 子目录时顶层缓存判定不失效，_worldSizeDirty 强制重算并清除', async () => {
    fs.mkdirSync(path.join(worldDir, 'region'), { recursive: true });
    // 51MB ≈ 0.049805 GB（服务端保留 6 位小数，换算成 MB 由前端做）；
    // 两个 51MB ≈ 0.099609 GB，增量可区分
    fs.writeFileSync(path.join(worldDir, 'region', 'r.-1.-1.mca'), Buffer.alloc(51 * 1024 * 1024));
    const inst = makeBareInstance(dir);

    // 首次数值由后台遍历产出：本次调用先返回空态，遍历完成后收敛
    expect(inst._getWorldSize()).toBe(0);
    await inst._worldSizeRefreshPromise;
    expect(inst._getWorldSize()).toBeCloseTo(0.049805, 6);

    // 模拟游戏推进：region/ 子目录内新增文件——world/ 顶层目录 mtime/size 不变
    fs.writeFileSync(path.join(worldDir, 'region', 'r.0.-1.mca'), Buffer.alloc(51 * 1024 * 1024));
    expect(inst._getWorldSize()).toBeCloseTo(0.049805, 6); // 复现缺陷路径：仅靠顶层 stat 判定感知不到

    // 存档事件置 dirty → 重算（本次仍返回旧值，遍历完成后收敛）
    inst._worldSizeDirty = true;
    expect(inst._getWorldSize()).toBeCloseTo(0.049805, 6);
    // 排重算即清 dirty：遍历期间再存档会重新置位，下次调用再排一轮
    expect(inst._worldSizeDirty).toBe(false);
    await inst._worldSizeRefreshPromise;
    expect(inst._getWorldSize()).toBeCloseTo(0.099609, 6);
    expect(inst._worldSizeCache.value).toBeCloseTo(0.099609, 6);
  });

  // 实测缺陷回归：服务端曾把 GB 值取整到 2 位小数，导致 <5.12MB 的世界一律归零。
  // 界面于是显示「0 GB」，与「没有存档」无法区分（新建实例实测 2.4MB 即命中）。
  // 前端 worldSizeParts 专门有 <1GB 换算 MB 的分支，取整过早会让它永远拿到 0。
  it('小存档不被取整归零（2.4MB → 约 0.002289 GB，而非 0）', async () => {
    // 独立目录：与上一用例共用 worldDir 会读到其 102MB 残留，断言失去意义
    const smallDir = path.join(tmpBase, 'ws-small');
    const smallWorld = path.join(smallDir, 'world');
    fs.mkdirSync(path.join(smallWorld, 'region'), { recursive: true });
    const bytes = 2_400_000;
    fs.writeFileSync(path.join(smallWorld, 'region', 'r.0.0.mca'), Buffer.alloc(bytes));
    const inst = makeBareInstance(smallDir);
    inst._getWorldSize();
    await inst._worldSizeRefreshPromise;
    const gb = inst._getWorldSize();
    expect(gb).toBeGreaterThan(0);
    expect(gb).toBeCloseTo(bytes / 1024 ** 3, 6);
    // 前端 worldSizeParts 走 <1GB 分支时按 GB*1024 取整成 MB，结果须非零，
    // 否则界面仍显示「0 MB」——即服务端精度必须撑得住这一步换算
    expect(Math.round(gb * 1024)).toBeGreaterThan(0);
  });

  it('世界目录不存在 → 0 且不写缓存', () => {
    const inst = makeBareInstance(path.join(tmpBase, 'ws-missing'));
    expect(inst._getWorldSize()).toBe(0);
    expect(inst._worldSizeCache).toBeUndefined();
    // 不排后台重算：没有世界可统计，排了只会刷告警
    expect(inst._worldSizeRefreshPromise).toBeUndefined();
  });

  // 承重断言：调用返回时遍历仍在进行。世界变大时事件循环必须仍能跑别的任务——
  // 探针：把 _refreshWorldSize 改回同步遍历（返回前完成），本用例转红。
  it('大目录统计不阻塞事件循环：调用返回时遍历尚未完成，且并发调用共用一次遍历', async () => {
    const bigDir = path.join(tmpBase, 'ws-big');
    const bigWorld = path.join(bigDir, 'world');
    const regionDir = path.join(bigWorld, 'region');
    fs.mkdirSync(regionDir, { recursive: true });
    // 4000 个文件足够让同步遍历占住事件循环，异步遍历期间定时器能插进来
    for (let i = 0; i < 4000; i++) {
      fs.writeFileSync(path.join(regionDir, `f${i}.dat`), 'x');
    }
    const inst = makeBareInstance(bigDir);

    let refreshDone = false;
    let timerRan = false;
    inst._getWorldSize();
    const inFlight = inst._worldSizeRefreshPromise;
    inFlight.then(() => {
      refreshDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    timerRan = refreshDone === false;
    await inFlight;

    expect(timerRan).toBe(true); // 调用返回后遍历仍在进行 ⇒ 没有同步占满事件循环
    expect(inst._getWorldSize()).toBeGreaterThan(0);
    // 并发调用只跑一轮：在途期间再次触发重算，复用同一个 promise
    inst._worldSizeDirty = true;
    inst._getWorldSize();
    const inFlightAgain = inst._worldSizeRefreshPromise;
    expect(inst._refreshWorldSize(bigWorld)).toBe(inFlightAgain);
    await inFlightAgain;
  });
});
