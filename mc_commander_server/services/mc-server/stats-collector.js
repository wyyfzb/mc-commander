/**
 * 实例统计采集域（issue 502 治理线·服务端第三阶段）：系统资源（CPU/内存）、玩家状态
 * （血量/坐标/入睡）、MSPT、世界状态（时间/天气/天数）的定时采集与调度，共 12 方法，
 * 自 mc_server.js 等价搬移。挂载方式与 level-dat / output-parser 域一致：由宿主模块
 * Object.assign 原型注入复用，模块函数体内 this 语义与类内定义完全一致（实例方法调用时
 * this 绑定实例），全部调用点零改动，对外接口零变化。域外协作方法（_rconSend、
 * _rconEnsureConnected、_queryAttribute、_readWeatherFromLevelDat、_emitPerformance、
 * _addPlayerEvent）留宿主类内或既有域模块，经 this 按原型链解析。
 */

import { exec } from 'child_process';
import fs from 'fs';
import { logger } from '../../utils/logger.js';

export function _startStatsCollection() {
  this._stopStatsCollection();
  this._statsTimer = setInterval(() => this._collectStats(), 5000);
  // 定期通过 RCON 查询 MSPT（每 30 秒一次）。
  // 用递归 setTimeout 串行化：_collectMspt 是 async 且内部串行 await 多条
  // RCON 查询（tick query 失败再回退 tps），setInterval 不等待回调结束，
  // RCON 卡顿时（单轮超过 30s）会多轮采集重叠并发压向服务器。
  this._scheduleMspt();
  // 定期通过 RCON 查询在线玩家血量/坐标/入睡状态（每 5 秒一次）。
  // 用递归 setTimeout 串行化：_collectPlayerStats 是 async 且内部串行
  // await 多条 RCON 查询（RCON 卡顿时单轮可远超 5s），setInterval 不等待
  // 回调结束会多轮采集重叠并发压向服务器，改为本轮完成后再调度下一轮。
  this._schedulePlayerStats();
  // 定期采集世界状态（时间/天气），实现自然变化的实时同步（每 10 秒一次）。
  // 用递归 setTimeout 串行化：_collectWorldState 是 async 且内部串行 await
  // 多条 RCON 查询（时间三级 fallback 链 + 天数查询，单轮最多 6 条），
  // setInterval 不等待回调结束，RCON 卡顿时会多轮采集重叠并发压向服务器。
  // 首轮立即执行（避免启动后 10 秒内无数据），完成后自续链。
  const worldStateEpoch = this._worldStateEpoch;
  this._collectWorldState()
    .catch(() => {
      // 监听器抛错（如向前端 websocket 广播失败）等异常不得中断采集链：
      // 吞掉 rejection 后仍正常续链，否则链从未建立、世界时间/天气永久停止同步
      // （Node EventEmitter 会同步向上传播监听器异常使 async 采集函数 reject）
    })
    .then(() => {
      // 仅代际未变（未被 stop）才续链
      if (worldStateEpoch === this._worldStateEpoch) {
        this._scheduleWorldState();
      }
    });
  this._collectStats();
}

// 玩家状态采集调度（串行化）：递归 setTimeout，上一轮完成后才排下一轮。
// 代际 epoch：stop 时自增使在途回调（timer 已触发、await 挂起中）恢复后
// 不再续链，避免 stop→start 后新旧两条链并存
export function _schedulePlayerStats() {
  const epoch = this._playerStatsEpoch;
  this._playerStatsTimer = setTimeout(async () => {
    this._playerStatsTimer = null;
    try {
      await this._collectPlayerStats();
    } catch {
      // 监听器抛错（playerStatsUpdate/performanceUpdate 广播失败）等异常
      // 不得中断采集链：吞掉后仍续排下一轮
    }
    // 仅代际未变（未被 stop）才续链
    if (epoch === this._playerStatsEpoch) {
      this._schedulePlayerStats();
    }
  }, 5000);
}

// MSPT 采集调度（串行化）：递归 setTimeout，上一轮完成后才排下一轮（30s 间隔）。
// 代际 epoch 防双链：stop 时自增使在途回调恢复后不再续链（同 _schedulePlayerStats）。
export function _scheduleMspt() {
  const epoch = this._msptEpoch;
  this._msptTimer = setTimeout(async () => {
    this._msptTimer = null;
    try {
      await this._collectMspt();
    } catch {
      // 监听器抛错（performanceUpdate 广播失败）等异常
      // 不得中断采集链：吞掉后仍续排下一轮
    }
    // 仅代际未变（未被 stop）才续链
    if (epoch === this._msptEpoch) {
      this._scheduleMspt();
    }
  }, 30000);
}

