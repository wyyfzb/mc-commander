/**
 * 实例进程接管域（根修）：pid 文件 + 面板重启后孤儿进程接管。
 *
 * 背景：MC 以 detached 进程组 spawn（start-lifecycle），面板崩溃/更新重启后
 * 进程绑定丢失——实例仍在运行（玩家可玩），面板却显示已停止且无法操作
 * （isRunning 是内存态）；autoStart 实例还会被再次拉起造成双开。
 *
 * 机制：服务端经官方启动参数 `--pidFile <实例目录>/.mc-commander-pid` 自己落 pid（面板不自写）；
 * 面板启动时（autoStart 错峰之前）读该文件验活并核对身份，存活则「接管」——
 * 恢复运行态显示与 RCON/统计/停止能力。pid 文件尚未写出（服务端刚起几秒）时退回 /proc 扫描。
 * stdout/stdin 管道随面板死亡而失效
 * 且不可重连：命令仅 RCON 通道、退出感知由看门狗轮询替代 exit 事件；日志
 * 由 log-tail 域续读 latest.log（接管对用户无感）。接管先于 autoStart 完成，
 * 其 isRunning=true 使 autoStart 的已运行跳过检查天然防双开。
 */

import path from 'path';
import fs from 'fs';
import { InstanceModel } from '../../db/index.js';
import { logger } from '../../utils/logger.js';

export const PID_FILE_NAME = '.mc-commander-pid';
/** 看门狗轮询间隔：死亡检测延迟上限（替代 exit 事件的感知通道） */
export const ADOPT_WATCHDOG_INTERVAL_MS = 5000;
/** stopGracefully 对接管实例的退出轮询间隔 */
const EXIT_POLL_INTERVAL_MS = 250;

export function _pidFilePath() {
  return path.join(this.serverPath, PID_FILE_NAME);
}

/**
 * 把 `--pidFile <实例目录>/.mc-commander-pid` 并进启动参数。
 *
 * pid 由**服务端自己**落盘（`--pidFile` 是官方启动参数，写的是当前 JVM 的 pid）：面板
 * 自写一份的值与真进程之间没有约束关系，谁改了启动方式都会让它悄悄失真。
 *
 * 位置：`--pidFile` 是**应用参数**（主类之后），必须跟在 jar/argfile 之后；`_validateJvmArgs`
 * 只放行 JVM 选项与 -jar，故这步在参数校验之后单点注入，覆盖全部四种启动来源。
 * 用户自己指定过 `--pidFile` 时不覆盖。
 */
export function _withPidFileArg(args) {
  if (args.some((a) => String(a) === '--pidFile')) return args;
  const pidPath = this._pidFilePath();
  const jarIdx = args.findIndex((a) => String(a) === '-jar');
  if (jarIdx >= 0) {
    // -jar <path> 之后紧跟应用参数，插在 nogui 之前
    return [...args.slice(0, jarIdx + 2), '--pidFile', pidPath, ...args.slice(jarIdx + 2)];
  }
  // Fabric/Forge 启动方式没有 -jar（主类藏在 @argfile 里）：应用参数追加在末尾
  return [...args, '--pidFile', pidPath];
}

/** 删掉 pid 文件：服务端退出后不会自己清理，残留会让下次接管读到死 pid */
export function _removePidFile() {
  try {
    fs.unlinkSync(this._pidFilePath());
  } catch {
    /* 不存在/已删 */
  }
}

/** 读 pid 文件（服务端写入的纯数字文本，可能带换行）；读不到或非正整数返回 null */
export function _readPidFile() {
  try {
    const pid = Number.parseInt(fs.readFileSync(this._pidFilePath(), 'utf8').trim(), 10);
    if (Number.isInteger(pid) && pid > 1) return pid;
  } catch {
    /* 不存在/损坏 */
  }
  return null;
}

