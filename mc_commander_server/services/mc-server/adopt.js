/**
 * 实例进程接管域（根修）：pid 文件 + 面板重启后孤儿进程接管。
 *
 * 背景：MC 以 detached 进程组 spawn（start-lifecycle），面板崩溃/更新重启后
 * 进程绑定丢失——实例仍在运行（玩家可玩），面板却显示已停止且无法操作
 * （isRunning 是内存态）；autoStart 实例还会被再次拉起造成双开。
 *
 * 机制：start() 成功后落 pid 文件（<serverPath>/.mc-commander-pid）；
 * 面板启动时（autoStart 错峰之前）扫描 pid 文件验活，存活则「接管」——
 * 恢复运行态显示与 RCON/统计/停止能力。stdout/stdin 管道随面板死亡而失效
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

/** spawn 成功后落 pid 文件（best-effort：写失败仅告警，不影响启动） */
export function _writePidFile() {
  const pid = this.process?.pid;
  if (!pid) return;
  try {
    fs.writeFileSync(this._pidFilePath(), JSON.stringify({ pid, startedAt: Date.now() }));
  } catch (e) {
    logger.warn(`[${this.id}] pid 文件写入失败（接管功能将不可用）:`, e.message);
  }
}

export function _removePidFile() {
  try { fs.unlinkSync(this._pidFilePath()); } catch { /* 不存在/已删 */ }
}

export function _readPidFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(this._pidFilePath(), 'utf8'));
    if (Number.isInteger(raw?.pid) && raw.pid > 1) return raw;
  } catch { /* 不存在/损坏 */ }
  return null;
}

/**
 * 验活 + 身份核对：process.kill(pid,0) 只能证明「有进程占着这个 pid」，
 * Linux 追加 /proc/<pid>/cmdline 含 jar 文件名校验防 pid 复用误判
 * （面板重启与 pid 重assignment之间窗口虽小，误接管会引灾难性操作）。
 * 非 Linux（无 /proc）退化为纯验活，接受复用窗口。
 */
export function _isPidAlive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'win32') return true;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes(path.basename(this.jarFile));
  } catch {
    // cmdline 读取失败（权限/瞬时退出）：退回纯验活结论
    return true;
  }
}

/**
 * 尝试从 pid 文件接管孤儿进程。成功：恢复运行态（isRunning/startTime/统计/
 * 日志续读/看门狗）并广播 started；pid 文件缺失或进程已死：清理残留返回 false。
 * 不改变 autoStart 数据——接管实例 autoStart 标记保持原值。
 */
export function adoptFromPidFile() {
  if (this.isRunning) return false;
  const rec = this._readPidFile();
  if (!rec) return false;
  if (!this._isPidAlive(rec.pid)) {
    // 孤儿已死：清残留（下次 start 从干净状态开始）
    this._removePidFile();
    return false;
  }

  this.adopted = true;
  this.adoptedPid = rec.pid;
  this.process = null;
  this.isRunning = true;
  // startTime 用 pid 文件写入时刻近似（真实 spawn 时刻略早，误差 ≤ 一轮 start 时长）
  this.startTime = rec.startedAt || Date.now();
  this._manualStop = false;
  // 日志续读：stdout 管道不可重连，改读 latest.log 尾部（构造期已回填当次运行
  // 日志，故续读从文件末尾起），接管对用户无感——终端不注入任何提示行
  this._startAdoptedLogTail();
  this._startStatsCollection();
  this._startAdoptWatchdog();
  logger.info(`[${this.id}] Adopted orphan server process (pid ${rec.pid})`);
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
      try { InstanceModel.addUptime(this.id, uptimeSeconds); } catch (e) { logger.warn('Failed to persist uptime:', e.message); }
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
