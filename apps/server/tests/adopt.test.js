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
import { spawn } from 'child_process';

vi.mock('../src/config.js', async () => {
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
  _withPidFileArg,
  _readPidFile,
  _removePidFile,
  _startAdoptWatchdog,
  _stopAdoptWatchdog,
  adoptOrphanInstances,
} from '../src/services/mc-server/adopt.js';
import { MCServerInstance } from '../src/services/mc_server.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-adopt-fixture-'));
const DEAD_PID = 999999;

// 活体用真实子进程，且 cwd 就是实例目录：身份判据取的是 /proc/<pid>/cwd，
// 只有真的「在该目录下跑的进程」才算本实例的进程（用测试进程自身会绕过这条判据）
const children = [];
function spawnFakeServer(cwd) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd,
    stdio: 'ignore',
  });
  children.push(child);
  return child.pid;
}

function makeInstance(name) {
  const serverPath = path.join(tmpBase, name);
  fs.mkdirSync(serverPath, { recursive: true });
  // 裸原型实例（同 level-dat.test 模式）：验证 Object.assign 挂载后的 this 绑定
  const inst = Object.create(MCServerInstance.prototype);
  inst.id = name;
  inst.serverPath = serverPath;
  inst.jarFile = 'server.jar';
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
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  _stopAdoptWatchdog.call({ _adoptTimer: null });
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('pid 文件与启动参数注入', () => {
  it('_withPidFileArg 插在 -jar <path> 之后（应用参数位置），不破坏 nogui', () => {
    const inst = makeInstance('pid-arg');
    const args = inst._withPidFileArg(['-Xmx2G', '-jar', '/srv/a/server.jar', 'nogui']);
    expect(args).toEqual([
      '-Xmx2G',
      '-jar',
      '/srv/a/server.jar',
      '--pidFile',
      path.join(inst.serverPath, PID_FILE_NAME),
      'nogui',
    ]);
  });

  it('无 -jar（Fabric/Forge 的 @argfile 形态）时追加在末尾', () => {
    const inst = makeInstance('pid-arg-file');
    const args = inst._withPidFileArg(['-Xmx2G', '@user_jvm_args.txt', '@libraries/unix_args.txt']);
    expect(args.slice(-2)).toEqual(['--pidFile', path.join(inst.serverPath, PID_FILE_NAME)]);
  });

  it('用户已指定 --pidFile 时不覆盖', () => {
    const inst = makeInstance('pid-arg-user');
    const args = ['-jar', '/srv/b/server.jar', '--pidFile', '/tmp/mine.pid'];
    expect(inst._withPidFileArg(args)).toBe(args);
  });

  it('_readPidFile 解析服务端写出的纯数字（含尾随换行），非法内容返回 null', () => {
    const inst = makeInstance('pid-read');
    const pidPath = path.join(inst.serverPath, PID_FILE_NAME);
    fs.writeFileSync(pidPath, '12345\n');
    expect(inst._readPidFile()).toBe(12345);
    fs.writeFileSync(pidPath, 'not-a-pid');
    expect(inst._readPidFile()).toBeNull();
    fs.unlinkSync(pidPath);
    expect(inst._readPidFile()).toBeNull();
  });

  it('_removePidFile 幂等（不存在不抛）', () => {
    const inst = makeInstance('pid-remove');
    expect(() => inst._removePidFile()).not.toThrow();
    fs.writeFileSync(path.join(inst.serverPath, PID_FILE_NAME), '12345');
    inst._removePidFile();
    expect(fs.existsSync(path.join(inst.serverPath, PID_FILE_NAME))).toBe(false);
  });
});

describe('adoptFromPidFile 接管', () => {
  it('pid 文件指向本实例进程 → 接管：运行态恢复、接管标记、日志续读、started 广播（终端不注入提示行）', () => {
    const inst = makeInstance('adopt-alive');
    const pid = spawnFakeServer(inst.serverPath);
    fs.writeFileSync(path.join(inst.serverPath, PID_FILE_NAME), String(pid));
    const events = [];
    inst.on('status', (s) => events.push(s));

    const ok = inst.adoptFromPidFile();

    expect(ok).toBe(true);
    expect(inst.isRunning).toBe(true);
    expect(inst.adopted).toBe(true);
    expect(inst.adoptedPid).toBe(pid);
    expect(inst.process).toBeNull();
    // startTime 取进程自己的启动时刻（/proc），不是接管时刻：应 ≈ 现在且不晚于现在
    expect(inst.startTime).toBeLessThanOrEqual(Date.now());
    expect(inst.startTime).toBeGreaterThan(Date.now() - 60000);
    // 接管对用户无感：不向终端注入任何提示行（日志由 log-tail 续读 latest.log）
    expect(inst.logBuffer).toHaveLength(0);
    expect(inst._logTailTimer).not.toBeNull();
    expect(events.some((e) => e.event === 'started')).toBe(true);
    inst._stopAdoptWatchdog();
    inst._stopAdoptedLogTail();
    inst._stopStatsCollection();
  });

  it('pid 文件缺失但实例进程在跑 → /proc 兜底接管（覆盖服务端还没写出 pidFile 的窗口）', () => {
    const inst = makeInstance('adopt-procscan');
    const pid = spawnFakeServer(inst.serverPath);
    expect(fs.existsSync(path.join(inst.serverPath, PID_FILE_NAME))).toBe(false);

    expect(inst.adoptFromPidFile()).toBe(true);
    expect(inst.adoptedPid).toBe(pid);
    inst._stopAdoptWatchdog();
    inst._stopAdoptedLogTail();
    inst._stopStatsCollection();
  });

  it('pid 文件指向别的目录的进程 → 不接管（pid 复用/串实例的防线）', () => {
    const inst = makeInstance('adopt-foreign');
    // 子进程 cwd 是系统临时目录，不是本实例目录
    const pid = spawnFakeServer(os.tmpdir());
    fs.writeFileSync(path.join(inst.serverPath, PID_FILE_NAME), String(pid));

    expect(inst.adoptFromPidFile()).toBe(false);
    expect(inst.isRunning).toBe(false);
  });

  it('命令行里提到实例路径、但不在该目录运行的进程 → 不接管（rsync/tail 这类旁观进程）', () => {
    const inst = makeInstance('adopt-bystander');
    // cwd 在系统临时目录，只有 argv 里带了实例路径：只看命令行的判定会把它认成本实例进程
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', path.join(inst.serverPath, 'logs', 'latest.log')],
      { cwd: os.tmpdir(), stdio: 'ignore' },
    );
    children.push(child);
    fs.writeFileSync(path.join(inst.serverPath, PID_FILE_NAME), String(child.pid));

    expect(inst.adoptFromPidFile()).toBe(false);
    expect(inst.isRunning).toBe(false);
  });

  it('死 pid → 清残留 pid 文件并拒绝接管', () => {
    const inst = makeInstance('adopt-dead');
    fs.writeFileSync(path.join(inst.serverPath, PID_FILE_NAME), String(DEAD_PID));
    const ok = inst.adoptFromPidFile();
    expect(ok).toBe(false);
    expect(inst.isRunning).toBe(false);
    expect(fs.existsSync(path.join(inst.serverPath, PID_FILE_NAME))).toBe(false);
  });

  it('无 pid 文件且无进程 → 不接管', () => {
    const inst = makeInstance('adopt-none');
    expect(inst.adoptFromPidFile()).toBe(false);
  });

  it('adoptOrphanInstances 遍历真实例 Map（回归：getAllInstances 返回 toStatus 快照无原型方法）', () => {
    const inst = makeInstance('adopt-manager');
    const pid = spawnFakeServer(inst.serverPath);
    fs.writeFileSync(path.join(inst.serverPath, PID_FILE_NAME), String(pid));
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
    const pid = spawnFakeServer(inst.serverPath);
    fs.writeFileSync(path.join(inst.serverPath, PID_FILE_NAME), String(pid));
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
    inst.adoptedPid = DEAD_PID;
    inst.process = null;

    await expect(inst.sendCommand('help')).rejects.toThrow(/接管实例无控制台管道/);
  });
});
