/**
 * 孤儿进程接管域测试（根修）
 * - pid 文件写/读/删（spawn 后落盘、exit 清理的线索文件）
 * - adoptFromPidFile：活 pid 接管（运行态恢复 + started 广播）/ 死 pid 清残留
 * - 看门狗：接管进程死亡后的状态收敛（_manualStop 区分 stopped/crash）
 * - 接管实例命令通道语义：无 RCON 时 sendCommand 如实拒绝
 * 活体用测试进程自身 pid（_isPidAlive 的 cmdline 校验按 jarFile 基名匹配 node），
 * 死体用系统必然未占用的 pid；数据全部为虚构占位。
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-adopt-test-'));
  return {
    default: {
      port: 0,
      serversDir: path.join(tmpRoot, 'servers'),
      dataDir: path.join(tmpRoot, 'data'),
      backupsDir: path.join(tmpRoot, 'backups'),
      logLevel: 'info',
      rateLimit: { windowMs: 60000, max: 100 },
      autoStartDelayMs: 2000,
      crashLoop: { windowMs: 300000, maxCrashes: 5 },
    },
  };
});

import {
  PID_FILE_NAME,
  _writePidFile,
  _removePidFile,
  _startAdoptWatchdog,
  _stopAdoptWatchdog,
  adoptOrphanInstances,
} from '../services/mc-server/adopt.js';
import { MCServerInstance } from '../services/mc_server.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-adopt-fixture-'));
// 活体：测试进程自身（win32 纯验活即真；linux 下 /proc cmdline 含 node 与 jarFile 基名匹配）
const ALIVE_PID = process.pid;
const DEAD_PID = 999999;
// _isPidAlive 在 linux 校验 /proc/<pid>/cmdline 含 jar 基名——用 node 可执行名保证活体命中
const JAR_BASENAME = path.basename(process.execPath);

function makeInstance(name) {
  const serverPath = path.join(tmpBase, name);
  fs.mkdirSync(serverPath, { recursive: true });
  // 裸原型实例（同 level-dat.test 模式）：验证 Object.assign 挂载后的 this 绑定
  const inst = Object.create(MCServerInstance.prototype);
  inst.id = name;
  inst.serverPath = serverPath;
  inst.jarFile = JAR_BASENAME;
  inst.properties = {};
  inst.isRunning = false;
  inst.adopted = false;
  inst.adoptedPid = null;
  inst._adoptTimer = null;
  inst._logTailTimer = null;
  inst._logTailState = null;
  inst.process = null;
  inst.logBuffer = [];
  inst.players = new Map();
  inst.startTime = null;
  inst._manualStop = false;
  inst._statsTimer = null;
  inst._rconClient = null;
  return inst;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  _stopAdoptWatchdog.call({ _adoptTimer: null });
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('pid 文件 CRUD', () => {
  it('spawn 后写 pid 文件（JSON 含 pid 与 startedAt）', () => {
    const inst = makeInstance('pid-write');
    inst.process = { pid: ALIVE_PID };
    inst._writePidFile();
    const raw = JSON.parse(fs.readFileSync(path.join(inst.serverPath, PID_FILE_NAME), 'utf8'));
    expect(raw.pid).toBe(ALIVE_PID);
    expect(typeof raw.startedAt).toBe('number');
  });

  it('_removePidFile 幂等（不存在不抛）', () => {
    const inst = makeInstance('pid-remove');
    expect(() => inst._removePidFile()).not.toThrow();
    inst.process = { pid: ALIVE_PID };
    inst._writePidFile();
    inst._removePidFile();
    expect(fs.existsSync(path.join(inst.serverPath, PID_FILE_NAME))).toBe(false);
  });
});

describe('adoptFromPidFile 接管', () => {
  it('活 pid → 接管：运行态恢复、接管标记、日志续读、started 广播（终端不注入提示行）', () => {
    const inst = makeInstance('adopt-alive');
    fs.writeFileSync(
      path.join(inst.serverPath, PID_FILE_NAME),
      JSON.stringify({ pid: ALIVE_PID, startedAt: Date.now() - 60000 }),
    );
    const events = [];
    inst.on('status', (s) => events.push(s));

    const ok = inst.adoptFromPidFile();

    expect(ok).toBe(true);
    expect(inst.isRunning).toBe(true);
    expect(inst.adopted).toBe(true);
    expect(inst.adoptedPid).toBe(ALIVE_PID);
    expect(inst.process).toBeNull();
    expect(inst.startTime).toBeLessThanOrEqual(Date.now());
    // 接管对用户无感：不向终端注入任何提示行（日志由 log-tail 续读 latest.log）
    expect(inst.logBuffer).toHaveLength(0);
    expect(inst._logTailTimer).not.toBeNull();
    expect(events.some((e) => e.event === 'started')).toBe(true);
    inst._stopAdoptWatchdog();
    inst._stopAdoptedLogTail();
    inst._stopStatsCollection();
  });

  it('死 pid → 清残留 pid 文件并拒绝接管', () => {
    const inst = makeInstance('adopt-dead');
    fs.writeFileSync(
      path.join(inst.serverPath, PID_FILE_NAME),
      JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }),
    );
    const ok = inst.adoptFromPidFile();
    expect(ok).toBe(false);
    expect(inst.isRunning).toBe(false);
    expect(fs.existsSync(path.join(inst.serverPath, PID_FILE_NAME))).toBe(false);
  });

  it('无 pid 文件 → 不接管', () => {
    const inst = makeInstance('adopt-none');
    expect(inst.adoptFromPidFile()).toBe(false);
  });

  it('adoptOrphanInstances 遍历真实例 Map（回归：getAllInstances 返回 toStatus 快照无原型方法）', () => {
    const inst = makeInstance('adopt-manager');
    fs.writeFileSync(
      path.join(inst.serverPath, PID_FILE_NAME),
      JSON.stringify({ pid: ALIVE_PID, startedAt: Date.now() }),
    );
    const manager = { instances: new Map([['adopt-manager', inst]]) };
    expect(adoptOrphanInstances(manager)).toBe(1);
    expect(inst.isRunning).toBe(true);
    inst._stopAdoptWatchdog();
    inst._stopAdoptedLogTail();
    inst._stopStatsCollection();
  });
});

describe('接管看门狗', () => {
  it('进程死亡后收敛运行态：残留清理 + 按 _manualStop 区分 stopped/crash', async () => {
    const inst = makeInstance('watchdog');
    fs.writeFileSync(
      path.join(inst.serverPath, PID_FILE_NAME),
      JSON.stringify({ pid: ALIVE_PID, startedAt: Date.now() }),
    );
    expect(inst.adoptFromPidFile()).toBe(true);
    inst._stopAdoptWatchdog();

    const events = [];
    inst.on('status', (s) => events.push(s));

    // 场景一：非手动停止 → crash 语义
    inst._startAdoptWatchdog(25);
    inst.adoptedPid = DEAD_PID; // 模拟活体消失（绕开真实进程不可自杀）
    await new Promise((r) => setTimeout(r, 120));
    expect(inst.isRunning).toBe(false);
    expect(inst.adopted).toBe(false);
    expect(inst.adoptedPid).toBeNull();
    expect(fs.existsSync(path.join(inst.serverPath, PID_FILE_NAME))).toBe(false);
    expect(events.at(-1).event).toBe('crash');

    // 场景二：手动停止 → stopped 语义
    inst.isRunning = true;
    inst.adopted = true;
    inst.adoptedPid = DEAD_PID;
    inst._manualStop = true;
    inst._startAdoptWatchdog(25);
    await new Promise((r) => setTimeout(r, 120));
    expect(inst.isRunning).toBe(false);
    expect(events.at(-1).event).toBe('stopped');
  });
});

describe('接管实例命令通道语义', () => {
  it('无 RCON 时 sendCommand 如实拒绝（不静默丢弃）', async () => {
    // 完整构造走真实 constructor（EventEmitter 状态与命令历史落库 finally 就绪）
    const inst = new MCServerInstance({
      id: 'adopt-cmd',
      name: 'adopt-cmd',
      javaPath: 'java',
      jarFile: 'server.jar',
      serverPath: path.join(tmpBase, 'adopt-cmd'),
    });
    inst.isRunning = true;
    inst.adopted = true;
    inst.adoptedPid = ALIVE_PID;
    inst.process = null;

    await expect(inst.sendCommand('help')).rejects.toThrow(/接管实例无控制台管道/);
  });
});