/**
 * 验活 + 身份核对：process.kill(pid,0) 只能证明「有进程占着这个 pid」，
 * Linux 追加 /proc/<pid>/cmdline 含 jar 文件名校验防 pid 复用误判
 * （面板重启与 pid 重assignment之间窗口虽小，误接管会引灾难性操作）。
 * 非 Linux（无 /proc）退化为纯验活，接受复用窗口。
 */
export function _isPidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  return this._isInstanceProcess(pid);
}

/**
 * 身份核对：pid 复用会让「kill(pid,0) 成功」指向一个陌生进程，误接管等于对别人的进程下
 * 停止/改配置命令。判据取进程的 cwd —— 面板 spawn 时 cwd 就是实例目录，且与启动器无关
 * （Forge 的 cmdline 里根本不出现 jar 文件名，只看 cmdline 会把它判成「不是我的进程」）。
 * cwd 读不到时退回 cmdline 含实例路径/jar 文件名；都拿不到则**不认**——误接管的代价远大于
 * 少接管一次（少接管的表现是实例显示未运行，用户点一次启动即可）。
 */
export function _isInstanceProcess(pid) {
  let cwdReadable = false;
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    cwdReadable = true;
    if (path.resolve(cwd) === path.resolve(this.serverPath)) return true;
  } catch {
    // 权限或瞬时退出：cwd 读不到时只能退回命令行判定
  }
  // cwd 读得到却不是本实例目录 ⇒ 不是本实例的进程，命令行里提到路径也不算
  // （rsync/tail 这类旁观进程的命令行就带着实例路径）
  if (cwdReadable) return false;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    // 按**实例路径**比对而不是 jar 文件名：多实例的 jar 常同名（server.jar），
    // 只比基名会把 A 实例的进程认成 B 的
    return cmdline.includes(this.serverPath);
  } catch {
    return false;
  }
}

/**
 * 进程启动时刻（epoch ms）：取 /proc/<pid>/stat 的 starttime（开机以来的时钟滴答数）
 * 加 /proc/stat 的 btime。接管实例的 uptime 由此对齐到真实启动时刻，而不是面板接管
 * 的那一刻。取不到返回 null。
 */
export function _procStartTimeMs(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 字段可能含空格与括号，故从最后一个 ')' 之后开始数
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = Number(rest[19]); // 第 22 字段 starttime（此处下标 19）
    const btimeLine = fs
      .readFileSync('/proc/stat', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('btime '));
    const btime = Number(btimeLine?.split(' ')[1]);
    const hz = 100; // Linux 用户态时钟滴答默认 100Hz；异常值只会让 uptime 偏差，不影响接管本身
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    return (btime + startTicks / hz) * 1000;
  } catch {
    return null;
  }
}

/**
 * 在 /proc 里找本实例的进程（pid 文件缺失时的兜底：服务端启动几秒后才写 pidFile，
 * 面板若在这之前退出就没有该文件）。判据与身份核对同一套（cwd == 实例目录）。
 * 非 Linux 直接返回 null。
 */
export function _findInstancePidByProc() {
  if (process.platform === 'win32' || !fs.existsSync('/proc')) return null;
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    if (this._isInstanceProcess(pid)) return pid;
  }
  return null;
}

/**
 * 尝试接管孤儿进程。成功：恢复运行态（isRunning/startTime/统计/日志续读/看门狗）并广播
 * started；找不到活进程：清理残留返回 false。
 * 不改变 autoStart 数据——接管实例 autoStart 标记保持原值。
 */
