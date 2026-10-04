import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock 隔离：子进程 / RCON / SQLite 模型 ──
vi.mock('child_process', () => {
  const spawn = vi.fn();
  const spawnSync = vi.fn();
  const exec = vi.fn();
  return { spawn, spawnSync, exec, default: { spawn, spawnSync, exec } };
});

vi.mock('rcon-client', () => {
  // 生产代码使用 `new Rcon(config)` 手动建连（先注册 error 再 connect），
  // 故 mock 必须是可 new 的构造函数；connect 静态方法保留仅供断言兼容。
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
    getTotalUptime: vi.fn(() => 0),
  },
}));

import { spawn } from 'child_process';
import { Rcon } from 'rcon-client';
import { InstanceModel } from '../db/index.js';
import { shadowProfilePath } from '../utils/player-utils.js';
import { MCServerInstance, MCServerManager } from '../services/mc_server.js';

// 构造一个模拟的 java 子进程（stdout/stderr/stdin/exit 均可控）
function makeFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn() };
  proc.pid = 12345;
  proc.kill = vi.fn();
  return proc;
}

// 构造一个模拟的 rcon-client 客户端
// 注意：真实 rcon-client 4.x 没有 connected getter（值为 undefined），
// 连接建立后 socket 非空、close 事件触发时 socket 置 null。
// fake 必须模拟该行为（socket 属性），不能提供 connected，否则会掩盖连接复用 bug。
// connect 方法对应生产代码 `new Rcon(config)` 后调用的 client.connect()。
function makeFakeRconClient(overrides = {}) {
  return {
    socket: {},
    send: vi.fn().mockResolvedValue(''),
    on: vi.fn(),
    end: vi.fn().mockResolvedValue(),
    connect: vi.fn().mockResolvedValue(),
    ...overrides,
  };
}

// vitest 4：构造函数 mock 不再支持 mockReturnValue；
// 用可构造函数返回实例（new 语义：构造器返回对象时该对象即实例）
function mockRconReturns(client) {
  Rcon.mockImplementation(function () {
    return client;
  });
}

