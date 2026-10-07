/**
 * stats-collector 实例统计采集域模块行为级测试（issue 510 补测）
 * - 调度链：串行化递归 setTimeout + 代际 epoch 防双链（fake timers 推钟）
 * - 系统采集：/proc fixture 驱动差分 CPU 计算 + win32 PowerShell 分支 + ps 兜底
 * - MSPT：tick query 主路径 + TPS 回退反推（真实 isRconConnected getter 链路）
 * - 世界状态：三级时间 fallback 链 + weather.dat 真实 NBT fixture
 * - 玩家采集：RCON 响应解析 / 入睡事件 / 计数聚合 / 错误隔离
 * RCON 为外部 IO 边界（单测无法直连真实服务器），按 #505 范式在实例边界 stub，
 * 解析/聚合/事件广播全为真实行为断言；数据全部为虚构占位（Steve/Alex/1.2.3.4）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { EventEmitter } from 'node:events';
import { writeUncompressed } from 'prismarine-nbt';

// logger 经 utils/logger.js 读取 config，mock 指向临时目录避免触碰真实数据目录
vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stats-collector-test-'));
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

// exec 仅在 win32 PowerShell 分支与 Linux ps 兜底分支使用；保留其余 named exports 真实实现
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, exec: vi.fn() };
});
import { exec } from 'child_process';

import {
  _startStatsCollection,
  _playerStatsSnapshot,
  _schedulePlayerStats,
  _scheduleMspt,
  _scheduleWorldState,
  _stopStatsCollection,
  _collectStats,
  _collectLinuxStats,
  _collectMspt,
  _collectWorldState,
  _queryWorldTime,
  _queryWorldDay,
  _collectPlayerStats,
} from '../services/mc-server/stats-collector.js';
import { MCServerInstance } from '../services/mc_server.js';
import { logger } from '../utils/logger.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stats-collector-fixture-'));

function makeBareInstance() {
  // 裸原型实例：验证 Object.assign 挂载后的 this 绑定，不经 constructor 副作用；
  // EventEmitter.call 显式初始化事件系统（采集链大量 emit）
  const inst = Object.create(MCServerInstance.prototype);
  EventEmitter.call(inst);
  inst.id = 'fixture';
  inst.serverPath = fs.mkdtempSync(path.join(tmpBase, 'inst-'));
  inst.properties = {};
  inst.players = new Map();
  inst.playerEvents = new Map();
  inst.isRunning = true;
  inst.process = { pid: 4242 };
  inst.tps = 20;
  inst._mspt = 0;
  inst._weather = 'clear';
  inst._worldTime = null;
  inst._worldDay = null;
  inst._cpuUsage = 0;
  inst._memoryUsage = 0;
  inst._sleepingPlayers = 0;
  inst._playerStatsEpoch = 0;
  inst._msptEpoch = 0;
  inst._worldStateEpoch = 0;
  return inst;
}

function writeWeatherDat(inst, raining, thundering) {
  const dir = path.join(inst.serverPath, 'world', 'data', 'minecraft');
  fs.mkdirSync(dir, { recursive: true });
  const nbt = {
    type: 'compound',
    name: '',
    value: {
      data: {
        type: 'compound',
        name: '',
        value: {
          raining: { type: 'int', value: raining },
          thundering: { type: 'int', value: thundering },
        },
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'weather.dat'), zlib.gzipSync(writeUncompressed(nbt)));
}

function writeServerProperties(inst, entries) {
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(inst.serverPath, 'server.properties'), lines.join('\n') + '\n');
}

// RCON 响应分发：命令 → 回显文本（外部 IO 边界 stub）；
// handler 可返回字符串或 async 函数（后者代表拒答场景，解包调用后传播 rejection）
function stubRconSend(inst, handler) {
  inst._rconSend = vi.fn(async (cmd) => {
    const r = handler(cmd);
    return typeof r === 'function' ? await r() : r;
  });
}

function collectPerf(inst) {
  const perf = [];
  inst.on('performanceUpdate', (e) => perf.push(e));
  return perf;
}

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers();
  exec.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('采集域模块 require 复用语义', () => {
  it('12 个域方法经 Object.assign 注入 MCServerInstance 原型，实例调用 this 绑定正确', () => {
    const inst = makeBareInstance();
    for (const m of [
      '_startStatsCollection',
      '_schedulePlayerStats',
      '_scheduleMspt',
      '_scheduleWorldState',
      '_stopStatsCollection',
      '_collectStats',
      '_collectLinuxStats',
      '_collectMspt',
      '_collectWorldState',
      '_queryWorldTime',
      '_queryWorldDay',
      '_collectPlayerStats',
    ]) {
      expect(typeof inst[m]).toBe('function');
    }
    // _stopStatsCollection 对空 timer 状态安全（无 timer 字段时不抛错）
    expect(() => inst._stopStatsCollection()).not.toThrow();
    expect(inst._playerStatsEpoch).toBe(1);
    expect(inst._msptEpoch).toBe(1);
    expect(inst._worldStateEpoch).toBe(1);
  });
});

describe('_stopStatsCollection 清理与代际推进', () => {
  it('四类 timer 全部清理置 null，三个代际 epoch 各自增 1', () => {
    const inst = makeBareInstance();
    inst._statsTimer = setInterval(() => {}, 5000);
    inst._msptTimer = setTimeout(() => {}, 30000);
    inst._saveTimer = setInterval(() => {}, 60000);
    inst._playerStatsTimer = setTimeout(() => {}, 5000);
    inst._worldStateTimer = setTimeout(() => {}, 10000);
    inst._playerStatsEpoch = 2;
    inst._msptEpoch = 3;
    inst._worldStateEpoch = 4;
    inst._stopStatsCollection();
    expect(inst._statsTimer).toBeNull();
    expect(inst._msptTimer).toBeNull();
    expect(inst._saveTimer).toBeNull();
    expect(inst._playerStatsTimer).toBeNull();
    expect(inst._playerStatsEpoch).toBe(3);
    expect(inst._msptEpoch).toBe(4);
    expect(inst._worldStateEpoch).toBe(5);
    // 推进任意时间后预置定时器不再触发（clearInterval/clearTimeout 生效）
    const collect = vi.fn();
    inst._collectStats = collect;
    vi.advanceTimersByTime(120000);
    expect(collect).not.toHaveBeenCalled();
  });
});

describe('调度链（串行化递归 setTimeout + 代际 epoch）', () => {
  it('_startStatsCollection 建立采集矩阵：立即首轮 + 各域调度 + interval 采集', async () => {
    const inst = makeBareInstance();
    const worldState = vi.fn(async () => {});
    const collect = vi.fn(() => {});
    const playerStats = vi.fn(async () => {});
    const mspt = vi.fn(async () => {});
    inst._collectWorldState = worldState;
    inst._collectStats = collect;
    inst._collectPlayerStats = playerStats;
    inst._collectMspt = mspt;
    // 预置旧 timer 验证 start 先行清理（防双跑）
    inst._statsTimer = setInterval(() => {}, 1000);
    const perf = collectPerf(inst);

    inst._startStatsCollection();
    // 首轮立即执行：world state 与 stats 各 1 次；playerStats/mspt 尚未到间隔
    expect(worldState).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(playerStats).not.toHaveBeenCalled();
    expect(mspt).not.toHaveBeenCalled();
    // world state 完成后代际未变 → 续链调度（10s 后第二轮）
    await vi.advanceTimersByTimeAsync(0);
    expect(inst._worldStateTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    expect(worldState).toHaveBeenCalledTimes(2);
    // playerStats 递归链（t=5000/10000）与 stats interval（t=5000/10000）均连续触发
    expect(playerStats).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(3); // 初始 1 + interval 2
    await vi.advanceTimersByTimeAsync(5000);
    expect(playerStats).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(25000);
    expect(mspt).toHaveBeenCalledTimes(1); // t=30000
    expect(typeof perf).toBe('object');
  });

  it('_startStatsCollection：world state 首轮 reject 被吞且仍续链（监听器异常不中断采集）', async () => {
    const inst = makeBareInstance();
    let call = 0;
    const worldState = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('broadcast failed');
    });
    inst._collectWorldState = worldState;
    inst._collectStats = vi.fn(() => {});
    inst._startStatsCollection();
    await vi.advanceTimersByTimeAsync(0);
    // reject 被 .catch 吞掉后 .then 内代际校验通过 → 续链成功
    expect(inst._worldStateTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    expect(worldState).toHaveBeenCalledTimes(2);
  });

  it('_startStatsCollection：代际被 stop 推进后在途回调不续链（stop→start 防双链）', async () => {
    const inst = makeBareInstance();
    const worldState = vi.fn(async () => {
      // 模拟采集期间被 stop：代际自增使 then 内校验失败
      inst._worldStateEpoch += 1;
    });
    inst._collectWorldState = worldState;
    inst._collectStats = vi.fn(() => {});
    inst._startStatsCollection();
    await vi.advanceTimersByTimeAsync(0);
    expect(inst._worldStateTimer).toBeFalsy();
    await vi.advanceTimersByTimeAsync(20000);
    expect(worldState).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['_schedulePlayerStats', '_collectPlayerStats', 5000],
    ['_scheduleMspt', '_collectMspt', 30000],
    ['_scheduleWorldState', '_collectWorldState', 10000],
  ])('%s：间隔触发采集，本轮完成后自续链', async (scheduleFn, collectFn, interval) => {
    const inst = makeBareInstance();
    const collect = vi.fn(async () => {});
    inst[collectFn] = collect;
    inst[scheduleFn]();
    await vi.advanceTimersByTimeAsync(interval);
    expect(collect).toHaveBeenCalledTimes(1);
    // 本轮完成后自续链
    await vi.advanceTimersByTimeAsync(interval);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['_schedulePlayerStats', '_collectPlayerStats', 5000],
    ['_scheduleMspt', '_collectMspt', 30000],
    ['_scheduleWorldState', '_collectWorldState', 10000],
  ])('%s：采集 reject 不中断链；代际推进后停链', async (scheduleFn, collectFn, interval) => {
    const inst = makeBareInstance();
    const epochKey =
      scheduleFn === '_schedulePlayerStats'
        ? '_playerStatsEpoch'
        : scheduleFn === '_scheduleMspt'
          ? '_msptEpoch'
          : '_worldStateEpoch';
    let call = 0;
    const collect = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('listener boom');
      if (call === 2) inst[epochKey] += 1; // 模拟 stop 竞争
    });
    inst[collectFn] = collect;
    inst[scheduleFn]();
    await vi.advanceTimersByTimeAsync(interval);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(interval); // reject 后仍续链 → 第 2 次
    expect(collect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(interval); // 代际已变 → 停链
    expect(collect).toHaveBeenCalledTimes(2);
    const timerKey =
      scheduleFn === '_schedulePlayerStats'
        ? '_playerStatsTimer'
        : scheduleFn === '_scheduleMspt'
          ? '_msptTimer'
          : '_worldStateTimer';
    expect(inst[timerKey]).toBeNull();
  });
});

describe('_collectStats 门控与平台分支', () => {
  it('门控：无进程/未运行/无 pid 直接返回不采集', () => {
    const inst = makeBareInstance();
    const linux = vi.spyOn(inst, '_collectLinuxStats').mockImplementation(() => {});
    inst.process = null;
    inst._collectStats();
    inst.process = { pid: 4242 };
    inst.isRunning = false;
    inst._collectStats();
    inst.isRunning = true;
    inst.process = { pid: 0 };
    inst._collectStats();
    expect(linux).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('win32 分支：PowerShell JSON 解析 WorkingSet（两位小数）与 CPU 基线并广播', () => {
    const inst = makeBareInstance();
    const perf = collectPerf(inst);
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      exec.mockImplementation((cmd, opts, cb) => {
        // WMIC 自 Win11 24H2 起不随系统提供，改走 PowerShell（命令形态是契约的一部分）
        expect(cmd).toContain('powershell');
        expect(cmd).toContain('Get-Process -Id 4242');
        // windowsHide：面板以 Windows 服务方式运行时不得每轮闪控制台窗口
        expect(opts).toMatchObject({ timeout: 8000, windowsHide: true });
        cb(null, '{"WorkingSet64":1867776000,"CPU":12.5}');
      });
      inst._collectStats();
      expect(inst._memoryUsage).toBe(1.74); // 1867776000 B ≈ 1.74 GB，与 Linux 同口径
      expect(inst._lastCpuTime.cpu).toBe(12.5); // 首次采样只建立 CPU 基线（秒）
      expect(inst._cpuUsage).toBe(0);
      expect(perf).toHaveLength(1);

      // 字段缺失/非数字：内存保留旧值，CPU 基线不动
      const inst2 = makeBareInstance();
      inst2._memoryUsage = 0.5;
      exec.mockImplementation((_cmd, ...rest) =>
        rest[rest.length - 1](null, '{"WorkingSet64":null,"CPU":null}'),
      );
      inst2._collectStats();
      expect(inst2._memoryUsage).toBe(0.5);
      expect(inst2._cpuUsage).toBe(0);
      expect(inst2._lastCpuTime).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('win32 分支：两次采样的 CPU 秒差按 elapsed 折算，单进程超 100% 截断', () => {
    const inst = makeBareInstance();
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      // cpuDiff = 11.5s / elapsed 1s = 1150%（多核并行的进程也按单进程口径截断）；
      // 输入须明显越过上限：恰好 100% 时删掉截断照样通过，用例等于没锁住
      inst._lastCpuTime = { cpu: 1.0, sys: 0, time: Date.now() - 1000 };
      exec.mockImplementation((_cmd, ...rest) =>
        rest[rest.length - 1](null, '{"WorkingSet64":1073741824,"CPU":12.5}'),
      );
      inst._collectStats();
      expect(inst._cpuUsage).toBe(100);
      expect(inst._lastCpuTime.cpu).toBe(12.5);
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('win32 分支：exec 失败、非 JSON 输出均静默（不广播、不覆盖旧值）', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const inst2 = makeBareInstance();
      const perf2 = collectPerf(inst2);
      exec.mockImplementation((_cmd, ...rest) =>
        rest[rest.length - 1](new Error('powershell failed'), ''),
      );
      inst2._collectStats();
      expect(perf2).toHaveLength(0);

      const inst3 = makeBareInstance();
      const perf3 = collectPerf(inst3);
      inst3._memoryUsage = 0.88;
      exec.mockImplementation((_cmd, ...rest) => rest[rest.length - 1](null, 'not json'));
      inst3._collectStats();
      expect(perf3).toHaveLength(0);
      expect(inst3._memoryUsage).toBe(0.88);

      const inst4 = makeBareInstance();
      const perf4 = collectPerf(inst4);
      exec.mockImplementation((_cmd, ...rest) => rest[rest.length - 1](null, undefined));
      inst4._collectStats();
      expect(perf4).toHaveLength(0);
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('win32 分支：监听器抛错不逃逸出 exec 回调（否则命中进程级兜底把面板拉停）', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const inst = makeBareInstance();
      inst.on('performanceUpdate', () => {
        throw new Error('broadcast failed');
      });
      exec.mockImplementation((_cmd, ...rest) =>
        rest[rest.length - 1](null, '{"WorkingSet64":1073741824,"CPU":1}'),
      );
      // exec 回调里抛错无人接管，只能在这里就地吞掉：采集照常、只丢这次广播
      expect(() => inst._collectStats()).not.toThrow();
      expect(inst._memoryUsage).toBe(1);
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('win32 分支：采集失败只在转折处告警一次（避免每 5s 刷屏）', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const inst = makeBareInstance();
      const fail = (_cmd, ...rest) => rest[rest.length - 1](new Error('Access is denied'), '');
      exec.mockImplementation(fail);
      inst._collectStats();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Access is denied');
      expect(warn.mock.calls[0][0]).toContain('4242');
      inst._collectStats();
      expect(warn).toHaveBeenCalledTimes(1); // 持续失败不重复告警

      // 恢复成功后再次失败：仍会告警（不是「一辈子只报一次」）
      exec.mockImplementation((_cmd, ...rest) =>
        rest[rest.length - 1](null, '{"WorkingSet64":1073741824,"CPU":1}'),
      );
      inst._collectStats();
      expect(warn).toHaveBeenCalledTimes(1);
      exec.mockImplementation(fail);
      inst._collectStats();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('Linux 分支：委派 _collectLinuxStats(pid)', () => {
    // 实现按 process.platform 分支，固定为 linux 才能在任意宿主覆盖该分支
    // （同 describe 的 win32 用例用同一手法）。
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const inst = makeBareInstance();
      const linux = vi.spyOn(inst, '_collectLinuxStats').mockImplementation(() => {});
      inst._collectStats();
      expect(linux).toHaveBeenCalledTimes(1);
      expect(linux).toHaveBeenCalledWith(4242);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });
});

describe('_collectLinuxStats：/proc fixture 驱动差分 CPU 计算', () => {
  const PID = 4242;
  const SYS_TOTAL = 5200; // cpu 100 200 300 4000 500 0 100 0 0 0
  let statFixture;
  let statmFixture;
  let procStatFixture;
  let readSpy;

  beforeEach(() => {
    const realRead = fs.readFileSync;
    readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, enc) => {
      const s = String(p);
      if (s === `/proc/${PID}/stat`) {
        if (statFixture === null) return realRead.call(fs, p, enc); // 不存在的 pid → 抛 ENOENT
        return statFixture;
      }
      if (s === `/proc/${PID}/statm`) {
        if (statmFixture === null) return realRead.call(fs, p, enc);
        return statmFixture;
      }
      if (s === '/proc/stat') return procStatFixture;
      return realRead.call(fs, p, enc);
    });
    statFixture = makeStatContent(77, 33);
    statmFixture = '123 456000 78 9 10 11 12\n';
    procStatFixture =
      'cpu  100 200 300 4000 500 0 100 0 0 0\ncpu0 50 100 150 2000 250 0 50 0 0 0\n';
    exec.mockReset();
  });

  afterEach(() => {
    readSpy.mockRestore();
  });

  function makeStatContent(utime, stime) {
    const tokens = ['4242', '(java renderer thread)', 'R'];
    while (tokens.length < 11) tokens.push('0');
    tokens.push(String(utime)); // index 11 = utime（按实现语义）
    tokens.push(String(stime)); // index 12 = stime
    while (tokens.length < 21) tokens.push('0');
    tokens.push('555'); // index 21 = starttime
    return tokens.join(' ') + '\n';
  }

  it('首次采集建立基线：cpuUsage 归零、statm 驻留页换算内存、广播 performanceUpdate', () => {
    const inst = makeBareInstance();
    const perf = collectPerf(inst);
    inst._collectLinuxStats(PID);
    expect(inst._lastCpuTime.cpu).toBe(1.1); // utime 77 + stime 33 = 110 clock tick = 1.1 s
    expect(inst._lastCpuTime.sys).toBe(SYS_TOTAL / 100); // 秒口径（SYS_TOTAL 为 clock tick）
    expect(inst._cpuUsage).toBe(0);
    // 456000 页 × 4096 B = 1867776000 B ≈ 1.74 GB（两位小数四舍五入）
    expect(inst._memoryUsage).toBe(1.74);
    expect(perf).toHaveLength(1);
    expect(perf[0].cpu).toBe(0);
  });

  it('差分采集：cpu/系统时间增量按 elapsed 折算瞬时占用率', () => {
    const inst = makeBareInstance();
    inst._lastCpuTime = { cpu: 0.1, sys: 5, time: Date.now() - 2000 }; // 秒口径（10 tick / 500 tick）
    inst._collectLinuxStats(PID);
    // cpuDiff = 1s；elapsed = 2s → 1/2 = 50%
    expect(inst._cpuUsage).toBe(50);
    expect(inst._lastCpuTime.cpu).toBe(1.1); // 秒口径（110 clock tick / 100）
    expect(inst._lastCpuTime.sys).toBe(SYS_TOTAL / 100); // 秒口径（SYS_TOTAL 为 clock tick）
  });

  it('系统时间零增量分支：瞬时占用率记 0', () => {
    // fixture 必须与实现同为秒口径且 cpu 增量非负，否则先被 cpuDiff<0 拦下，
    // 「sysDiff 为零」这条分支实际零覆盖（用例名与断言不符）
    const inst = makeBareInstance();
    inst._lastCpuTime = { cpu: 1.0, sys: SYS_TOTAL / 100, time: Date.now() - 2000 };
    inst._collectLinuxStats(PID);
    expect(inst._cpuUsage).toBe(0);
  });

  it('系统时间负增量（计数器回退）：瞬时占用率记 0，不出负数', () => {
    const inst = makeBareInstance();
    inst._lastCpuTime = { cpu: 1.0, sys: SYS_TOTAL / 100 + 10, time: Date.now() - 2000 };
    inst._collectLinuxStats(PID);
    expect(inst._cpuUsage).toBe(0);
  });

  it('占用率饱和封顶：增量巨大时不超过 100%', () => {
    const inst = makeBareInstance();
    inst._lastCpuTime = { cpu: 0, sys: 0, time: Date.now() - 1 };
    inst._collectLinuxStats(PID);
    // cpuDiff=110 ticks≈1.1s over 0.001s elapsed → 远超 100% → 封顶
    expect(inst._cpuUsage).toBe(100);
  });

  it('畸形 proc 数据鲁棒性：空 stat/单列 statm/无 cpu 行均归零不撞车', () => {
    const inst = makeBareInstance();
    statFixture = ''; // match 不中 → tokens 空 → utime/stime 解析为 0
    statmFixture = 'garbage'; // 无第二列 → rssPages 0
    procStatFixture = 'intr 123\n'; // 无 cpu 行 → sysTotal 0
    inst._collectLinuxStats(PID);
    expect(inst._cpuUsage).toBe(0); // 首轮基线
    expect(inst._memoryUsage).toBe(0); // 0 页
    // 二次采集：差分全零 → 占用率 0
    inst._collectLinuxStats(PID);
    expect(inst._cpuUsage).toBe(0);
  });

  it('ps 兜底输出非数字：解析失败归零不撞车', () => {
    const inst = makeBareInstance();
    statFixture = null;
    exec.mockImplementation((cmd, cb) => cb(null, 'not-a-number also-bad\n'));
    inst._collectLinuxStats(PID);
    expect(inst._memoryUsage).toBe(0);
    expect(inst._cpuUsage).toBe(0);
  });

  it('statm 读取失败：保留旧内存值，CPU 计算不受影响', () => {
    const inst = makeBareInstance();
    inst._memoryUsage = 0.88;
    inst._lastCpuTime = { cpu: 0.1, sys: 5, time: Date.now() - 2000 }; // 秒口径（10 tick / 500 tick）
    statmFixture = null; // /proc/4242/statm 不存在 → 内层 catch
    inst._collectLinuxStats(PID);
    expect(inst._memoryUsage).toBe(0.88);
    expect(inst._cpuUsage).toBe(50);
  });

  it('stat 读取失败兜底：ps 命令回退采集 rssKB/pcpu', () => {
    const inst = makeBareInstance();
    const perf = collectPerf(inst);
    statFixture = null; // /proc/4242/stat 抛 ENOENT → 外层 catch
    exec.mockImplementation((cmd, cb) => {
      expect(cmd).toContain(`ps -p ${PID}`);
      cb(null, '524288 12.3\n');
    });
    inst._collectLinuxStats(PID);
    // 524288 KB / 1048576 = 0.5 GB；pcpu 12.3%
    expect(inst._memoryUsage).toBe(0.5);
    expect(inst._cpuUsage).toBe(12.3);
    expect(perf).toHaveLength(1);
  });

  it('ps 兜底也失败：静默不广播', () => {
    const inst = makeBareInstance();
    const perf = collectPerf(inst);
    statFixture = null;
    exec.mockImplementation((cmd, cb) => cb(new Error('ps failed'), ''));
    inst._collectLinuxStats(PID);
    expect(perf).toHaveLength(0);
  });
});

describe('_collectMspt：tick query 主路径与 TPS 回退（真实 isRconConnected 链路）', () => {
  function rconEnabledInstance() {
    const inst = makeBareInstance();
    writeServerProperties(inst, { 'enable-rcon': 'true', 'rcon.password': 'fixture-pass' });
    return inst;
  }

  it('RCON 未启用：直接返回不发起查询', async () => {
    const inst = makeBareInstance();
    writeServerProperties(inst, { 'enable-rcon': 'false' });
    stubRconSend(inst, () => 'mean: 1.0 ms');
    await inst._collectMspt();
    expect(inst._rconSend).not.toHaveBeenCalled();
    expect(inst._mspt).toBe(0);
  });

  it('tick query 命中 mean 字段：直接解析 MSPT，不再回退 tps', async () => {
    const inst = rconEnabledInstance();
    stubRconSend(inst, (cmd) => {
      expect(cmd).toBe('tick query');
      return 'Average tick time: 1173141590 ns. Running 2453 ticks behind. mean: 6.25 ms, median: 5.1 ms';
    });
    await inst._collectMspt();
    expect(inst._mspt).toBe(6.25);
    expect(inst._rconSend).toHaveBeenCalledTimes(1);
  });

  it('tick query 无 mean：回退 tps 命令反推 MSPT（20 TPS = 50ms）', async () => {
    const inst = rconEnabledInstance();
    stubRconSend(inst, (cmd) =>
      cmd === 'tick query'
        ? 'Unknown or incomplete command'
        : 'TPS from last 5s, 1m, 5m: 20.0, 19.9, 19.8',
    );
    await inst._collectMspt();
    expect(inst._mspt).toBe(50);
  });

  it('tps 为 0 不更新 MSPT；查询异常静默跳过待下轮重试', async () => {
    const inst = rconEnabledInstance();
    stubRconSend(inst, (cmd) =>
      cmd === 'tick query' ? 'no mean here' : 'TPS from last 5s, 1m, 5m: 0.0, 0.0, 0.0',
    );
    await inst._collectMspt();
    expect(inst._mspt).toBe(0);
    const inst2 = rconEnabledInstance();
    inst2._mspt = 7.5;
    stubRconSend(inst2, async () => {
      throw new Error('rcon timeout');
    });
    await expect(inst2._collectMspt()).resolves.toBeUndefined();
    expect(inst2._mspt).toBe(7.5);
  });

  it('响应为 null/空：mean 与 tps 双双不匹配，MSPT 保持原值', async () => {
    const inst = rconEnabledInstance();
    inst._mspt = 3.3;
    stubRconSend(inst, () => null); // String(null || '') → 两级正则均不命中
    await inst._collectMspt();
    expect(inst._mspt).toBe(3.3);
  });
});

describe('_queryWorldTime / _queryWorldDay：三级时间来源 fallback 链', () => {
  it('MC 26.2+ timeline 命中：minecraft:day 提供时间 + gametime 推算天数', async () => {
    const inst = makeBareInstance();
    stubRconSend(inst, (cmd) => {
      if (cmd === 'time query minecraft:day') return 'Timeline minecraft:day is at 13000 tick(s)';
      if (cmd === 'time query gametime') return 'Time query gametime is at 130000 tick(s)';
      return 'unexpected';
    });
    await expect(inst._queryWorldTime()).resolves.toEqual({ time: 13000, day: 5 });
    expect(inst._rconSend).toHaveBeenCalledTimes(2);
  });

  it('timeline 失败回退旧版 daytime；gametime 不匹配时天数为 null', async () => {
    const inst = makeBareInstance();
    stubRconSend(inst, (cmd) => {
      if (cmd === 'time query minecraft:day') throw new Error('unknown query');
      if (cmd === 'time query daytime') return 'The time is 6500';
      if (cmd === 'time query gametime') return 'garbage response';
      return 'unexpected';
    });
    await expect(inst._queryWorldTime()).resolves.toEqual({ time: 6500, day: null });
  });

  it('前两级均无匹配回退 gametime：% 24000 取当日时间、/ 24000 取天数', async () => {
    const inst = makeBareInstance();
    stubRconSend(inst, (cmd) => {
      if (cmd === 'time query gametime') return 'Time query gametime is at 55000 tick(s)';
      return 'no match';
    });
    await expect(inst._queryWorldTime()).resolves.toEqual({ time: 7000, day: 2 });
  });

  it('三级全部失败返回 null；_queryWorldDay 独立调用解析 gametime 天数', async () => {
    const inst = makeBareInstance();
    stubRconSend(inst, () => 'nothing matches');
    await expect(inst._queryWorldTime()).resolves.toBeNull();
    await expect(inst._queryWorldDay()).resolves.toBeNull();
    const inst2 = makeBareInstance();
    stubRconSend(inst2, (cmd) => {
      if (cmd === 'time query gametime') return 'The time is 24000';
      return 'no';
    });
    await expect(inst2._queryWorldDay()).resolves.toBe(1);
    const inst3 = makeBareInstance();
    stubRconSend(inst3, async () => {
      throw new Error('rcon down');
    });
    await expect(inst3._queryWorldDay()).resolves.toBeNull();
  });
});

describe('_collectWorldState：时间/天气聚合与事件广播', () => {
  it('门控：无进程或未运行直接返回', async () => {
    const inst = makeBareInstance();
    inst.process = null;
    await inst._collectWorldState();
    inst.process = { pid: 4242 };
    inst.isRunning = false;
    await inst._collectWorldState();
    expect(inst._worldTime).toBeNull();
  });

  it('时间/天数变化推送 performanceUpdate；weather.dat 变化推送 weatherUpdate', async () => {
    const inst = makeBareInstance();
    writeServerProperties(inst, { 'enable-rcon': 'true', 'rcon.password': 'fixture-pass' });
    writeWeatherDat(inst, 1, 0); // raining
    stubRconSend(inst, (cmd) => {
      if (cmd === 'time query minecraft:day') return 'Timeline minecraft:day is at 13000 tick(s)';
      if (cmd === 'time query gametime') return 'Time query gametime is at 130000 tick(s)';
      return 'no';
    });
    const perf = collectPerf(inst);
    const weather = [];
    inst.on('weatherUpdate', (e) => weather.push(e));
    await inst._collectWorldState();
    expect(inst._worldTime).toBe(13000);
    expect(inst._worldDay).toBe(5);
    expect(inst._weather).toBe('rain');
    expect(weather).toEqual([{ weather: 'rain' }]);
    expect(perf).toHaveLength(1);
    expect(perf[0].worldTime).toBe(13000);
    expect(perf[0].worldDay).toBe(5);
    // 第二轮无变化：不重复广播
    await inst._collectWorldState();
    expect(perf).toHaveLength(1);
    expect(weather).toHaveLength(1);
    // 天气转雷暴：仅 weatherUpdate，无 performanceUpdate（时间未变）
    writeWeatherDat(inst, 1, 1);
    await inst._collectWorldState();
    expect(weather).toEqual([{ weather: 'rain' }, { weather: 'thunder' }]);
    expect(perf).toHaveLength(1);
  });

  it('仅天数变化也触发广播；时间查询异常被吞不影响天气读取', async () => {
    const inst = makeBareInstance();
    writeServerProperties(inst, { 'enable-rcon': 'true', 'rcon.password': 'fixture-pass' });
    stubRconSend(inst, (cmd) => {
      if (cmd === 'time query minecraft:day') return 'Timeline minecraft:day is at 100 tick(s)';
      if (cmd === 'time query gametime') return 'Time query gametime is at 130000 tick(s)';
      return 'no';
    });
    inst._worldTime = 100;
    inst._worldDay = 1;
    const perf = collectPerf(inst);
    await inst._collectWorldState();
    expect(inst._worldDay).toBe(5);
    expect(perf).toHaveLength(1); // 仅 day 变化 → changed
    // 时间查询链异常：吞掉后天气照常读取
    const inst2 = makeBareInstance();
    stubRconSend(inst2, async () => {
      throw new Error('rcon down');
    });
    writeWeatherDat(inst2, 0, 1);
    const weather = [];
    inst2.on('weatherUpdate', (e) => weather.push(e));
    await expect(inst2._collectWorldState()).resolves.toBeUndefined();
    expect(inst2._worldTime).toBeNull();
    expect(weather).toEqual([{ weather: 'thunder' }]);
  });

  it('RCON 未启用跳过时间查询但仍轮询天气；天气 fixture 缺失不发事件', async () => {
    const inst = makeBareInstance();
    writeServerProperties(inst, { 'enable-rcon': 'false' });
    const rcon = vi.spyOn(inst, '_rconSend').mockImplementation(async () => 'unused');
    const perf = collectPerf(inst);
    const weather = [];
    inst.on('weatherUpdate', (e) => weather.push(e));
    await inst._collectWorldState();
    expect(rcon).not.toHaveBeenCalled();
    expect(weather).toHaveLength(0); // 无 weather.dat/level.dat → null 不更新
    writeWeatherDat(inst, 1, 0);
    await inst._collectWorldState();
    expect(weather).toEqual([{ weather: 'rain' }]);
    expect(perf).toHaveLength(0);
  });
});

describe('_collectPlayerStats：玩家状态采集与错误隔离', () => {
  function makePlayer(name) {
    return { name, ip: '1.2.3.4', totalPlayTime: 0, sessions: [] };
  }

  function fullRconInstance(players) {
    const inst = makeBareInstance();
    writeServerProperties(inst, { 'enable-rcon': 'true', 'rcon.password': 'fixture-pass' });
    inst.players = players;
    inst._rconEnsureConnected = vi.fn(async () => {});
    return inst;
  }

  function stubPlayerQueries(inst, overrides = {}) {
    stubRconSend(inst, (cmd) => {
      if (cmd.includes(' Health'))
        return overrides.health ?? 'Steve has the following entity data: 20.5f';
      if (cmd.includes(' Pos'))
        return overrides.pos ?? 'Steve has the following entity data: [1.5d, 64.0d, 2.5d]';
      if (cmd.includes(' SleepTimer'))
        return overrides.sleep ?? 'Steve has the following entity data: 100';
      return 'unexpected query';
    });
    inst._queryAttribute = vi.fn(async () =>
      overrides.armor === undefined ? 12.5 : overrides.armor,
    );
  }

  it('无在线玩家且入睡计数非零：清零并广播；已为零不重复广播', async () => {
    const inst = makeBareInstance();
    inst._sleepingPlayers = 2;
    const perf = collectPerf(inst);
    await inst._collectPlayerStats();
    expect(inst._sleepingPlayers).toBe(0);
    expect(perf).toHaveLength(1);
    expect(perf[0].sleepingPlayers).toBe(0);
    await inst._collectPlayerStats();
    expect(perf).toHaveLength(1);
  });

  it('RCON 未启用直接返回；连接失败告警后返回不采集', async () => {
    const inst = makeBareInstance();
    writeServerProperties(inst, { 'enable-rcon': 'false' });
    inst.players = new Map([['Steve', makePlayer('Steve')]]);
    inst._rconEnsureConnected = vi.fn(async () => {});
    const rcon = vi.spyOn(inst, '_rconSend').mockImplementation(async () => 'unused');
    await inst._collectPlayerStats();
    expect(rcon).not.toHaveBeenCalled();

    const inst2 = fullRconInstance(new Map([['Steve', makePlayer('Steve')]]));
    inst2._rconEnsureConnected = vi.fn(async () => {
      throw new Error('connect refused');
    });
    const rcon2 = vi.spyOn(inst2, '_rconSend').mockImplementation(async () => 'unused');
    await expect(inst2._collectPlayerStats()).resolves.toBeUndefined();
    expect(rcon2).not.toHaveBeenCalled(); // 连接失败路径不触达 RCON
  });

  it('全链路采集：血量/坐标/护甲/入睡解析、缓存更新、入睡事件与计数广播', async () => {
    const inst = fullRconInstance(new Map([['Steve', makePlayer('Steve')]]));
    stubPlayerQueries(inst);
    const perf = collectPerf(inst);
    const sleeps = [];
    inst.on('playerSleep', (e) => sleeps.push(e));
    await inst._collectPlayerStats();
    // RCON 查询顺序：Health/Pos/SleepTimer 串行 + attribute 护甲
    expect(inst._rconSend.mock.calls.map((c) => c[0])).toEqual([
      'data get entity Steve Health',
      'data get entity Steve Pos',
      'data get entity Steve SleepTimer',
    ]);
    expect(inst._queryAttribute).toHaveBeenCalledTimes(1);
    const player = inst.players.get('Steve');
    expect(player._cachedDetails).toEqual({
      health: 20.5,
      armor: 12.5,
      position: { x: 1.5, y: 64, z: 2.5 },
      isSleeping: true,
    });
    expect(sleeps).toEqual([{ name: 'Steve', sleeping: true }]);
    // _addPlayerEvent 真实走 output-parser 域：入睡事件落玩家事件流
    expect(inst.playerEvents.get('Steve')[0].type).toBe('sleep');
    expect(perf).toHaveLength(1); // sleepingCount 0→1
    expect(perf[0].sleepingPlayers).toBe(1);
    // 第二轮 SleepTimer 归零：起床事件 + 计数回落
    stubPlayerQueries(inst, { sleep: 'Steve has the following entity data: 0' });
    await inst._collectPlayerStats();
    expect(sleeps).toEqual([
      { name: 'Steve', sleeping: true },
      { name: 'Steve', sleeping: false },
    ]);
    // _addPlayerEvent 逆序 unshift（最新事件在前）：起床在前、入睡在后
    const events = inst.playerEvents.get('Steve');
    expect(events.map((e) => e.type)).toEqual(['wake', 'sleep']);
    expect(perf[perf.length - 1].sleepingPlayers).toBe(0);
    // 第三轮状态稳定：无新事件无新广播
    const perfLen = perf.length;
    await inst._collectPlayerStats();
    expect(perf).toHaveLength(perfLen);
  });

  it('单字段查询失败逐项隔离：坐标缺失不写缓存、入睡沿用缓存计数', async () => {
    const inst = fullRconInstance(new Map([['Steve', makePlayer('Steve')]]));
    const perf = collectPerf(inst);
    stubPlayerQueries(inst, {
      pos: async () => {
        throw new Error('query timeout');
      },
      sleep: async () => {
        throw new Error('query timeout');
      },
    });
    inst.players.get('Steve')._cachedDetails = { isSleeping: true, position: { x: 9, y: 9, z: 9 } };
    await inst._collectPlayerStats();
    const details = inst.players.get('Steve')._cachedDetails;
    // Health/armor 正常解析；Pos/SleepTimer 失败保留旧值
    expect(details.health).toBe(20.5);
    expect(details.armor).toBe(12.5);
    expect(details.position).toEqual({ x: 9, y: 9, z: 9 });
    expect(details.isSleeping).toBe(true); // 查询失败 ≠ 起床
    expect(perf[perf.length - 1].sleepingPlayers).toBe(1); // 沿用缓存计入入睡
  });

  it('响应不匹配解析为 null 不覆盖缓存；未知实体 ghost 行跳过缓存写入', async () => {
    const inst = fullRconInstance(new Map([['Steve', makePlayer('Steve')]]));
    stubPlayerQueries(inst, {
      health: 'no entity data here',
      pos: 'no coords here',
      armor: null,
      sleep: 'Steve has the following entity data: 0',
    });
    inst.players.get('Steve')._cachedDetails = {
      health: 18,
      armor: 5,
      position: { x: 1, y: 2, z: 3 },
    };
    const stats = [];
    inst.on('playerStatsUpdate', (e) => stats.push(e));
    await inst._collectPlayerStats();
    const details = inst.players.get('Steve')._cachedDetails;
    // 解析失败/null 值不覆盖既有缓存
    expect(details.health).toBe(18);
    expect(details.armor).toBe(5);
    expect(details.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(stats).toHaveLength(1);
    expect(stats[0].players[0].health).toBeNull();
    expect(stats[0].players[0].armor).toBeNull();
    expect(stats[0].players[0].position).toBeNull();
    expect(stats[0].players[0].isSleeping).toBe(false);

    // players 迭代产出但 get 返回空（退出竞态）：跳过缓存写入仍入 stats
    class GhostMap extends Map {
      get(name) {
        return name === 'Ghost' ? null : super.get(name);
      }
    }
    const inst2 = fullRconInstance(new GhostMap([['Ghost', makePlayer('Ghost')]]));
    const stats2 = [];
    inst2.on('playerStatsUpdate', (e) => stats2.push(e));
    await inst2._collectPlayerStats();
    expect(stats2).toHaveLength(1);
    expect(stats2[0].players[0].name).toBe('Ghost');
  });

  it('多玩家采集：单玩家循环异常隔离跳过，其余玩家照常入列', async () => {
    const inst = fullRconInstance(
      new Map([
        ['Alex', makePlayer('Alex')],
        ['Steve', makePlayer('Steve')],
      ]),
    );
    stubPlayerQueries(inst);
    // Alex 的护甲查询抛错 → 整个玩家跳过（stats 不含 Alex）
    inst._queryAttribute = vi.fn(async (cmd, name) => {
      if (name === 'Alex') throw new Error('attribute query failed');
      return 8;
    });
    const stats = [];
    inst.on('playerStatsUpdate', (e) => stats.push(e));
    await inst._collectPlayerStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].players.map((p) => p.name)).toEqual(['Steve']);
    expect(stats[0].players[0].armor).toBe(8);
    expect(stats[0].players[0].isSleeping).toBe(true);
  });
});

describe('_playerStatsSnapshot：供订阅补发的当前值', () => {
  it('按当前在线名单过滤：离场玩家的旧读数不复活', () => {
    const inst = makeBareInstance();
    inst.players = new Map([
      ['Alice', {}],
      ['Bob', {}],
    ]);
    inst._lastPlayerStats = [
      { name: 'Alice', health: 20 },
      { name: 'Steve', health: 3 }, // 已离场：最近一轮采集时在，现在不在名单里
    ];

    expect(_playerStatsSnapshot.call(inst)).toEqual({ players: [{ name: 'Alice', health: 20 }] });
  });

  it('从未采过 ⇒ null（未知，不是「没有玩家」）', () => {
    const inst = makeBareInstance();
    inst.players = new Map([['Alice', {}]]);
    inst._lastPlayerStats = undefined;

    expect(_playerStatsSnapshot.call(inst)).toBeNull();
  });
});