export function adoptFromPidFile() {
  if (this.isRunning) return false;
  const storedPid = this._readPidFile();
  let pid = storedPid;
  if (pid === null || !this._isPidAlive(pid)) {
    // pid 文件缺失/过期：退回 /proc 扫描（覆盖「服务端还没写 pidFile 面板就重启了」）
    if (storedPid !== null) this._removePidFile();
    pid = this._findInstancePidByProc();
    if (pid === null) return false;
  }

  this.adopted = true;
  this.adoptedPid = pid;
  this.process = null;
  this.isRunning = true;
  // 启动时刻取进程自己的（不是接管时刻）：uptime 才与真实运行时长一致
  this.startTime = this._procStartTimeMs(pid) || Date.now();
  this._manualStop = false;
  // 日志续读：stdout 管道不可重连，改读 latest.log 尾部（构造期已回填当次运行
  // 日志，故续读从文件末尾起），接管对用户无感——终端不注入任何提示行
  this._startAdoptedLogTail();
  this._startStatsCollection();
  this._startAdoptWatchdog();
  logger.info(`[${this.id}] Adopted orphan server process (pid ${pid})`);
  this.emit('status', { event: 'started' });
  return true;
}

/** 接管实例的退出感知：轮询验活，死亡时执行与 exit 监听对等的清理。
 *  退出性质判定：_manualStop（用户 stop/kill/restart 置位）→ stopped，
 *  否则视为意外退出 → crash 事件（前端持久告警）；接管实例不做自动重启
 *  （watchdog 与 autoRestart 定时器耦合复杂，留给用户在面板显式启动）。 */
export function _startAdoptWatchdog(intervalMs = ADOPT_WATCHDOG_INTERVAL_MS) {
  this._stopAdoptWatchdog();
  this._adoptTimer = setInterval(() => {
    if (!this.adopted || !this.adoptedPid) {
      this._stopAdoptWatchdog();
      return;
    }
    if (this._isPidAlive(this.adoptedPid)) return;

    this._stopAdoptWatchdog();
    const uptimeSeconds = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : null;
    this.isRunning = false;
    this.adopted = false;
    const pid = this.adoptedPid;
    this.adoptedPid = null;
    this._removePidFile();
    this._stopStatsCollection();
    this._stopAdoptedLogTail();
    this._rconCleanup();
    this._worldSizeDirty = true;
    for (const name of [...this.players.keys()]) this._handlePlayerLeave(name);
    this.players.clear();
    if (uptimeSeconds != null) {
      try {
        InstanceModel.addUptime(this.id, uptimeSeconds);
      } catch (e) {
        logger.warn('Failed to persist uptime:', e.message);
      }
    }
    logger.info(`[${this.id}] Adopted process (pid ${pid}) exited`);
    if (this._manualStop) {
      this.emit('status', { event: 'stopped', code: null });
    } else {
      this.emit('log', { text: `[服务器] 接管的实例进程已退出 (pid ${pid})`, type: 'stderr' });
      this.emit('status', { event: 'crash', code: null, autoRestart: false });
    }
  }, intervalMs);
  // 不阻塞面板进程退出
  this._adoptTimer.unref?.();
}

export function _stopAdoptWatchdog() {
  if (this._adoptTimer) {
    clearInterval(this._adoptTimer);
    this._adoptTimer = null;
  }
}

/** 等待接管进程退出（stopGracefully 专用）：轮询验活替代 exit 事件 */
export function _waitForAdoptedExit(timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (!this.adopted || !this._isPidAlive(this.adoptedPid)) return resolve();
      if (Date.now() - started >= timeout) return resolve();
      setTimeout(poll, EXIT_POLL_INTERVAL_MS);
    };
    poll();
  });
}

/** 遍历全部实例执行接管（面板启动序列调用，须先于 autoStart 错峰启动）。
 *  注意：必须遍历 instances Map（真实例）——getAllInstances() 返回 toStatus()
 *  快照（plain object），不带任何原型方法。 */
export function adoptOrphanInstances(serverManager) {
  let adopted = 0;
  for (const instance of serverManager.instances.values()) {
    try {
      if (instance.adoptFromPidFile()) adopted++;
    } catch (e) {
      logger.warn(`[${instance.id}] Adopt check failed:`, e.message);
    }
  }
  if (adopted > 0) logger.info(`[Adopt] ${adopted} orphan instance(s) adopted`);
  return adopted;
}