// 世界状态采集调度（串行化）：递归 setTimeout，上一轮完成后才排下一轮（10s 间隔）。
// 首轮由 _startStatsCollection 立即执行、完成后经本方法续链。
// 代际 epoch 防双链：stop 时自增使在途回调恢复后不再续链（同 _schedulePlayerStats）。
export function _scheduleWorldState() {
  const epoch = this._worldStateEpoch;
  this._worldStateTimer = setTimeout(async () => {
    this._worldStateTimer = null;
    try {
      await this._collectWorldState();
    } catch {
      // 监听器抛错（performanceUpdate/weatherUpdate 广播失败）等异常
      // 不得中断采集链：吞掉后仍续排下一轮（否则 10s 定时器不再续排、采集永久停止）
    }
    // 仅代际未变（未被 stop）才续链
    if (epoch === this._worldStateEpoch) {
      this._scheduleWorldState();
    }
  }, 10000);
}

export function _stopStatsCollection() {
  if (this._statsTimer) {
    clearInterval(this._statsTimer);
    this._statsTimer = null;
  }
  if (this._msptTimer) {
    clearTimeout(this._msptTimer);
    this._msptTimer = null;
  }
  if (this._saveTimer) {
    clearInterval(this._saveTimer);
    this._saveTimer = null;
  }
  if (this._playerStatsTimer) {
    clearTimeout(this._playerStatsTimer);
    this._playerStatsTimer = null;
  }
  // 代际自增：作废在途采集回调（timer 已触发、await 挂起中）的续链
  this._playerStatsEpoch++;
  this._msptEpoch++;
  this._worldStateEpoch++;
  if (this._worldStateTimer) {
    clearTimeout(this._worldStateTimer);
    this._worldStateTimer = null;
  }
}

export function _collectStats() {
  if (!this.process || !this.isRunning) return;
  const pid = this.process.pid;
  if (!pid) return;

  const platform = process.platform;
  if (platform === 'win32') {
    const cmd = `wmic process where ProcessId=${pid} get WorkingSetSize,UserModeTime,KernelModeTime /format:csv`;
    exec(cmd, (err, stdout) => {
      if (err) return;
      try {
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        if (lines.length >= 2) {
          const parts = lines[lines.length - 1].split(',');
          const workingSet = parseInt(parts[parts.length - 1]) || 0;
          this._memoryUsage = workingSet / (1024 * 1024 * 1024);
        }
        this._emitPerformance();
      } catch {}
    });
  } else {
    // Linux: 从 /proc/[pid]/stat 读取 CPU 时间，计算瞬时使用率
    this._collectLinuxStats(pid);
  }
}

