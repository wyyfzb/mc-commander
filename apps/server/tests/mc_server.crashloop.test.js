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
  getDb: vi.fn(),
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
import { getDb, InstanceModel } from '../src/db/index.js';
import { MCServerInstance, MCServerManager } from '../src/services/mc_server.js';
import config from '../src/config.js';
import { initDatabase } from '../src/db/database.js';
import { InstanceModel as SqliteInstanceModel } from '../src/db/instance.model.js';

// 构造可受控派发事件的模拟 java 子进程
function makeFakeProcess(pid) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), on: vi.fn() };
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.on('exit', (code) => {
    proc.exitCode = code;
  });
  proc.kill = vi.fn();
  return proc;
}

const DONE = 'Done (1.0s)! For help, type "help"';

function emitOutput(proc, line) {
  proc.stdout.emit('data', Buffer.from(`${line}\n`));
}

function emitReady(proc) {
  emitOutput(proc, `[12:00:00] [Server thread/INFO]: ${DONE}`);
}

describe('MCServerInstance - 进程异常退出与崩溃循环熔断', () => {
  let tmpDir;
  let lastProc;
  let instance;
  let db;

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

  function reloadInstance() {
    return new MCServerManager().getInstance(instance.id);
  }

  function prepareStoredInstance({
    storedCrashCount = 0,
    snapshotCrashCount = storedCrashCount,
    autoStart = true,
    autoRestart = true,
  } = {}) {
    const serversDir = path.join(tmpDir, 'servers');
    vi.spyOn(config, 'dataDir', 'get').mockReturnValue(path.join(tmpDir, 'data'));
    vi.spyOn(config, 'serversDir', 'get').mockReturnValue(serversDir);
    db = initDatabase();
    getDb.mockReturnValue(db);
    for (const key of ['getAll', 'getById', 'update', 'migrateFromJson']) {
      InstanceModel[key].mockImplementation(SqliteInstanceModel[key].bind(SqliteInstanceModel));
    }

    const serverPath = path.join(serversDir, instance.id);
    fs.mkdirSync(serverPath, { recursive: true });
    for (const file of ['eula.txt', 'server.jar']) {
      fs.copyFileSync(path.join(tmpDir, file), path.join(serverPath, file));
    }
    const saved = {
      id: instance.id,
      name: instance.name,
      jarFile: instance.jarFile,
      autoStart,
      autoRestart,
    };
    const snapshotPath = path.join(serverPath, 'instance.json');
    fs.writeFileSync(
      snapshotPath,
      JSON.stringify({ ...saved, circuitBreakerCrashCount: snapshotCrashCount }),
    );
    SqliteInstanceModel.migrateFromJson(
      { ...saved, circuitBreakerCrashCount: storedCrashCount },
      serverPath,
    );
    instance = reloadInstance();
    return snapshotPath;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-crash-'));
    fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(tmpDir, 'server.jar'), '');
    vi.spyOn(MCServerInstance.prototype, '_detectPublicIp').mockResolvedValue(undefined);
    vi.spyOn(MCServerInstance.prototype, 'refreshReachability').mockResolvedValue(undefined);
    getDb.mockReturnValue({ transaction: (callback) => callback });
    spawn.mockReset();
    spawn.mockImplementation(() => {
      lastProc = makeFakeProcess(12344 + spawn.mock.calls.length);
      return lastProc;
    });
    instance = createInstance({ autoRestart: true });
  });

  afterEach(() => {
    instance?.cancelRestart();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    getDb.mockReset();
    for (const key of ['getAll', 'getById', 'update', 'migrateFromJson']) {
      InstanceModel[key].mockReset();
    }
    db?.close();
    db = undefined;
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

    it.each(['SQLite', 'instance.json', 'SQLite 写入失败'])(
      '%s 重建实例后保留熔断与启动偏好',
      async (source) => {
        const snapshotPath = prepareStoredInstance();
        if (source === 'SQLite 写入失败') {
          db.exec(`CREATE TRIGGER deny_trip BEFORE UPDATE OF circuit_breaker_crash_count ON instances
            WHEN NEW.circuit_breaker_crash_count > 0 BEGIN SELECT RAISE(ABORT, '模拟 SQLite 写入失败'); END`);
        }
        await crashAcrossRestarts(5);

        if (source === 'instance.json') SqliteInstanceModel.delete(instance.id);
        if (source === 'SQLite') fs.rmSync(snapshotPath);

        const rebuilt = reloadInstance();
        expect(SqliteInstanceModel.getById(instance.id)).toMatchObject({
          autoStart: true,
          autoRestart: true,
          circuitBreakerCrashCount: source === 'SQLite 写入失败' ? 0 : 5,
        });
        expect(rebuilt.toStatus()).toMatchObject({
          autoStart: true,
          autoRestart: true,
          circuitBreakerTripped: true,
          consecutiveCrashes: 5,
        });
      },
    );

    describe('熔断后的手动试启', () => {
      const { windowMs } = config.crashLoop;
      let resumed;

      function watchResume() {
        resumed = vi.fn();
        instance.on('status', ({ event }) => {
          if (event === 'auto_start_resumed') resumed();
        });
      }

      function prepareMockedTrial() {
        instance = createInstance({ autoRestart: true, circuitBreakerCrashCount: 5 });
        InstanceModel.getById.mockReturnValue({ circuitBreakerCrashCount: 5 });
        InstanceModel.update.mockReturnValue({ id: instance.id });
        watchResume();
      }

      it.each([
        { autoStart: true, autoRestart: false },
        { autoStart: false, autoRestart: true },
      ])('稳定运行后清除两份熔断记录，保留偏好 %j', async (preferences) => {
        const snapshotPath = prepareStoredInstance({ storedCrashCount: 5, ...preferences });
        watchResume();
        instance.start();
        emitReady(lastProc);
        expect(instance.toStatus()).toMatchObject({
          circuitBreakerTripped: true,
          checkingStartupStability: true,
        });

        await vi.advanceTimersByTimeAsync(windowMs - 1);
        expect(resumed).not.toHaveBeenCalled();
        expect(SqliteInstanceModel.getById(instance.id).circuitBreakerCrashCount).toBe(5);
        expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).circuitBreakerCrashCount).toBe(5);

        await vi.advanceTimersByTimeAsync(1);
        expect(resumed).toHaveBeenCalledTimes(1);
        const expectedStatus = {
          ...preferences,
          circuitBreakerTripped: false,
          checkingStartupStability: false,
          consecutiveCrashes: 0,
        };
        expect(instance.toStatus()).toMatchObject(expectedStatus);
        expect(reloadInstance().toStatus()).toMatchObject(expectedStatus);
        expect(SqliteInstanceModel.getById(instance.id)).toMatchObject({
          ...preferences,
          circuitBreakerCrashCount: 0,
        });
        expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))).toMatchObject({
          ...preferences,
          circuitBreakerCrashCount: 0,
        });

        lastProc.emit('exit', 1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(spawn).toHaveBeenCalledTimes(preferences.autoRestart ? 2 : 1);
        expect(instance.toStatus().consecutiveCrashes).toBe(1);
      });

      it('未就绪时不开始观察；就绪后从当时起计算完整窗口', async () => {
        prepareMockedTrial();
        instance.start();
        await vi.advanceTimersByTimeAsync(windowMs);
        expect(instance.toStatus()).toMatchObject({
          circuitBreakerTripped: true,
          checkingStartupStability: false,
        });
        expect(InstanceModel.update).not.toHaveBeenCalled();

        emitReady(lastProc);
        expect(instance.toStatus().checkingStartupStability).toBe(true);
        await vi.advanceTimersByTimeAsync(windowMs - 1);
        expect(InstanceModel.update).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(resumed).toHaveBeenCalledTimes(1);
      });

      it('观察期内退出会取消观察，旧进程迟到的就绪日志不启动下一次观察', async () => {
        prepareMockedTrial();
        instance.start();
        const first = lastProc;
        emitReady(first);
        await vi.advanceTimersByTimeAsync(windowMs - 1);
        first.emit('exit', 1);
        expect(instance.toStatus().checkingStartupStability).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        expect(spawn).toHaveBeenCalledTimes(1);

        instance.start();
        emitReady(first);
        expect(instance.toStatus().checkingStartupStability).toBe(false);
        await vi.advanceTimersByTimeAsync(windowMs);
        expect(instance.circuitBreakerTripped).toBe(true);
        expect(InstanceModel.update).not.toHaveBeenCalled();
        expect(resumed).not.toHaveBeenCalled();
      });

      it('手动停止立即取消观察，等待退出期间的就绪日志也不能重新观察', async () => {
        prepareMockedTrial();
        vi.spyOn(instance, 'stopServer').mockResolvedValue(undefined);
        instance.start();
        emitReady(lastProc);
        await vi.advanceTimersByTimeAsync(windowMs - 1);

        const stopping = instance.stop();
        expect(instance.toStatus()).toMatchObject({
          isRunning: true,
          checkingStartupStability: false,
        });
        emitReady(lastProc);
        expect(instance.toStatus().checkingStartupStability).toBe(false);
        lastProc.emit('exit', 1);
        await stopping;
        await vi.advanceTimersByTimeAsync(windowMs);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(InstanceModel.update).not.toHaveBeenCalled();
        expect(instance.toStatus()).toMatchObject({
          circuitBreakerTripped: true,
          checkingStartupStability: false,
          consecutiveCrashes: 5,
        });
      });

      it.each(['<Steve>', '[Not Secure] <Steve>', '* Steve'])(
        '聊天消息 %s 携带就绪文案也不启动观察',
        async (prefix) => {
          prepareMockedTrial();
          instance.start();
          emitOutput(lastProc, `[12:00:00] [Server thread/INFO]: ${prefix} ${DONE}`);

          expect(instance.toStatus().checkingStartupStability).toBe(false);
          await vi.advanceTimersByTimeAsync(windowMs);
          expect(instance.circuitBreakerTripped).toBe(true);
          expect(InstanceModel.update).not.toHaveBeenCalled();
          expect(resumed).not.toHaveBeenCalled();
        },
      );

      it.each(['SQLite 写入失败', '快照写入失败', '快照 ID 不匹配'])(
        '%s 时保留熔断，不发布恢复事件',
        async (fault) => {
          const snapshotPath = prepareStoredInstance({ storedCrashCount: 5 });
          if (fault === 'SQLite 写入失败') {
            db.exec(`CREATE TRIGGER reject_resume BEFORE UPDATE OF circuit_breaker_crash_count ON instances
              WHEN NEW.circuit_breaker_crash_count = 0 BEGIN SELECT RAISE(ABORT, '模拟 SQLite 写入失败'); END`);
          } else if (fault === '快照写入失败') {
            const rename = fs.renameSync;
            vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
              if (target === snapshotPath) throw new Error('模拟快照原子替换失败');
              return rename(source, target);
            });
          } else {
            // 加载后替换快照，验证复位也会重新核对盘上的 ID。
            fs.writeFileSync(
              snapshotPath,
              JSON.stringify({ id: 'another-instance', circuitBreakerCrashCount: 2 }),
            );
          }
          const snapshotBefore = fs.readFileSync(snapshotPath, 'utf8');
          watchResume();
          instance.start();
          emitReady(lastProc);
          await vi.advanceTimersByTimeAsync(windowMs);

          expect(instance.toStatus()).toMatchObject({
            circuitBreakerTripped: true,
            consecutiveCrashes: 5,
          });
          expect(resumed).not.toHaveBeenCalled();
          expect(SqliteInstanceModel.getById(instance.id).circuitBreakerCrashCount).toBe(5);
          expect(fs.readFileSync(snapshotPath, 'utf8')).toBe(snapshotBefore);
        },
      );

      it('仅快照记录熔断时，提交失败后仍可从 SQLite 重建保护', async () => {
        const snapshotPath = prepareStoredInstance({ snapshotCrashCount: 5 });
        db.exec(`
          CREATE TABLE valid_resume (id INTEGER PRIMARY KEY);
          CREATE TABLE resume_check (id INTEGER REFERENCES valid_resume(id) DEFERRABLE INITIALLY DEFERRED);
          CREATE TRIGGER reject_resume_commit AFTER UPDATE OF circuit_breaker_crash_count ON instances
          WHEN NEW.circuit_breaker_crash_count = 0 BEGIN INSERT INTO resume_check VALUES (1); END;
        `);
        watchResume();
        instance.start();
        emitReady(lastProc);
        await vi.advanceTimersByTimeAsync(windowMs);

        // 延迟外键在提交时检查，快照已替换；回滚后 SQLite 必须独立承载保护。
        expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).circuitBreakerCrashCount).toBe(0);
        expect(SqliteInstanceModel.getById(instance.id).circuitBreakerCrashCount).toBe(5);
        expect(reloadInstance().toStatus()).toMatchObject({
          circuitBreakerTripped: true,
          consecutiveCrashes: 5,
          checkingStartupStability: false,
        });
        expect(instance.toStatus()).toMatchObject({
          circuitBreakerTripped: true,
          consecutiveCrashes: 5,
        });
        expect(resumed).not.toHaveBeenCalled();
      });
    });

    it('窗口内 5 个进程相继崩溃：持久化熔断保护，不修改自动重启偏好', async () => {
      const snapshotPath = path.join(tmpDir, 'instance.json');
      fs.writeFileSync(snapshotPath, JSON.stringify({ id: instance.id, autoRestart: true }));
      const statuses = [];
      const logs = [];
      instance.on('status', (status) => statuses.push(status));
      instance.on('log', ({ text }) => logs.push(text));

      expect(await crashAcrossRestarts(5)).toEqual([1, 2, 3, 4, 5]);
      expect(logs.filter((text) => text.includes('已暂停'))).toEqual([
        '[服务器] 服务器反复退出，已暂停自动启动。',
      ]);
      expect(new Set(spawn.mock.results.map(({ value }) => value)).size).toBe(5);
      expect(statuses.filter((status) => status.event === 'circuit_breaker')).toEqual([
        { event: 'circuit_breaker', consecutiveCrashes: 5, windowMs: 300000 },
      ]);
      expect(
        statuses.filter((status) => status.event === 'crash').map((s) => s.autoRestart),
      ).toEqual([true, true, true, true, false]);
      expect(instance.autoRestart).toBe(true);
      expect(InstanceModel.update.mock.calls).toEqual([
        ['crash-test', { circuitBreakerCrashCount: 5 }],
      ]);
      expect(JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))).toMatchObject({
        autoRestart: true,
        circuitBreakerCrashCount: 5,
      });

      await vi.advanceTimersByTimeAsync(5000);
      expect(spawn).toHaveBeenCalledTimes(5);
    });

    it('手动启动优先于排队的重启，意外退出仍正常计入熔断', async () => {
      await crashAcrossRestarts(4);
      const restarting = instance.restart().catch((err) => err);
      instance.start();
      instance.process.emit('exit', 1);
      expect(instance.circuitBreakerTripped).toBe(true);
      expect(await restarting).toMatchObject({ code: 40915 });

      await vi.advanceTimersByTimeAsync(5000);
      expect(spawn).toHaveBeenCalledTimes(5);
    });

    it('少于阈值时保留窗口计数，超窗后从新崩溃重新起算', async () => {
      expect(await crashAcrossRestarts(3)).toEqual([1, 2, 3]);
      expect(instance.circuitBreakerTripped).toBe(false);

      vi.setSystemTime(Date.now() + 300001);
      await vi.advanceTimersByTimeAsync(5000);
      expect(instance.isRunning).toBe(true);
      instance.process.emit('exit', 1);
      expect(instance._consecutiveCrashes).toBe(1);
      expect(instance.circuitBreakerTripped).toBe(false);
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
      expect(instance.circuitBreakerTripped).toBe(false);
    });

    it('手动试启动失败仍保持熔断，不会排入自动重启', async () => {
      instance = createInstance({ autoRestart: true, circuitBreakerCrashCount: 5 });

      instance.start();
      lastProc.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(5000);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(instance.toStatus()).toMatchObject({
        autoRestart: true,
        circuitBreakerTripped: true,
        consecutiveCrashes: 5,
      });
      expect(InstanceModel.update).not.toHaveBeenCalled();
    });
  });
});
