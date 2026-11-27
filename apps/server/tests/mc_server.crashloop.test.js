import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock 隔离：子进程 / RCON / SQLite 模型（config 用真实值——crashLoop 300s/5 次）──
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

vi.mock('../src/db/index.js', () => ({
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

import { spawn } from 'child_process';
import { InstanceModel } from '../src/db/index.js';
import { MCServerInstance } from '../src/services/mc_server.js';

// 构造可受控派发事件的模拟 java 子进程
function makeFakeProcess(pid) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), on: vi.fn() };
  proc.pid = pid;
  proc.kill = vi.fn();
  return proc;
}

describe('MCServerInstance - 进程异常退出与崩溃循环熔断', () => {
  let tmpDir;
  let lastProc;
  let instance;

  function createInstance(overrides = {}) {
    return new MCServerInstance({
      id: 'crash-test',
      name: 'Crash Test',
      javaPath: 'java',
      jarFile: 'server.jar',
      maxMemory: '2G',
      minMemory: '1G',
      serverPath: tmpDir,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks(); // 清跨用例 mock 调用记录（InstanceModel.update 等）
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crash-'));
    fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(tmpDir, 'server.jar'), '');
    vi.spyOn(MCServerInstance.prototype, '_detectPublicIp').mockResolvedValue(undefined);
    spawn.mockReset();
    spawn.mockImplementation(() => {
      lastProc = makeFakeProcess(12344 + spawn.mock.calls.length);
      return lastProc;
    });
    instance = createInstance({ autoRestart: true });
  });

  afterEach(() => {
    instance.cancelRestart();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("spawn 'error' 事件（启动失败）", () => {
    it('复位运行态：isRunning=false 且 process 置 null', async () => {
      await instance.start();
      expect(instance.isRunning).toBe(true);
      lastProc.emit('error', new Error('spawn java ENOENT'));
      expect(instance.isRunning).toBe(false);
      expect(instance.process).toBeNull();
    });

    it('广播 crash 状态（code=null、autoRestart=false：spawn 失败不自动重启）', async () => {
      await instance.start();
      const statuses = [];
      instance.on('status', (s) => statuses.push(s));
      lastProc.emit('error', new Error('spawn java ENOENT'));
      const crash = statuses.find((s) => s.event === 'crash');
      expect(crash).toEqual({ event: 'crash', code: null, autoRestart: false });
    });

    it('日志流收到「启动失败」消息', async () => {
      await instance.start();
      const logs = [];
      instance.on('log', (l) => logs.push(l));
      lastProc.emit('error', new Error('spawn java ENOENT'));
      const log = logs.find((l) => l.text.includes('启动失败'));
      expect(log).toBeDefined();
      expect(log.type).toBe('stderr');
    });

    it('stdin 管道 error 被消费（不抛 unhandled error）', async () => {
      await instance.start();
      // stdin.on 已注册 error 监听：派发错误不得导致异常
      const stdinErr = new Error('write EPIPE');
      let handled = null;
      lastProc.stdin.on.mock.calls
        .filter(([ev]) => ev === 'error')
        .forEach(([, fn]) => (handled = fn));
      expect(handled).not.toBeNull();
      expect(() => handled(stdinErr)).not.toThrow();
    });
  });

  describe('exit 非零意外退出（crash 路径）', () => {
    it('广播 crash 状态（code、autoRestart=true）', async () => {
      await instance.start();
      const statuses = [];
      instance.on('status', (s) => statuses.push(s));
      lastProc.emit('exit', 1);
      const crash = statuses.find((s) => s.event === 'crash');
      expect(crash).toEqual({ event: 'crash', code: 1, autoRestart: true });
    });

    it('5 秒后自动重启（jar 仍存在时再次 spawn）', async () => {
      await instance.start();
      const statuses = [];
      instance.on('status', (s) => statuses.push(s));
      lastProc.emit('exit', 1);
      expect(instance.isRunning).toBe(false);
      await vi.advanceTimersByTimeAsync(6000);
      expect(spawn).toHaveBeenCalledTimes(2); // 初次启动 + 自动重启
      expect(instance.isRunning).toBe(true);
      const started = statuses.find((s) => s.event === 'started');
      expect(started).toBeDefined(); // 重启成功广播 started
    });

    it('重启窗口内服务器已被拉起 → 放弃自动重启', async () => {
      await instance.start();
      lastProc.emit('exit', 1);
      // 5s 窗口内用户手动再次启动
      await instance.start();
      const spawnCallsBefore = spawn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000);
      expect(spawn.mock.calls.length).toBe(spawnCallsBefore); // 定时器放弃，不再 spawn
    });

    it('jar 被删除（实例已卸载）→ 放弃自动重启', async () => {
      await instance.start();
      lastProc.emit('exit', 1);
      fs.rmSync(path.join(tmpDir, 'server.jar'));
      const spawnCallsBefore = spawn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000);
      expect(spawn.mock.calls.length).toBe(spawnCallsBefore);
    });

    it('主动停止（_manualStop）非零退出不算崩溃：无 crash 状态、无重启', async () => {
      await instance.start();
      const statuses = [];
      instance.on('status', (s) => statuses.push(s));
      instance._manualStop = true;
      lastProc.emit('exit', 1);
      expect(statuses.find((s) => s.event === 'crash')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(6000);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('code=0 正常退出：即使 autoRestart 开启也不触发重启', async () => {
      await instance.start();
      const statuses = [];
      instance.on('status', (s) => statuses.push(s));
      lastProc.emit('exit', 0);
      expect(statuses.find((s) => s.event === 'crash')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(6000);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('崩溃循环熔断（crashLoop 300s 窗口 / 5 次阈值）', () => {
    async function crashAcrossRestarts(count) {
      instance.start();
      const counts = [];
      for (let i = 0; i < count; i++) {
        instance.process.emit('exit', 1);
        counts.push(instance._consecutiveCrashes);
        if (i + 1 < count) await vi.advanceTimersByTimeAsync(5000);
      }
      return counts;
    }

    it('窗口内 5 个进程相继崩溃：自动重启熔断并持久化禁用', async () => {
      const statuses = [];
      instance.on('status', (status) => statuses.push(status));

      expect(await crashAcrossRestarts(5)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(spawn.mock.results.map(({ value }) => value)).size).toBe(5);
      expect(statuses.filter((status) => status.event === 'circuit_breaker')).toEqual([
        { event: 'circuit_breaker', consecutiveCrashes: 5, windowMs: 300000 },
      ]);
      expect(
        statuses.filter((status) => status.event === 'crash').map((s) => s.autoRestart),
      ).toEqual([true, true, true, true, false]);
      expect(instance.autoRestart).toBe(false);
      expect(InstanceModel.update.mock.calls).toEqual([['crash-test', { autoRestart: false }]]);

      await vi.advanceTimersByTimeAsync(5000);
      expect(spawn).toHaveBeenCalledTimes(5);
    });

    it('少于阈值时保留窗口计数，超窗后从新崩溃重新起算', async () => {
      expect(await crashAcrossRestarts(3)).toEqual([1, 2, 3]);
      expect(instance._circuitBreakerTripped).toBe(false);

      vi.setSystemTime(Date.now() + 300001);
      await vi.advanceTimersByTimeAsync(5000);
      expect(instance.isRunning).toBe(true);
      instance.process.emit('exit', 1);
      expect(instance._consecutiveCrashes).toBe(1);
      expect(instance._circuitBreakerTripped).toBe(false);
    });

    it('手动停止不增加或清除窗口内崩溃计数', async () => {
      instance.start();
      instance.process.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(instance._consecutiveCrashes).toBe(1);

      const stoppedProcess = instance.process;
      instance.stopServer = vi.fn().mockResolvedValue(undefined);
      instance.stop();
      stoppedProcess.emit('exit', 1);
      expect(instance._consecutiveCrashes).toBe(1);

      instance.start();
      instance.process.emit('exit', 1);
      expect(instance._consecutiveCrashes).toBe(2);
      expect(instance._circuitBreakerTripped).toBe(false);
    });

    it('启动进程清理不误解除熔断或清空窗口', async () => {
      instance._consecutiveCrashes = 3;
      instance._crashWindowStart = Date.now();
      instance._circuitBreakerTripped = true;
      instance.autoRestart = false;

      instance.start();

      expect(instance._consecutiveCrashes).toBe(3);
      expect(instance._crashWindowStart).not.toBeNull();
      expect(instance._circuitBreakerTripped).toBe(true);
      expect(instance.autoRestart).toBe(false);
    });
  });
});