export function _collectLinuxStats(pid) {
  try {
    const statContent = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const parts = statContent.match(/\(.*?\)|\S+/g) || [];
    // parts[0]=pid, parts[1]=comm, parts[11]=utime, parts[12]=stime, parts[21]=starttime
    const utime = parseInt(parts[11]) || 0;
    const stime = parseInt(parts[12]) || 0;
    const totalCpu = utime + stime;

    // 从 /proc/[pid]/statm 读取 RSS（驻留内存页数），转换为 GB
    // statm[1] = resident pages，乘以页大小（通常 4KB）
    try {
      const statmContent = fs.readFileSync(`/proc/${pid}/statm`, 'utf-8').trim();
      const statmParts = statmContent.split(/\s+/);
      const rssPages = parseInt(statmParts[1]) || 0;
      const pageSize = 4096;
      const rssBytes = rssPages * pageSize;
      this._memoryUsage = Math.round(rssBytes / (1024 * 1024 * 1024) * 100) / 100;
    } catch {
      // statm 读取失败，保留旧值
    }

    // 从 /proc/stat 读取系统总 CPU 时间用于计算
    const sysStat = fs.readFileSync('/proc/stat', 'utf-8');
    const cpuLine = sysStat.match(/^cpu\s+([\d\s]+)$/m);
    const sysTotal = cpuLine ? cpuLine[1].trim().split(/\s+/).reduce((a, b) => a + parseInt(b), 0) : 0;

    // 使用 _lastCpuTime 做差分计算瞬时 CPU
    if (this._lastCpuTime === undefined) {
      this._lastCpuTime = { cpu: totalCpu, sys: sysTotal, time: Date.now() };
      this._cpuUsage = 0;
      this._emitPerformance();
      return;
    }

    const last = this._lastCpuTime;
    const now = Date.now();
    const elapsed = (now - last.time) / 1000; // 秒
    const cpuDiff = totalCpu - last.cpu;
    const sysDiff = sysTotal - last.sys;
    this._lastCpuTime = { cpu: totalCpu, sys: sysTotal, time: now };

    // clkTck = 100 (标准 Linux)，所以 diff/clkTck = diff/100 秒
    const clkTck = 100;
    const cpuSeconds = cpuDiff / clkTck;
    const sysSeconds = sysDiff / clkTck;
    // 瞬时 CPU% = cpuSeconds / elapsed / cpuCoreCount * 100
    // 但单进程不能超过 100%，使用 min(100, ...)
    const cpuPercent = sysSeconds > 0
      ? Math.min(100, Math.round((cpuSeconds / elapsed) * 100 * 100) / 100)
      : 0;
    this._cpuUsage = Math.max(0, cpuPercent);
    this._emitPerformance();
  } catch {
    // 兜底: 使用 ps 命令
    exec(`ps -p ${pid} -o rss=,pcpu= 2>/dev/null || echo "0 0"`, (err, stdout) => {
      if (err) return;
      try {
        const parts = stdout.trim().split(/\s+/);
        const rssKb = parseInt(parts[0]) || 0;
        this._memoryUsage = rssKb / (1024 * 1024);
        this._cpuUsage = Math.min(100, parseFloat(parts[1]) || 0);
        this._emitPerformance();
      } catch {}
    });
  }
}

// 通过 RCON 查询 MSPT（tick query）
export async function _collectMspt() {
  if (!this.isRconConnected) return;
  // 查询 MSPT：RCON 命令输出只回显给 RCON 客户端、不回显到 stdout 日志流，
  // 原实现"发送后丢弃、在日志流中解析"导致 MSPT 采集永久失效（恒为 0）。
  // 改为 await 并直接解析响应。
  try {
    const response = await this._rconSend('tick query');
    // Paper / Vanilla 1.20.3+：'... mean: X.XX ms, median: ...'
    const meanMatch = String(response || '').match(/mean:\s*([\d.]+)\s*ms/i);
    if (meanMatch) {
      this._mspt = parseFloat(meanMatch[1]);
      return;
    }
    // tick 命令不可用（旧版 vanilla）：回退 tps 命令（Paper 系列），
    // 由 TPS 反推每 tick 毫秒数（20 TPS = 50ms）
    const tpsResponse = await this._rconSend('tps');
    const tpsMatch = String(tpsResponse || '').match(
      /TPS from last 5s, 1m, 5m:\s*([\d.]+)/i
    );
    if (tpsMatch) {
      const tps = parseFloat(tpsMatch[1]);
      if (tps > 0) this._mspt = 1000 / tps;
    }
  } catch {
    // 命令不可用/失败：静默跳过，下次定时器会重试
  }
}

/// 定期采集世界状态（时间、天气），实现自然变化的实时同步。
/// 每 10 秒执行一次：
///   - 通过 RCON 查询 time query daytime（兼容旧版和 MC 26.1+ 新格式）
///   - 通过 RCON 查询 time query gametime 计算世界天数
///   - 从 level.dat 读取天气状态（自然天气变化不会产生日志，必须轮询）
/// 任何值变化时推送 performanceUpdate / weatherUpdate 事件给前端。
export async function _collectWorldState() {
  if (!this.process || !this.isRunning) return;

  let changed = false;

  // 1. 通过 RCON 查询世界时间 (0-24000) 与世界天数，兼容新旧 MC 版本。
  //    - MC 26.2+: time query minecraft:day 返回 timeline 当前循环内 tick，
  //      time set 后能正确反映（gametime 是总 tick，不会随 time set 变化，
  //      不能用于计算当前时间）
  //    - 旧版: time query daytime 返回 0-24000
  if (this.isRconConnected) {
    try {
      const timeState = await this._queryWorldTime();
      if (timeState) {
        if (timeState.time != null && timeState.time !== this._worldTime) {
          this._worldTime = timeState.time;
          changed = true;
        }
        if (timeState.day != null && timeState.day !== this._worldDay) {
          this._worldDay = timeState.day;
          changed = true;
        }
      }
    } catch {}
  }

  // 2. 从 level.dat 读取天气状态（不依赖 RCON）
  //    自然天气变化不会产生控制台日志，只能通过轮询 level.dat 同步。
  //    level.dat 在服务器存档时更新，默认存档间隔 5 分钟，可接受。
  const newWeather = this._readWeatherFromLevelDat();
  if (newWeather && newWeather !== this._weather) {
    this._weather = newWeather;
    this.emit('weatherUpdate', { weather: this._weather });
  }

  // 4. 状态有变化时推送 performanceUpdate（含 worldTime/worldDay）
  if (changed) {
    this._emitPerformance();
  }
}

