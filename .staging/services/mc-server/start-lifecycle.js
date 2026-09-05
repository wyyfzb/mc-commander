/**
 * 实例启动生命周期域（issue 513 治理线·服务端第四阶段）：MCServerInstance.start() 的
 * 子阶段拆解——EULA 检查、tempban 对账、world 锁文件清理、启动命令/参数构建（四种来源
 * 优先级）、spawn 与进程/stdin/输出/exit 监听器挂载、运行时状态初始化、收尾（熔断重置/
 * started 事件/定时存档），共 11 方法，自 mc_server.js 等价搬移。挂载方式与 level-dat /
 * output-parser / stats-collector 域一致：由宿主模块 Object.assign 原型注入复用，模块函数
 * 体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例），全部调用点零改动，
 * 对外接口零变化。域外协作方法（_getSafeLevelName、_readWeatherFromLevelDat、
 * _readWorldSpawnFromLevelDat、_parseOutput、_handlePlayerLeave、_savePlayerData、
 * _startStatsCollection、_stopStatsCollection、_rconCleanup、_isValidJavaExecutable、
 * _buildFullJvmArgs、_validateJvmArgs、_parseLegacyStartCommand）留宿主类内或既有域
 * 模块，经 this 按原型链解析。
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import config from '../../config.js';
import { InstanceModel } from '../../db/index.js';
import { reconcileTempBans } from '../../utils/ban-reconcile.js';
import { logger } from '../../utils/logger.js';


// 日志单行最大长度：超长行截断并加标记，防超长输出（崩溃堆栈/异常打印）撑爆
// logBuffer 与 WebSocket 广播（find-023-server 单行截断）。
const LOG_LINE_MAX_LENGTH = 4096;

/// 单行日志截断：按行截断超过 LOG_LINE_MAX_LENGTH 的行，超长部分加 "…[truncated]" 标记。
function truncateLogText(text) {
  return String(text).split('\n').map((line) => {
    if (line.length <= LOG_LINE_MAX_LENGTH) return line;
    return line.substring(0, LOG_LINE_MAX_LENGTH) + '…[truncated]';
  }).join('\n');
}

export function _ensureEulaAccepted() {
  // EULA 检查：首次启动前必须同意 EULA
  const eulaPath = path.join(this.serverPath, 'eula.txt');
  let eulaAccepted = false;
  if (fs.existsSync(eulaPath)) {
    const eulaContent = fs.readFileSync(eulaPath, 'utf-8');
    eulaAccepted = /eula\s*=\s*true/i.test(eulaContent);
  }
  if (!eulaAccepted) {
    throw new Error('EULA_NOT_ACCEPTED');
  }
}

export function _reconcileTempBansSafe() {
  // 实例启动前对账 tempban 状态：停机期间用户可能直接编辑
  // banned-players.json 添加/删除封禁，导致面板 DB 与文件不一致。
  // 方向 1：文件有但 DB 无活跃记录 → 文件直接添加的封禁，补入 DB（永久）
  // 方向 2：DB 已过期但文件仍存在 → 停机期间到期未 pardon，清理文件 + 停用记录
  try { reconcileTempBans(this.id, this.serverPath); } catch (e) {
    logger.warn(`[${this.id}] tempban 对账失败（不阻塞启动）:`, e.message);
  }
}

export function _cleanWorldLock() {
  // 清理 world 锁文件，防止 session.lock 冲突
  // 注意：不使用 pkill，避免误杀同名进程和命令注入风险
  this.process = null;
  // 使用 level-name 而非硬编码 'world'，兼容自定义世界目录名；
  // 服务层兜底校验（extra-1）：非法/越界 level-name 回退 'world'，
  // 保证 unlink 只作用于实例目录内的锁文件（越界拒绝并告警）
  const lockLevelName = this._getSafeLevelName();
  const lockPath = path.join(this.serverPath, lockLevelName, 'session.lock');
  try { fs.unlinkSync(lockPath); } catch {}
}

export function _resolveStartCommand(startCommand) {
  let command, args;

  // ── 启动命令/参数构建（find-002-service 结构化改造，移除自由字符串执行能力）──
  // 四种来源（优先级从高到低）：
  // 1. 调用方结构化参数 start({ jvmArgs: [...] })：command 固定 javaPath，
  //    jvmArgs 过白名单校验（仅 -X/-D 前缀与 -jar，-jar 路径必须位于 serverPath 内）；
  // 2. 实例配置持久化的 jvmArgs（DB jvm_args 列，实例设置弹窗写入）：
  //    与传参同规则校验，实现"结构化启动参数可持久化"闭环（find-002）；
  // 3. 旧接口兼容：调用方传字符串命令 / 实例配置的旧 startCommand 字段，
  //    解析为 命令+参数 并逐项校验（java 可执行特征 + 参数白名单），
  //    不合法时拒绝启动并报清晰错误（不静默执行）。restart/自动重启/
  //    任务调度器调用 start() 不传参，仍读取实例配置的 startCommand；
  // 4. 默认：javaPath + -Xmx/-Xms + -jar jarPath + nogui。
  if (startCommand && typeof startCommand === 'object' && Array.isArray(startCommand.jvmArgs)) {
    if (!this._isValidJavaExecutable(this.javaPath)) {
      throw new Error(`非法 javaPath: ${this.javaPath}（仅允许 java 可执行文件，拒绝 bash/python/sh 等）`);
    }
    command = this.javaPath;
    args = this._buildFullJvmArgs(startCommand.jvmArgs, this.serverPath);
  } else if (Array.isArray(this.jvmArgs) && this.jvmArgs.length > 0) {
    // 实例配置持久化的结构化参数（优先级高于遗留 startCommand）
    if (!this._isValidJavaExecutable(this.javaPath)) {
      throw new Error(`非法 javaPath: ${this.javaPath}（仅允许 java 可执行文件，拒绝 bash/python/sh 等）`);
    }
    command = this.javaPath;
    args = this._buildFullJvmArgs(this.jvmArgs, this.serverPath);
  } else {
    const legacyCmd = (typeof startCommand === 'string' && startCommand.trim()) || this.startCommand;
    if (legacyCmd) {
      ({ command, args } = this._parseLegacyStartCommand(legacyCmd));
    } else {
      if (!this._isValidJavaExecutable(this.javaPath)) {
        throw new Error(`非法 javaPath: ${this.javaPath}（仅允许 java 可执行文件，拒绝 bash/python/sh 等）`);
      }
      const jarPath = path.join(this.serverPath, this.jarFile);
      if (!fs.existsSync(jarPath)) {
        throw new Error(`Jar file not found: ${jarPath}`);
      }

      command = this.javaPath;
      // 默认参数同样过白名单校验：jarFile 若被配置为 ../ 越界路径会被拒绝
      args = this._validateJvmArgs([
        `-Xmx${this.maxMemory}`,
        `-Xms${this.minMemory}`,
        '-jar', jarPath, 'nogui'
      ], this.serverPath);
    }
  }
  return { command, args };
}

export function _spawnServerProcess(command, args) {
  this.process = spawn(command, args, {
    cwd: this.serverPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Linux/macOS：以独立进程组启动服务器进程（pid 即 PGID），
    // kill() 才能按进程组（kill(-pid)）终止整个进程树——
    // MC 1.18+/26.x 官方 server.jar 为 Bundler 结构，java 主进程
    // （BundlerMain 引导器）经 ProcessBuilder 派生真正运行的服务器 JVM，
    // 仅杀主进程会遗留孤儿服务器。Windows 不设 detached（无进程组信号
    // 概念），进程树由 kill() 中的 taskkill /T 终止。
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });
}

export function _attachSpawnErrorListener() {
  // spawn 失败监听（javaPath 不存在/权限错误/目录被删等）：
  // 此时 child_process 触发 'error' 事件而非 'exit'——若无监听，
  // unhandled 'error' event 使整个服务端进程崩溃、所有实例托管失效。
  // 注意：'java' 这类 PATH 命令不能靠 existsSync 预校验（始终 false），
  // 只能通过 error 事件捕获，错误信息经日志流呈现给用户。
  this.process.on('error', (err) => {
    logger.error(`[${this.id}] Failed to spawn server process:`, err.message);
    this.isRunning = false;
    this.process = null;
    this._stopStatsCollection();
    this._rconCleanup();
    this.emit('log', {
      text: `[服务器] 启动失败: ${err.message}`,
      type: 'stderr',
    });
    this.emit('status', { event: 'crash', code: null, autoRestart: false });
  });
}

export function _attachStdinErrorListener() {
  // stdin 管道 error 监听（与上面 spawn 侧 error 监听同理，缺一不可）：
  // sendCommand 的 isRunning 检查与 write 之间存在竞态窗口——kill() 同步杀
  // 进程，isRunning=false 需 exit 事件在下一轮事件循环才派发，窗口内检查
  // 必然通过、write 命中已关闭管道。Linux 上 EPIPE 经 errorOrDestroy 异步
  // emit 'error'，流上无监听 → unhandled 'error' event → 整个 node 进程
  // 崩溃（autoRestart 定时器/RCON/全部实例托管失效）；Windows 上无 error
  // 事件但 write 返回 false 静默丢命令。此处消费错误仅记录日志，命令是否
  // 投递由 _writeToStdin 返回值体现（调用方语义与修复前一致）。
  // 真实 spawn 的 stdin 为 WriteStream 必然可监听；测试 mock（普通对象）
  // 场景无 .on，防御跳过。
  if (typeof this.process.stdin.on === 'function') {
    this.process.stdin.on('error', (err) => {
      logger.warn(`[${this.id}] Server stdin pipe error (server exited mid-command?):`, err.message);
    });
  }
}

export function _initializeRuntimeState() {
  this.isRunning = true;
  this.startTime = Date.now();
  // 清空上一次会话的日志缓冲，避免冷启动时混杂旧日志
  this.logBuffer = [];
  // 服务器启动时从 level.dat 读取初始天气状态和世界出生点
  const initialWeather = this._readWeatherFromLevelDat();
  if (initialWeather) {
    this._weather = initialWeather;
    logger.info(`[${this.id}] Weather initialized from level.dat: ${this._weather}`);
  }
  this._readWorldSpawnFromLevelDat();
  this._sleepingPlayers = 0;
  this._startStatsCollection();
}

export function _attachOutputStreamListeners() {
  this.process.stdout.on('data', (data) => {
    const text = data.toString();
    this.lastOutput = text;

    // 选择性过滤 RCON 噪音：保留 [Rcon: ...] 命令执行反馈（小写 rcon），
    // 过滤线程/监听器/连接等纯系统噪音（大写 RCON / Thread RCON / Client / Listener）
    const filteredLines = text.split('\n').filter(l => {
      const trimmed = l.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('[RCON')) return false;              // [RCON Listener/Client #N/INFO]
      if (trimmed.includes('Thread RCON')) return false;          // Thread RCON Client ... shutting down
      if (trimmed.includes('RCON Client')) return false;          // RCON Client /127... 连接噪音
      if (trimmed.includes('RCON Listener')) return false;        // RCON Listener 监听噪音
      if (trimmed.includes('RCON running on')) return false;      // RCON running on 0.0.0.0:25575
      if (trimmed.startsWith('WARNING:') && trimmed.includes('java.lang.System')) return false;
      if (trimmed.startsWith('Starting net.minecraft') && trimmed.includes('BundlerClassPathCapture')) return false;
      return true;
    }).join('\n');
    if (!filteredLines.trim()) return;
    // 单行截断（find-023-server）：超长行截断并加标记，防超长输出撑爆 logBuffer/WS 广播
    const filteredText = truncateLogText(filteredLines);

    this.logBuffer.push({ time: Date.now(), text: filteredText, type: 'stdout' });
    if (this.logBuffer.length > 1000) this.logBuffer.shift();
    this.emit('log', { text: filteredText, type: 'stdout' });
    this._parseOutput(filteredText);
  });

  this.process.stderr.on('data', (data) => {
    const text = data.toString();
    // 单行截断（find-023-server）：stderr 同理，超长行截断并加标记
    const truncated = truncateLogText(text);
    this.logBuffer.push({ time: Date.now(), text: truncated, type: 'stderr' });
    this.emit('log', { text: truncated, type: 'stderr' });
  });
}

export function _attachExitListener() {
  this.process.on('exit', (code) => {
    this.isRunning = false;
    this.process = null;
    this._stopStatsCollection();
    this._rconCleanup();
    // 服务器关闭时所有在线玩家视为离开（记录"离开服务器"事件 + 保存数据）
    for (const name of [...this.players.keys()]) {
      this._handlePlayerLeave(name);
    }
    this.players.clear();
    // 持久化累计运行时长到数据库
    if (this.startTime) {
      const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
      try { InstanceModel.addUptime(this.id, uptimeSeconds); } catch (e) { logger.warn('Failed to persist uptime:', e.message); }
    }

    // 区分「意外停止/崩溃」与「用户主动停止」：
    // 主动 stop/kill/restart 会设置 _manualStop=true；正常退出 code 通常为 0。
    const unexpectedExit = !this._manualStop && code !== 0;
    if (unexpectedExit) {
      // ── 崩溃循环熔断检测（feat-5 运维韧性）──
      const now = Date.now();
      const { windowMs, maxCrashes } = config.crashLoop;
      // 滑动窗口：窗口外重置计数
      if (this._crashWindowStart && now - this._crashWindowStart > windowMs) {
        this._consecutiveCrashes = 0;
        this._crashWindowStart = null;
      }
      this._consecutiveCrashes++;
      if (!this._crashWindowStart) this._crashWindowStart = now;
      // 达阈值 → 熔断：自动禁用 autoRestart 并持久化
      if (this._consecutiveCrashes >= maxCrashes && !this._circuitBreakerTripped) {
        this._circuitBreakerTripped = true;
        this.autoRestart = false;
        try { InstanceModel.update(this.id, { autoRestart: false }); } catch { /* best-effort */ }
        this.emit('log', {
          text: `[服务器] 崩溃循环熔断已触发（${windowMs / 1000}s 内崩溃 ${this._consecutiveCrashes} 次），自动重启已禁用。请在实例设置中手动重新启用。`,
          type: 'stdout',
        });
        this.emit('status', { event: 'circuit_breaker', consecutiveCrashes: this._consecutiveCrashes, windowMs });
      }

      // 意外停止：记录到日志流（终端可见），并按开关决定是否自动重启
      const willRestart = this.autoRestart;
      this.emit('log', {
        text: `[服务器] 意外退出 (code ${code})${willRestart ? '，5 秒后自动重启' : ''}`,
        type: 'stdout',
      });
      this.emit('status', { event: 'crash', code, autoRestart: willRestart });
      if (willRestart) {
        // 崩溃自动重启定时器：句柄保存到 _restartTimer（与 _scheduleRestartStart 同字段），
        // 使 stop/kill/卸载路径的 cancelRestart() 能取消，杜绝违背用户意图的自动拉起。
        if (this._restartTimer) clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => {
          this._restartTimer = null;
          // 5s 窗口内服务器已被其他路径启动 → 放弃自动重启
          if (this.isRunning) return;
          // 实例目录已被删除（用户卸载）→ 放弃自动重启
          if (!fs.existsSync(path.join(this.serverPath, this.jarFile))) {
            logger.info(`[${this.id}] Auto-restart cancelled: server jar no longer exists`);
            return;
          }
          try {
            this.start();
            logger.info(`[${this.id}] 意外停止后自动重启成功`);
            this.emit('log', { text: '[服务器] 已自动重启', type: 'stdout' });
          } catch (e) {
            logger.error(`[${this.id}] 自动重启失败:`, e.message);
            this.emit('log', { text: `[服务器] 自动重启失败: ${e.message}`, type: 'stderr' });
          }
        }, 5000);
      }
    } else {
      this.emit('status', { event: 'stopped', code });
    }
  });
}

export function _finalizeStartup() {
  // 成功启动 → 重置熔断器
  this._consecutiveCrashes = 0;
  this._crashWindowStart = null;
  this._circuitBreakerTripped = false;

  this.emit('status', { event: 'started' });

  // 每 60 秒自动保存在线玩家数据
  this._saveTimer = setInterval(() => {
    for (const [name, player] of this.players) {
      this._savePlayerData(name, player);
    }
  }, 60000);
}