describe('MCServerInstance lifecycle / RCON / stats timers', () => {
  let tmpDir;
  let lastProc;

  function createInstance(overrides = {}) {
    return new MCServerInstance({
      id: 'test-lifecycle',
      name: 'Lifecycle Test',
      javaPath: 'java',
      jarFile: 'server.jar',
      maxMemory: '2G',
      minMemory: '1G',
      serverPath: tmpDir,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lifecycle-'));
    fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(tmpDir, 'server.jar'), '');
    // 阻断公网 IP 探测的真实网络请求
    vi.spyOn(MCServerInstance.prototype, '_detectPublicIp').mockResolvedValue(undefined);
    lastProc = null;
    spawn.mockReset();
    spawn.mockImplementation(() => {
      lastProc = makeFakeProcess();
      return lastProc;
    });
    Rcon.mockReset();
    // 默认：new Rcon(config) 返回标准 fake client（connect 立即 resolve）。
    // 需要定制 send 返回/连接失败/连接挂起的测试再单独 mockRconReturns 覆盖。
    mockRconReturns(makeFakeRconClient());
    Rcon.connect.mockReset();
    InstanceModel.addUptime.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ══════════════════════════════════════════
  // 进程生命周期：start
  // ══════════════════════════════════════════
  describe('start', () => {
    it('spawns java process with memory args and marks instance running', () => {
      const instance = createInstance();
      const statusEvents = [];
      instance.on('status', (e) => statusEvents.push(e));

      instance.start();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        'java',
        ['-Xmx2G', '-Xms1G', '-jar', path.join(tmpDir, 'server.jar'), 'nogui'],
        expect.objectContaining({ cwd: tmpDir }),
      );
      expect(instance.isRunning).toBe(true);
      expect(instance.startTime).not.toBeNull();
      expect(statusEvents).toContainEqual({ event: 'started' });
    });

    it('uses custom start command when provided', () => {
      const instance = createInstance();
      instance.start('java -Xmx4G -jar custom.jar nogui');

      expect(spawn).toHaveBeenCalledWith(
        'java',
        ['-Xmx4G', '-jar', 'custom.jar', 'nogui'],
        expect.objectContaining({ cwd: tmpDir }),
      );
    });

    it('restart 后 stop：延迟启动被取消，不再拉起服务器', () => {
      const instance = createInstance();
      instance.start(); // spawn 1 次，isRunning=true

      instance.restart(); // 发送 stop 命令 + 调度 3 秒后 start
      expect(instance._restartTimer).toBeTruthy();

      // 用户明确停止：取消待执行的延迟启动
      instance.stop();
      vi.advanceTimersByTime(3000);

      expect(spawn).toHaveBeenCalledTimes(1); // 修复前：2（3 秒后又 start）
    });

    it('restart 后 kill：延迟启动被取消，不再拉起服务器', () => {
      const instance = createInstance();
      instance.start();
      lastProc.emit('exit', 0); // 正常退出，isRunning=false

      instance.restart(); // 调度 3 秒后 start
      // 用户明确强杀
      instance.kill();
      vi.advanceTimersByTime(3000);

      expect(spawn).toHaveBeenCalledTimes(1); // 修复前：2
    });

    it('spawn error（javaPath 不存在等）不崩溃且置实例错误态', () => {
      const instance = createInstance();
      const statusEvents = [];
      instance.on('status', (e) => statusEvents.push(e));
      const logs = [];
      instance.on('log', (l) => logs.push(l));

      instance.start();
      expect(instance.isRunning).toBe(true);

      // 模拟 spawn 失败：可执行文件不存在时 child_process 会 emit 'error'
      // 而非 'exit'。修复前无 error 监听 → EventEmitter 抛未捕获异常
      // （unhandled 'error' event 使整个服务端进程崩溃）。
      expect(() => lastProc.emit('error', new Error('spawn java ENOENT'))).not.toThrow();

      expect(instance.isRunning).toBe(false);
      expect(instance.process).toBeNull();
      expect(statusEvents).toContainEqual(expect.objectContaining({ event: 'crash' }));
      expect(logs.some((l) => l.text.includes('启动失败'))).toBe(true);
    });

    it('uses instance startCommand when start() called without args（启动参数不同步回归测试）', () => {
      const instance = createInstance({
        startCommand: 'java -Xmx3G -XX:+UseG1GC -jar server.jar nogui',
      });
      // restart/自动重启/任务调度器均调用 start() 不传参，应使用实例配置的 startCommand
      instance.start();

      expect(spawn).toHaveBeenCalledWith(
        'java',
        ['-Xmx3G', '-XX:+UseG1GC', '-jar', 'server.jar', 'nogui'],
        expect.objectContaining({ cwd: tmpDir }),
      );
    });

    it('throws when server is already running', () => {
      const instance = createInstance();
      instance.start();
      expect(() => instance.start()).toThrow('Server is already running');
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('throws EULA_NOT_ACCEPTED when eula.txt is missing', () => {
      fs.unlinkSync(path.join(tmpDir, 'eula.txt'));
      const instance = createInstance();
      expect(() => instance.start()).toThrow('EULA_NOT_ACCEPTED');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('throws EULA_NOT_ACCEPTED when eula.txt is not accepted', () => {
      fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=false\n');
      const instance = createInstance();
      expect(() => instance.start()).toThrow('EULA_NOT_ACCEPTED');
    });

    it('throws when jar file does not exist', () => {
      fs.unlinkSync(path.join(tmpDir, 'server.jar'));
      const instance = createInstance();
      expect(() => instance.start()).toThrow('Jar file not found');
    });

    it('pipes stdout into log buffer and parses player events', () => {
      const instance = createInstance();
      instance.start();

      lastProc.stdout.emit(
        'data',
        Buffer.from('[12:00:00] [Server thread/INFO]: Steve joined the game\n'),
      );

      expect(instance.logBuffer.length).toBe(1);
      expect(instance.players.has('Steve')).toBe(true);
    });
  });

  // ══════════════════════════════════════════
  // 进程生命周期：stop / kill / exit
  // ══════════════════════════════════════════
  describe('stop', () => {
    it('sends stop command to process stdin', () => {
      const instance = createInstance();
      instance.start();
      instance.stop();
      expect(lastProc.stdin.write).toHaveBeenCalledWith('stop\n');
    });

    it('throws when server is not running', () => {
      const instance = createInstance();
      expect(() => instance.stop()).toThrow('Server is not running');
    });

    it('cleans up state on process exit', () => {
      const instance = createInstance();
      instance.start();
      instance.players.set('Alice', {
        name: 'Alice',
        joinTime: Date.now() - 60000,
        totalPlayTime: 0,
      });

      const statusEvents = [];
      instance.on('status', (e) => statusEvents.push(e));

      lastProc.emit('exit', 0);

      expect(instance.isRunning).toBe(false);
      expect(instance.process).toBeNull();
      expect(instance.players.size).toBe(0);
      expect(statusEvents).toContainEqual({ event: 'stopped', code: 0 });
      // 在线玩家数据已持久化（累加在线时长）
      const saved = JSON.parse(
        fs.readFileSync(shadowProfilePath({ serverPath: tmpDir, playerName: 'Alice' }), 'utf-8'),
      );
      expect(saved.totalPlayTime).toBe(60);
      // 累计运行时长写入数据库
      expect(InstanceModel.addUptime).toHaveBeenCalledWith('test-lifecycle', expect.any(Number));
    });

    it('kill sends SIGKILL and cleans up rcon', () => {
      const instance = createInstance();
      instance.start();
      const proc = lastProc;
      const client = makeFakeRconClient();
      instance._rconClient = client;

      instance.kill();

      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(client.end).toHaveBeenCalled();
      expect(instance._rconClient).toBeNull();
    });
  });

  describe('restart', () => {
    it('stops running server then starts again after 3s delay', () => {
      const instance = createInstance();
      instance.start();
      const firstProc = lastProc;

      instance.restart();
      expect(firstProc.stdin.write).toHaveBeenCalledWith('stop\n');

      // 模拟服务器在 3 秒内退出
      firstProc.emit('exit', 0);
      expect(instance.isRunning).toBe(false);

      vi.advanceTimersByTime(3000);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(instance.isRunning).toBe(true);
    });

    it('starts directly when server is not running', () => {
      const instance = createInstance();
      instance.restart();
      expect(spawn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3000);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(instance.isRunning).toBe(true);
    });

    it('swallows start failure when server did not exit within 3s', () => {
      const instance = createInstance();
      instance.start();
      instance.restart();

      // 服务器未退出，3 秒后 start() 抛出 already running，被内部捕获
      expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(instance.isRunning).toBe(true);
    });
  });

  // ══════════════════════════════════════════
  // RCON 通信与超时处理
  // ══════════════════════════════════════════
  describe('RCON communication', () => {
    function createRconInstance() {
      const instance = createInstance();
      instance.isRunning = true;
      instance.process = makeFakeProcess();
      instance.properties = {
        'enable-rcon': 'true',
        'rcon.password': 'secret',
        'rcon.port': '25575',
      };
      return instance;
    }

    it('sends command via rcon-client when connected', async () => {
      const instance = createRconInstance();
      const client = makeFakeRconClient({
        send: vi.fn().mockResolvedValue('There are 0 of a max of 20 players online'),
      });
      mockRconReturns(client);

      const result = await instance.sendCommandWithResponse('list');

      expect(result).toBe('There are 0 of a max of 20 players online');
      expect(Rcon).toHaveBeenCalledWith(
        expect.objectContaining({
          host: '127.0.0.1',
          port: 25575,
          password: 'secret',
          timeout: 5000,
        }),
      );
      expect(client.send).toHaveBeenCalledWith('list');
    });

    it('strips leading slash before sending via rcon', async () => {
      const instance = createRconInstance();
      const client = makeFakeRconClient();
      mockRconReturns(client);

      await instance.sendCommandWithResponse('/say hello');
      expect(client.send).toHaveBeenCalledWith('say hello');
    });

    it('rejects when rcon connect times out and allows retry', async () => {
      const instance = createRconInstance();
      // new Rcon 返回连接失败的 client（connect reject）
      mockRconReturns(
        makeFakeRconClient({
          connect: vi.fn().mockRejectedValue(new Error('Connection timeout')),
        }),
      );

      await expect(instance.sendCommandWithResponse('list')).rejects.toThrow('Connection timeout');
      // 连接失败后清理 in-flight 状态，下次调用可重连
      expect(instance._rconConnecting).toBeNull();
      expect(instance._rconClient).toBeNull();

      const client = makeFakeRconClient({ send: vi.fn().mockResolvedValue('ok') });
      mockRconReturns(client);
      await expect(instance.sendCommandWithResponse('list')).resolves.toBe('ok');
    });

    it('rejects when rcon send times out', async () => {
      const instance = createRconInstance();
      const client = makeFakeRconClient({
        send: vi.fn().mockRejectedValue(new Error('Timeout for packet id 5')),
      });
      mockRconReturns(client);

      await expect(instance.sendCommandWithResponse('list')).rejects.toThrow(
        'Timeout for packet id 5',
      );
    });

    it('reuses in-flight connection promise for concurrent calls', async () => {
      const instance = createRconInstance();
      let resolveConnect;
      // new Rcon 返回 connect 挂起（等待 resolveConnect）的 client
      mockRconReturns(
        makeFakeRconClient({
          connect: vi.fn(
            () =>
              new Promise((res) => {
                resolveConnect = res;
              }),
          ),
        }),
      );

      const p1 = instance._rconEnsureConnected();
      const p2 = instance._rconEnsureConnected();
      expect(Rcon).toHaveBeenCalledTimes(1);

      resolveConnect();
      await Promise.all([p1, p2]);
      expect(instance._rconClient).not.toBeNull();
    });

    it('clears client reference when connection ends unexpectedly', async () => {
      const instance = createRconInstance();
      const handlers = {};
      const client = makeFakeRconClient({
        on: vi.fn((event, fn) => {
          handlers[event] = fn;
        }),
      });
      mockRconReturns(client);

      await instance._rconEnsureConnected();
      expect(instance._rconClient).toBe(client);

      handlers.end();
      expect(instance._rconClient).toBeNull();
    });

    it('reuses established rcon connection across calls（连接泄漏回归测试）', async () => {
      const instance = createRconInstance();
      const client = makeFakeRconClient();
      mockRconReturns(client);

      // 首次建立连接
      await instance._rconEnsureConnected();
      // 后续多次调用必须复用同一连接，不得新建（修复前 connected 为 undefined 导致每次新建）
      await instance._rconEnsureConnected();
      await instance._rconEnsureConnected();
      await instance._rconEnsureConnected();
      await instance.sendCommandWithResponse('list');

      expect(Rcon).toHaveBeenCalledTimes(1);
      expect(client.send).toHaveBeenCalledWith('list');
    });

    it('registers error handler before connecting（MC 崩溃防 node 进程崩溃回归测试）', async () => {
      const instance = createRconInstance();
      const order = [];
      const client = makeFakeRconClient({
        on: vi.fn((event) => {
          order.push(`on:${event}`);
        }),
        connect: vi.fn(async () => {
          order.push('connect');
        }),
      });
      mockRconReturns(client);

      await instance._rconEnsureConnected();

      // on('error') 必须先于 connect() 注册。否则 MC 崩溃导致连接期间
      // socket ECONNRESET 会触发 "Unhandled 'error' event"，使整个 node 进程崩溃，
      // 自动重启 setTimeout 随之丢失。
      expect(order.indexOf('on:error')).toBeLessThan(order.indexOf('connect'));
    });

    it('rejects immediately when server is not running', async () => {
      const instance = createInstance();
      await expect(instance.sendCommandWithResponse('list')).rejects.toThrow(
        'Server is not running',
      );
    });

    it('records user commands to log stream as "> command"（终端命令回显）', async () => {
      const instance = createRconInstance();
      const client = makeFakeRconClient();
      mockRconReturns(client);
      const logEvents = [];
      instance.on('log', (e) => logEvents.push(e));

      await instance.sendCommand('say hello');

      expect(logEvents.some((e) => e.type === 'command' && e.text === '> say hello')).toBe(true);
      expect(client.send).toHaveBeenCalledWith('say hello');
    });

    it('filters RCON noise but keeps [Rcon: feedback in terminal logs', () => {
      const instance = createInstance();
      instance.start();
      const logEvents = [];
      instance.on('log', (e) => logEvents.push(e));

      lastProc.stdout.emit(
        'data',
        Buffer.from(
          '[01:00:00] [RCON Listener #1/INFO]: Thread RCON Listener started\n' +
            '[01:00:01] [Server thread/INFO]: [Rcon: Teleported Steve to 100, 64, 100]\n' +
            '[01:00:02] [Server thread/INFO]: Normal log line\n',
        ),
      );

      const texts = logEvents.map((e) => e.text);
      expect(texts.some((t) => t.includes('Teleported Steve'))).toBe(true);
      expect(texts.some((t) => t.includes('Thread RCON Listener started'))).toBe(false);
      expect(texts.some((t) => t.includes('Normal log line'))).toBe(true);
    });
  });

  describe('无第二通道时的命令回执（RCON 未连接）', () => {
    function createStdinInstance() {
      const instance = createInstance();
      instance.isRunning = true;
      instance.process = makeFakeProcess();
      instance.properties = {}; // RCON 未启用
      return instance;
    }

    it('RCON 未连接：立即明确报错，不写 stdin、不留挂起 Promise、不空等超时', async () => {
      const instance = createStdinInstance();

      const promise = instance.sendCommandWithResponse('list', { timeout: 5000 });
      const expectation = expect(promise).rejects.toThrow(
        'Command response unavailable: RCON is not connected',
      );

      // 曾经这里会往 stdin 写一条需要配套 Mod 的自造协议行（那个 Mod 不存在）
      expect(instance.process.stdin.write).not.toHaveBeenCalled();
      expect(instance._commandResponsePromises).toBeUndefined();

      await expectation;
      // 不挂计时器：错误是即刻给出的，不是等出来的
      expect(vi.getTimerCount()).toBe(0);
    });

    it('该错误与「命令超时」可区分（调用方据此判因，不必猜）', async () => {
      const instance = createStdinInstance();
      const err = await instance.sendCommandWithResponse('list').catch((e) => e);
      expect(err.message).not.toContain('Command timeout');
    });
  });

  // ══════════════════════════════════════════
  // 定时采集的启停
  // ══════════════════════════════════════════
  describe('stats collection timers', () => {
    it('creates all collection timers on start', async () => {
      const instance = createInstance();
      instance.start();
      // 世界状态采集首轮立即执行（启动即采集），完成后才经 _scheduleWorldState
      // 续链（递归 setTimeout 串行化），故首轮完成（微任务）后才有下一轮定时器句柄
      await vi.advanceTimersByTimeAsync(0);

      expect(instance._statsTimer).not.toBeNull();
      expect(instance._msptTimer).not.toBeNull();
      expect(instance._playerStatsTimer).not.toBeNull();
      expect(instance._worldStateTimer).not.toBeNull();
      expect(instance._saveTimer).not.toBeNull();
    });

    it('新一轮运行复位采集告警位（否则上一轮的告警位会让新进程首个失败静默）', () => {
      const instance = createInstance();
      instance._win32StatsError = true; // 上一轮持续失败留下的状态
      instance._initializeRuntimeState();
      expect(instance._win32StatsError).toBe(false);
    });

    it('invokes collectors on their schedules', async () => {
      const instance = createInstance();
      const statsSpy = vi.spyOn(instance, '_collectStats').mockImplementation(() => {});
      const msptSpy = vi.spyOn(instance, '_collectMspt').mockResolvedValue();
      const playerSpy = vi.spyOn(instance, '_collectPlayerStats').mockResolvedValue();
      const worldSpy = vi.spyOn(instance, '_collectWorldState').mockResolvedValue();

      instance._startStatsCollection();
      // 启动时立即触发一次统计与世界状态采集
      expect(statsSpy).toHaveBeenCalledTimes(1);
      expect(worldSpy).toHaveBeenCalledTimes(1);

      // 玩家状态采集为递归 setTimeout 串行化（异步），用 advanceTimersByTimeAsync
      // 让微任务（回调 await 完成 → 续链）在时间推进间 flush
      await vi.advanceTimersByTimeAsync(5000);
      expect(statsSpy).toHaveBeenCalledTimes(2);
      // 玩家状态采集间隔为 5s，t=5s 时已调用 1 次
      expect(playerSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000); // t=10s
      expect(playerSpy).toHaveBeenCalledTimes(2);
      expect(worldSpy).toHaveBeenCalledTimes(2);
      expect(msptSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20000); // t=30s
      expect(msptSpy).toHaveBeenCalledTimes(1);
    });

    it('玩家状态采集串行化：上一轮未完成（RCON 卡顿）不启动下一轮', async () => {
      const instance = createInstance();
      // 玩家在线 + RCON 已配置，使 _collectPlayerStats 进入 RCON 查询
      instance._parseOutput('[12:00:00] [Server thread/INFO]: Steve joined the game');
      instance.properties = {
        'enable-rcon': 'true',
        'rcon.password': 'secret',
        'rcon.port': '25575',
      };
      // 无关采集器 mock 掉（它们也走 _rconSend，会污染计数）
      vi.spyOn(instance, '_collectStats').mockImplementation(() => {});
      vi.spyOn(instance, '_collectWorldState').mockResolvedValue();
      vi.spyOn(instance, '_collectMspt').mockResolvedValue();
      // 在线名单对账同样走 _rconSend（`list`）；本用例只数玩家状态采集的调用
      vi.spyOn(instance, '_reconcilePlayers').mockResolvedValue();
      // RCON 查询挂起：模拟 RCON 卡顿（单轮执行时长 > 5s）
      let release;
      const gate = new Promise((res) => {
        release = res;
      });
      const sendSpy = vi.spyOn(instance, '_rconSend').mockImplementation(() => gate);

      instance.start(); // 内部置 isRunning=true 并启动采集调度
      // 第一轮在 5s 后触发
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendSpy).toHaveBeenCalled();
      const callsAfterFirstRound = sendSpy.mock.calls.length;

      // 推进 10s（两个间隔）：修复前 setInterval 无视未完成的回调继续发新一轮
      // （多轮 RCON 查询并发压向服务器）；修复后递归 setTimeout 等待本轮完成
      await vi.advanceTimersByTimeAsync(10000);
      expect(sendSpy.mock.calls.length).toBe(callsAfterFirstRound);

      // 释放 RCON 查询：本轮完成后调度下一轮
      release();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendSpy.mock.calls.length).toBeGreaterThan(callsAfterFirstRound);

      sendSpy.mockRestore();
      instance._stopStatsCollection();
    });

    it('stops all timers and prevents further collection', () => {
      const instance = createInstance();
      const statsSpy = vi.spyOn(instance, '_collectStats').mockImplementation(() => {});
      vi.spyOn(instance, '_collectMspt').mockResolvedValue();
      vi.spyOn(instance, '_collectPlayerStats').mockResolvedValue();
      vi.spyOn(instance, '_collectWorldState').mockResolvedValue();

      instance._startStatsCollection();
      instance._stopStatsCollection();

      expect(instance._statsTimer).toBeNull();
      expect(instance._msptTimer).toBeNull();
      expect(instance._playerStatsTimer).toBeNull();
      expect(instance._worldStateTimer).toBeNull();

      vi.advanceTimersByTime(60000);
      expect(statsSpy).toHaveBeenCalledTimes(1); // 仅启动时的立即触发
    });

    it('restarting collection does not leak previous timers', () => {
      const instance = createInstance();
      vi.spyOn(instance, '_collectStats').mockImplementation(() => {});
      vi.spyOn(instance, '_collectWorldState').mockResolvedValue();

      instance._startStatsCollection();
      instance._startStatsCollection();

      // 两次启动只保留一组定时器（4 个：统计 interval + MSPT/玩家状态/在线名单
      // 对账三条递归 setTimeout；世界状态首轮立即执行，在途首轮为 promise 而非
      // 定时器，续链句柄在首轮完成后才创建，且 stop 代际 epoch 会作废旧链续链）
      expect(vi.getTimerCount()).toBe(4);
      instance._stopStatsCollection();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears all timers when process exits', () => {
      const instance = createInstance();
      instance.start();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      lastProc.emit('exit', 0);

      expect(instance._statsTimer).toBeNull();
      expect(instance._msptTimer).toBeNull();
      expect(instance._saveTimer).toBeNull();
      expect(instance._playerStatsTimer).toBeNull();
      expect(instance._worldStateTimer).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('collects mspt via rcon only when connected', async () => {
      const instance = createInstance();
      const sendSpy = vi.spyOn(instance, '_rconSend').mockResolvedValue('');

      // 未连接 RCON：跳过
      await instance._collectMspt();
      expect(sendSpy).not.toHaveBeenCalled();

      // 已连接 RCON：发送 tick query 或 tps
      instance.isRunning = true;
      instance.properties = { 'enable-rcon': 'true', 'rcon.password': 'x' };
      await instance._collectMspt();
      expect(sendSpy).toHaveBeenCalledWith(expect.stringMatching(/^(tick query|tps)$/));
    });

    it('collects mspt by parsing tick query rcon response', async () => {
      const instance = createInstance();
      instance.isRunning = true;
      instance.properties = { 'enable-rcon': 'true', 'rcon.password': 'x' };
      // Paper/Vanilla 1.20.3+ 的 tick query 输出：mean 字段直接给出 MSPT
      vi.spyOn(instance, '_rconSend').mockResolvedValue(
        'Server tick times (avg/min/max): 1.0/1.0/2.0 ms, mean: 15.25 ms, median: 15.0 ms',
      );

      await instance._collectMspt();

      // 修复前：命令响应被丢弃（"在日志流中解析"但 RCON 输出不回显 stdout），
      // _mspt 恒为 0
      expect(instance._mspt).toBeCloseTo(15.25, 2);
    });

    it('falls back to tps command when tick query unavailable', async () => {
      const instance = createInstance();
      instance.isRunning = true;
      instance.properties = { 'enable-rcon': 'true', 'rcon.password': 'x' };
      const sendSpy = vi.spyOn(instance, '_rconSend');
      sendSpy.mockResolvedValueOnce('Unknown or incomplete command'); // 无 tick 命令
      sendSpy.mockResolvedValueOnce('TPS from last 5s, 1m, 5m: 10.0, 12.0, 15.0');

      await instance._collectMspt();

      expect(sendSpy).toHaveBeenNthCalledWith(1, 'tick query');
      expect(sendSpy).toHaveBeenNthCalledWith(2, 'tps');
      // 10 TPS → 每 tick 100ms
      expect(instance._mspt).toBeCloseTo(100, 1);
    });

    it('does not crash when mspt commands unavailable (vanilla old)', async () => {
      const instance = createInstance();
      instance.isRunning = true;
      instance.properties = { 'enable-rcon': 'true', 'rcon.password': 'x' };
      vi.spyOn(instance, '_rconSend').mockResolvedValue('Unknown or incomplete command');

      await expect(instance._collectMspt()).resolves.toBeUndefined();
      expect(instance._mspt).toBe(0);
    });
  });

  // ══════════════════════════════════════════
  // 入睡统计采集：_collectPlayerStats
  // ══════════════════════════════════════════
  describe('player stats / sleeping detection', () => {
    function createPlayerInstance() {
      const instance = createInstance();
      instance.isRunning = true;
      instance.process = makeFakeProcess();
      instance.properties = {
        'enable-rcon': 'true',
        'rcon.password': 'secret',
        'rcon.port': '25575',
      };
      return instance;
    }

    it('clears sleeping count and emits when no players online', async () => {
      const instance = createPlayerInstance();
      instance._sleepingPlayers = 2; // 残留计数
      const perfSpy = vi.spyOn(instance, '_emitPerformance');

      await instance._collectPlayerStats();

      expect(instance._sleepingPlayers).toBe(0);
      expect(perfSpy).toHaveBeenCalledTimes(1);
    });

    it('does not emit when sleeping count already zero and no players', async () => {
      const instance = createPlayerInstance();
      instance._sleepingPlayers = 0;
      const perfSpy = vi.spyOn(instance, '_emitPerformance');

      await instance._collectPlayerStats();

      expect(perfSpy).not.toHaveBeenCalled();
    });

    it('skips collection when RCON disabled', async () => {
      const instance = createPlayerInstance();
      instance.properties = { 'enable-rcon': 'false' };
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      const sendSpy = vi.spyOn(instance, '_rconSend');

      await instance._collectPlayerStats();

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('skips collection when RCON connect fails', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      vi.spyOn(instance, '_rconEnsureConnected').mockRejectedValue(new Error('connect failed'));
      const sendSpy = vi.spyOn(instance, '_rconSend');
      const consoleSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.warn 走 stderr

      await instance._collectPlayerStats();

      expect(sendSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('RCON connect failed'));
      consoleSpy.mockRestore();
    });

    it('detects sleeping player when SleepTimer > 0', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      Rcon.connect.mockResolvedValue(makeFakeRconClient());
      vi.spyOn(instance, '_rconSend')
        .mockResolvedValueOnce('Steve has the following entity data: 20.0f') // Health
        .mockResolvedValueOnce('Steve has the following entity data: [1.0d, 64.0d, 2.0d]') // Pos
        .mockResolvedValueOnce('Steve has the following entity data: 100'); // SleepTimer
      const statsSpy = vi.fn();
      instance.on('playerStatsUpdate', statsSpy);

      await instance._collectPlayerStats();

      expect(instance._sleepingPlayers).toBe(1);
      expect(statsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          players: [expect.objectContaining({ name: 'Steve', isSleeping: true })],
        }),
      );
    });

    it('detects awake player when SleepTimer = 0', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      Rcon.connect.mockResolvedValue(makeFakeRconClient());
      vi.spyOn(instance, '_rconSend')
        .mockResolvedValueOnce('Steve has the following entity data: 20.0f')
        .mockResolvedValueOnce('Steve has the following entity data: [1.0d, 64.0d, 2.0d]')
        .mockResolvedValueOnce('Steve has the following entity data: 0');

      await instance._collectPlayerStats();

      expect(instance._sleepingPlayers).toBe(0);
    });

    it('emits performanceUpdate when sleeping count changes', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      instance._sleepingPlayers = 0;
      Rcon.connect.mockResolvedValue(makeFakeRconClient());
      vi.spyOn(instance, '_rconSend')
        .mockResolvedValueOnce('Steve has the following entity data: 20.0f')
        .mockResolvedValueOnce('Steve has the following entity data: [1.0d, 64.0d, 2.0d]')
        .mockResolvedValueOnce('Steve has the following entity data: 100');
      const perfSpy = vi.fn();
      instance.on('performanceUpdate', perfSpy);

      await instance._collectPlayerStats();

      expect(instance._sleepingPlayers).toBe(1);
      expect(perfSpy).toHaveBeenCalledWith(expect.objectContaining({ sleepingPlayers: 1 }));
    });

    it('does not emit performanceUpdate when sleeping count unchanged', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      instance._sleepingPlayers = 1;
      Rcon.connect.mockResolvedValue(makeFakeRconClient());
      vi.spyOn(instance, '_rconSend')
        .mockResolvedValueOnce('Steve has the following entity data: 20.0f')
        .mockResolvedValueOnce('Steve has the following entity data: [1.0d, 64.0d, 2.0d]')
        .mockResolvedValueOnce('Steve has the following entity data: 100');
      const perfSpy = vi.fn();
      instance.on('performanceUpdate', perfSpy);

      await instance._collectPlayerStats();

      expect(instance._sleepingPlayers).toBe(1);
      expect(perfSpy).not.toHaveBeenCalled();
    });

    it('handles MC 26.x short suffix format (e.g. "100s")', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      Rcon.connect.mockResolvedValue(makeFakeRconClient());
      // MC 26.x+ 可能返回带类型后缀的 NBT 格式
      vi.spyOn(instance, '_rconSend')
        .mockResolvedValueOnce('Steve has the following entity data: 20.0f')
        .mockResolvedValueOnce('Steve has the following entity data: [1.0d, 64.0d, 2.0d]')
        .mockResolvedValueOnce('Steve has the following entity data: 100s');

      await instance._collectPlayerStats();

      expect(instance._sleepingPlayers).toBe(1);
    });

    it('skips individual player when RCON query fails', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      instance.players.set('Alex', { name: 'Alex', joinTime: Date.now(), totalPlayTime: 0 });
      Rcon.connect.mockResolvedValue(makeFakeRconClient());
      const consoleSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.warn 走 stderr
      // Steve 的 SleepTimer 查询失败，Alex 正常入睡
      vi.spyOn(instance, '_rconSend')
        .mockResolvedValueOnce('Steve has the following entity data: 20.0f')
        .mockResolvedValueOnce('Steve has the following entity data: [1.0d, 64.0d, 2.0d]')
        .mockRejectedValueOnce(new Error('RCON timeout')) // Steve SleepTimer fail
        .mockResolvedValueOnce('Steve has the following entity data: 8.0f') // Steve Armor
        .mockResolvedValueOnce('Alex has the following entity data: 20.0f')
        .mockResolvedValueOnce('Alex has the following entity data: [3.0d, 64.0d, 4.0d]')
        .mockResolvedValueOnce('Alex has the following entity data: 100')
        .mockResolvedValueOnce('Alex has the following entity data: 7.0f'); // Alex Armor

      await instance._collectPlayerStats();

      // Alex 入睡，Steve 未计入
      expect(instance._sleepingPlayers).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('SleepTimer query failed for Steve'),
      );
      consoleSpy.mockRestore();
    });

    it('handles player with no SleepTimer field gracefully', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      Rcon.connect.mockResolvedValue(makeFakeRconClient());
      // 某些情况下服务器返回错误（字段不存在）
      vi.spyOn(instance, '_rconSend')
        .mockResolvedValueOnce('Steve has the following entity data: 20.0f')
        .mockResolvedValueOnce('Steve has the following entity data: [1.0d, 64.0d, 2.0d]')
        .mockResolvedValueOnce('Steve does not have the following entity data: SleepTimer');

      await instance._collectPlayerStats();

      expect(instance._sleepingPlayers).toBe(0);
    });

    it('queries RCON commands in serial (no concurrent calls)', async () => {
      const instance = createPlayerInstance();
      instance.players.set('Steve', { name: 'Steve', joinTime: Date.now(), totalPlayTime: 0 });
      Rcon.connect.mockResolvedValue(makeFakeRconClient());

      const callOrder = [];
      vi.spyOn(instance, '_rconSend').mockImplementation((cmd) => {
        callOrder.push(cmd);
        // 模拟异步响应：/attribute 命令返回属性格式，其他返回实体数据格式
        if (cmd.startsWith('attribute ')) {
          return Promise.resolve(
            'Total value for attribute minecraft:generic.armor for Steve is 8.0',
          );
        }
        return Promise.resolve('Steve has the following entity data: 0');
      });

      await instance._collectPlayerStats();

      // 命令应按顺序串行执行（Health/Pos/SleepTimer/Armor）
      // 护甲改用 /attribute 按属性名查询（兼容 1.21.2+ 属性ID变更）
      expect(callOrder).toEqual([
        'data get entity Steve Health',
        'data get entity Steve Pos',
        'data get entity Steve SleepTimer',
        'attribute Steve minecraft:generic.armor get',
      ]);
    });
  });

  // ══════════════════════════════════════════
  // 优雅停机：stopGracefully / stopAll
  // ══════════════════════════════════════════
  describe('graceful shutdown', () => {
    it('stopGracefully 等待 MC 收到 stop 命令后正常退出', async () => {
      const instance = createInstance();
      instance.start();
      expect(instance.isRunning).toBe(true);

      const stopPromise = instance.stopGracefully({ timeout: 10000 });
      // MC 收到 stop 命令后正常退出
      lastProc.emit('exit', 0);
      await stopPromise;

      expect(instance.isRunning).toBe(false);
    });

    it('stopGracefully 超时后强杀进程（MC 未退出不残留孤儿）', async () => {
      const instance = createInstance();
      instance.start();
      const killSpy = vi.spyOn(instance, 'kill').mockImplementation(() => {});

      const stopPromise = instance.stopGracefully({ timeout: 100 });
      // 推进超过超时时间：MC 未退出 → 强杀兜底
      await vi.advanceTimersByTimeAsync(200);
      await stopPromise;

      expect(killSpy).toHaveBeenCalled();
    });

    it('stopAll 等待所有运行中实例优雅停止（停机不丢玩家数据）', async () => {
      const manager = new MCServerManager();
      const instance = manager.createInstance({
        id: 'graceful-stop',
        name: 'Graceful',
        jarFile: 'server.jar',
        serverPath: tmpDir,
      });
      fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
      fs.writeFileSync(path.join(tmpDir, 'server.jar'), '');
      instance.start();
      expect(instance.isRunning).toBe(true);

      const stopPromise = manager.stopAll({ timeout: 10000 });
      lastProc.emit('exit', 0);
      await stopPromise;

      expect(instance.isRunning).toBe(false);
    });
  });
});