/// 查询世界时间（0-24000 tick）与世界天数，兼容新旧 MC 版本。
///
/// 时间来源（会随 time set 变化，是正确的时间来源）：
/// 1. MC 26.2+：`time query minecraft:day`（返回 timeline 当前循环内 tick）
/// 2. 旧版：`time query daytime`（返回 0-24000）
/// 3. 兜底：`time query gametime` 总 tick % 24000（gametime 不随 time set 变化）
///
/// 天数统一用 `time query gametime` / 24000 计算（gametime 是总 tick，反映真实世界年龄；
/// MC 26.2 的 `minecraft:day repetition` 不表示真实天数，不能采用）。
///
/// 返回 { time, day }，失败返回 null。
export async function _queryWorldTime() {
  // 1. MC 26.2+：timeline 查询
  //    输出: "Timeline minecraft:day is at 13000 tick(s)"
  try {
    const dayResult = await this._rconSend('time query minecraft:day');
    const dayMatch = dayResult.match(/is at\s+(\d+)\s+tick/i);
    if (dayMatch) {
      const time = parseInt(dayMatch[1], 10);
      const day = await this._queryWorldDay();
      return { time, day };
    }
  } catch {}

  // 2. 旧版：time query daytime（0-24000）
  //    输出: "The time is 13000"
  try {
    const daytimeResult = await this._rconSend('time query daytime');
    const daytimeMatch = daytimeResult.match(/The time is\s+(\d+)/i);
    if (daytimeMatch) {
      const time = parseInt(daytimeMatch[1], 10);
      const day = await this._queryWorldDay();
      return { time, day };
    }
  } catch {}

  // 3. 兜底：time query gametime % 24000
  try {
    const gametimeResult = await this._rconSend('time query gametime');
    const gameMatch = gametimeResult.match(/(\d+)/);
    if (gameMatch) {
      const totalTicks = parseInt(gameMatch[1], 10);
      return { time: totalTicks % 24000, day: Math.floor(totalTicks / 24000) };
    }
  } catch {}
  return null;
}

/// 通过 gametime 计算世界天数（总 tick / 24000）。
/// gametime 是自世界创建以来的累计 tick，不随 time set 变化，反映真实世界年龄。
export async function _queryWorldDay() {
  try {
    const gametimeResult = await this._rconSend('time query gametime');
    const gameMatch = gametimeResult.match(/(\d+)/);
    if (gameMatch) return Math.floor(parseInt(gameMatch[1], 10) / 24000);
  } catch {}
  return null;
}

/// 通过 RCON 定期采集在线玩家的血量、坐标、入睡状态
/// 每 5 秒执行一次（_schedulePlayerStats 递归 setTimeout 串行化），通过 playerStatsUpdate 事件推送给前端
/// 同时更新 _sleepingPlayers 计数，变化时推送 performanceUpdate
export async function _collectPlayerStats() {
  // 无在线玩家时清零入睡计数
  if (this.players.size === 0) {
    if (this._sleepingPlayers !== 0) {
      this._sleepingPlayers = 0;
      this._emitPerformance();
    }
    return;
  }

  // 检查 RCON 配置（不检查实际连接状态，_rconSend 会自动建立连接）。
  // 复用 isRconConnected getter：它每次重读磁盘 server.properties 并顺带刷新
  // 内存缓存（files 路由编辑/游戏内命令会写回文件）。旧代码
  // `this.properties || this._loadProperties()` 兜底重读分支恒不生效——
  // 构造时缓存的对象恒为 truthy（{} 也是对象），文件编辑启用 enable-rcon 或
  // 修改 rcon.password 后采集仍按陈旧快照跳过或使用旧密码。
  if (!this.isRconConnected) {
    return;
  }

  // 确保 RCON 连接已建立，失败则跳过本次采集
  try {
    await this._rconEnsureConnected();
  } catch (e) {
    logger.warn(`[${this.id}] RCON connect failed in _collectPlayerStats: ${e.message}`);
    return;
  }

  const stats = [];
  let sleepingCount = 0;
  for (const [name] of this.players) {
    try {
      // 串行查询，避免 RCON 并发导致响应错乱
      const healthResult = await this._rconSend(`data get entity ${name} Health`).catch(e => {
        logger.warn(`[${this.id}] RCON Health query failed for ${name}: ${e.message}`);
        return null;
      });
      const posResult = await this._rconSend(`data get entity ${name} Pos`).catch(e => {
        logger.warn(`[${this.id}] RCON Pos query failed for ${name}: ${e.message}`);
        return null;
      });
      const sleepResult = await this._rconSend(`data get entity ${name} SleepTimer`).catch(e => {
        logger.warn(`[${this.id}] RCON SleepTimer query failed for ${name}: ${e.message}`);
        return null;
      });
      // 护甲：使用 /attribute 按属性名查询最终值（含装备加成）
      // 旧代码用 Attributes[4].base 硬编码索引，插件改变属性顺序时会读到错误值
      const armorVal = await this._queryAttribute(
        (cmd) => this._rconSend(cmd),
        name,
        'minecraft:generic.armor',
        'minecraft:armor'
      );

      let health = null;
      let armor = null;
      let position = null;
      let isSleeping = false;

      if (healthResult) {
        // 返回格式: "Steve has the following entity data: 20.0f"
        const m = healthResult.match(/:\s*([\d.]+)/);
        if (m) health = parseFloat(m[1]);
      }
      if (armorVal != null) {
        armor = armorVal;
      }
      if (posResult) {
        // 返回格式: "Steve has the following entity data: [1.0d, 64.0d, 2.0d]"
        const m = posResult.match(/\[(-?[\d.]+)[dD]?, (-?[\d.]+)[dD]?, (-?[\d.]+)[dD]?\]/);
        if (m) position = { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
      }
      if (sleepResult) {
        // 返回格式: "Steve has the following entity data: 100"
        // SleepTimer > 0 表示玩家正在床上（在床上时递增 0→100，离开床时归零）
        const m = sleepResult.match(/:\s*(-?\d+)/);
        if (m && parseInt(m[1], 10) > 0) {
          isSleeping = true;
          sleepingCount++;
        }
      }

      // 更新内存中的玩家数据
      const player = this.players.get(name);
      if (player) {
        if (!player._cachedDetails) player._cachedDetails = {};
        if (health != null) player._cachedDetails.health = health;
        if (armor != null) player._cachedDetails.armor = armor;
        if (position != null) player._cachedDetails.position = position;
        // 检测入睡/清醒状态变化，发射事件供通知面板显示
        const wasSleeping = player._cachedDetails.isSleeping === true;
        // SleepTimer 查询失败（RCON 超时/卡顿）≠ 起床：跳过状态更新，
        // 沿用缓存状态，避免误发 playerSleep(false) + wake 事件并改写缓存
        if (sleepResult != null) {
          if (wasSleeping !== isSleeping) {
            player._cachedDetails.isSleeping = isSleeping;
            this.emit('playerSleep', { name, sleeping: isSleeping });
            // 细分入睡（sleep）/ 起床（wake）事件，供日志树状时间线区分
            this._addPlayerEvent(name, isSleeping ? 'sleep' : 'wake', isSleeping ? '入睡' : '起床');
          } else {
            player._cachedDetails.isSleeping = isSleeping;
          }
        } else if (wasSleeping) {
          // 查询失败但缓存仍为入睡：沿用缓存计入入睡计数，避免计数瞬时清零抖动
          sleepingCount++;
        }
      }

      stats.push({ name, health, armor, position, isSleeping });
    } catch (e) {
      // 单个玩家查询失败，跳过
      logger.warn(`[${this.id}] Player stats query failed for ${name}: ${e.message}`);
    }
  }

  if (stats.length > 0) {
    this.emit('playerStatsUpdate', { players: stats });
  }

  // 入睡计数变化时推送 performanceUpdate（前端 MC 时钟卡片依赖此字段）
  if (sleepingCount !== this._sleepingPlayers) {
    this._sleepingPlayers = sleepingCount;
    this._emitPerformance();
  }
}
