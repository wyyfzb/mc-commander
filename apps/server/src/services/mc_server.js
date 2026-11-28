import { EventEmitter, once } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import { Rcon } from 'rcon-client';
import { parseUncompressed as parseNbtSync } from 'prismarine-nbt';
import config from '../config.js';
import { InstanceModel, CommandHistoryModel, getDb } from '../db/index.js';
import { atomicWriteFile, ensureDir } from '../utils/fs-utils.js';
import { killProcessTree } from '../utils/process-tree.js';
import { maskSensitiveCommand } from '../utils/command-mask.js';
import { localDateKey } from '../utils/local-date.js';
// offline uuid / stats 时长读取全仓公共实现（与 routes/players.js 共用 player-utils.js）
import {
  offlineUuid as computeOfflineUuid,
  getTotalPlayTime,
  readUuidFromUsercache,
  readShadowProfile,
  resolveShadowProfilePath,
} from '../utils/player-utils.js';
import { isPathContained } from '../utils/fs-utils.js';
// addressReachability / isPrivateIp 复用 url-guard 的私有网段判定（SSRF 防护用的同一把尺子）：
// 地址「能不能发给玩家」与「能不能作为出站目标」用的是同一套可达性语义，
// 各写一份正则会漂移（如漏掉 100.64.0.0/10 这类 CGNAT 段）
import { addressReachability } from '../utils/url-guard.js';
import {
  getAllJavaVersions,
  getRecommendedJavaVersion,
  selectJavaPath,
} from '../utils/java-detector.js';
import { AppError, ErrorCodes } from '../utils/response.js';
import { checkInstanceReachability } from './port-reachability.js';
import { isBackupInProgress } from './backup.service.js';
import * as levelDat from './mc-server/level-dat.js';
import * as outputParser from './mc-server/output-parser.js';
import * as statsCollector from './mc-server/stats-collector.js';
import * as startLifecycle from './mc-server/start-lifecycle.js';
import * as adopt from './mc-server/adopt.js';
import * as logTail from './mc-server/log-tail.js';
import * as jarVersion from './mc-server/jar-version.js';
import * as rosterSync from './mc-server/roster-sync.js';
import * as msmpClient from './mc-server/msmp-client.js';
import * as msmpNotifications from './mc-server/msmp-notifications.js';
import * as msmpMethods from './mc-server/msmp-methods.js';
import * as crashArtifacts from './mc-server/crash-artifacts.js';
import * as gameruleReader from './mc-server/gamerule-reader.js';
import * as structuredLogConfig from './mc-server/structured-log-config.js';
import { logger } from '../utils/logger.js';

// 原子写统一走 utils/fs-utils.js 公共实现（写唯一 .tmp 再 rename，失败清残留）。
// 保留 re-export：routes/status.js（_syncInstanceJson 同步 instance.json）与
// routes/server-jar.js（创建实例首次写入 instance.json）仍从本文件导入，
// 避免这两个调用点各自定义本地副本。
// isEulaAccepted 同理：EULA 判定的唯一实现在 start-lifecycle 域（启动前置检查），
// 路由侧（POST /instances/:id/start）经此处消费，两侧不再各写一份正则。

// MC 命令执行失败的 RCON 响应短语。
// MC 服务器命令执行失败（离线玩家/未知物品/语法错误）不会抛异常，只输出错误文本，
// 需解析响应检测失败短语并抛错，否则前端会把失败误判为成功（如对离线玩家 give 显示"已给予"）。
// 成功命令（list/difficulty/time query 等）的输出不含这些短语，避免误判。
const COMMAND_FAILURE_PATTERNS = [
  /no player was found/i,
  /no entity was found/i,
  /unknown item/i,
  /unknown or incomplete command/i,
  /incorrect argument/i,
  /incorrect usage/i,
];

function matchCommandFailure(response) {
  for (const pattern of COMMAND_FAILURE_PATTERNS) {
    const m = response.match(pattern);
    if (m) return m[0];
  }
  return null;
}

export { atomicWriteFile };
export { isEulaAccepted } from './mc-server/start-lifecycle.js';

/**
 * 把实例的最新配置回写 instance.json。
 *
 * instance.json 只在创建实例时写一次，作用是 DB 记录丢失时的迁移兜底——不跟着改，
 * 兜底恢复出来的配置就是过期的（旧版本号、旧类型、旧内存档）。`type` 与 `mcVersion`
 * 必须在列：升级会换掉这两者，而它们决定「这个目录该按哪种服务端启动」。
 * 原子写（tmp + rename）避免半写 JSON 让兜底自己失效。
 */
export function syncInstanceJson(instance, { strict = false } = {}) {
  try {
    const configPath = path.join(instance.serverPath, 'instance.json');
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (existing?.id !== instance.id) {
      throw new Error('恢复快照的实例 ID 不匹配');
    }
    const updated = {
      ...existing,
      name: instance.name ?? existing.name,
      description: instance.description !== undefined ? instance.description : existing.description,
      type: instance.modLoader ?? existing.type,
      mcVersion: instance.mcVersion ?? existing.mcVersion,
      jarFile: instance.jarFile ?? existing.jarFile,
      maxMemory: instance.maxMemory ?? existing.maxMemory,
      minMemory: instance.minMemory ?? existing.minMemory,
      javaPath: instance.javaPath ?? existing.javaPath,
      startCommand: instance.startCommand ?? null,
      jvmArgs: instance.jvmArgs ?? null,
      autoStart: instance.autoStart ?? existing.autoStart,
      autoRestart: instance.autoRestart ?? existing.autoRestart,
      circuitBreakerCrashCount:
        instance.circuitBreakerCrashCount ?? existing.circuitBreakerCrashCount,
    };
    atomicWriteFile(configPath, JSON.stringify(updated, null, 2));
  } catch (e) {
    logger.warn('Failed to sync instance.json:', e.message);
    if (strict) throw e;
  }
}

export class MCServerManager extends EventEmitter {
  constructor() {
    super();
    this.instances = new Map();
    // 长任务进行中注册表（内存态）：部署与升级在阶段边界写入、终态移除。
    // websocket.js 在连接建立/订阅时读取并补发，刷新页面或重连后前端可恢复
    // 进行中显示（长阶段如 Forge 安装/首启期间事件稀疏，仅靠广播会零可见）。
    // 服务重启即失效——重启本身会中断未完成的长任务，无需持久化。
    this.activeDeploys = new Map();
    this.activeUpgrades = new Map();
    this.#loadInstances();
  }

  #loadInstances() {
    ensureDir(config.serversDir);

    const jsonInstances = new Map();
    let dirs;
    try {
      dirs = fs
        .readdirSync(config.serversDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      dirs = [];
    }

    for (const dir of dirs) {
      const configPath = path.join(config.serversDir, dir.name, 'instance.json');
      if (!fs.existsSync(configPath)) continue;

      try {
        const instanceConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!instanceConfig || typeof instanceConfig.id !== 'string' || instanceConfig.id === '') {
          throw new Error('instance.json 缺少有效 id');
        }
        const id = instanceConfig.id;
        if (jsonInstances.has(id)) {
          jsonInstances.set(id, null);
          logger.warn(`Multiple instance directories declare ID ${id}`);
        } else {
          jsonInstances.set(id, { config: instanceConfig, serverPath: path.dirname(configPath) });
        }
      } catch (e) {
        logger.error(`Failed to read instance.json in ${dir.name}:`, e);
      }
    }

    // 1. 从 SQLite 加载实例
    let dbInstances = [];
    try {
      dbInstances = InstanceModel.getAll();
      logger.info(`Loading ${dbInstances.length} instances from DB`);
    } catch (e) {
      logger.warn('Failed to load instances from DB, will try file system:', e.message);
    }

    const storedIds = new Set();
    for (const inst of dbInstances) {
      storedIds.add(inst.id);
      try {
        this.#loadStoredInstance(inst, jsonInstances.get(inst.id));
      } catch (e) {
        logger.error(`Failed to load DB instance ${inst.id}:`, e);
      }
    }

    for (const [id, local] of jsonInstances) {
      if (!local || storedIds.has(id)) continue;

      try {
        const stored = InstanceModel.getById(id);
        if (stored) {
          this.#loadStoredInstance(stored, local);
          continue;
        }
        if (InstanceModel.migrateFromJson(local.config, local.serverPath)) {
          this.createInstance({ ...local.config, serverPath: local.serverPath });
          logger.info(`Recovered instance ${id} from instance.json`);
        }
      } catch (e) {
        logger.error(`Failed to load/migrate instance ${id}:`, e);
      }
    }
  }

  #loadStoredInstance(instance, local) {
    const storedPath = instance.serverPath || path.join(config.serversDir, instance.id);
    // 已登记的有效目录优先；目录明确声明其他 ID 时不能在其中启动、备份或卸载。
    let serverPath = local?.serverPath;
    let recoveryConfig = local?.config;
    if (fs.statSync(storedPath, { throwIfNoEntry: false })?.isDirectory()) {
      try {
        const storedConfig = JSON.parse(
          fs.readFileSync(path.join(storedPath, 'instance.json'), 'utf8'),
        );
        if (storedConfig?.id === instance.id) {
          serverPath = storedPath;
          recoveryConfig = storedConfig;
        } else logger.warn(`Instance directory ${storedPath} does not match ID ${instance.id}`);
      } catch (err) {
        if (err.code === 'ENOENT') {
          serverPath = storedPath;
          recoveryConfig = undefined;
        } else logger.warn(`Cannot verify instance directory ${storedPath}:`, err.message);
      }
    }
    if (!serverPath) {
      logger.warn(`No unambiguous server directory for instance ${instance.id}`);
      return;
    }
    const snapshotCrashCount = recoveryConfig?.circuitBreakerCrashCount;
    // 崩溃时两份记录独立写入，任一有效记录仍处于熔断就必须保留保护。
    const circuitBreakerCrashCount = Math.max(
      Number.isSafeInteger(instance.circuitBreakerCrashCount)
        ? instance.circuitBreakerCrashCount
        : 0,
      Number.isSafeInteger(snapshotCrashCount) ? snapshotCrashCount : 0,
    );
    return this.createInstance({
      ...instance,
      serverPath,
      circuitBreakerCrashCount,
      javaPath: instance.javaPath || 'java',
      maxMemory: instance.maxMemory || '2G',
      minMemory: instance.minMemory || '1G',
    });
  }

  createInstance({
    id,
    name,
    javaPath = 'java',
    jarFile,
    maxMemory = '2G',
    minMemory = '1G',
    serverPath,
    modLoader,
    ...rest
  }) {
    if (this.instances.has(id)) {
      throw new AppError(ErrorCodes.INSTANCE_ID_CONFLICT);
    }
    const instancePath = serverPath || path.join(config.serversDir, id);
    ensureDir(instancePath);

    const instance = new MCServerInstance({
      id,
      name,
      javaPath,
      jarFile,
      maxMemory,
      minMemory,
      serverPath: instancePath,
      // type 是 instance.json 里的字段名（DB 丢失时的迁移兜底来源），两边同一语义
      modLoader: modLoader || rest.type,
      ...rest,
    });

    this.instances.set(id, instance);

    instance.on('log', (data) => this.emit('instance:log', { instanceId: id, ...data }));
    instance.on('status', (data) => {
      this.emit('instance:status', { instanceId: id, ...data });
      if (['started', 'ready', 'stopped', 'crash'].includes(data.event)) {
        instance._emitPushChannelState();
      }
    });
    instance.on('playerJoin', (data) =>
      this.emit('instance:playerJoin', { instanceId: id, ...data }),
    );
    instance.on('playerLeave', (data) =>
      this.emit('instance:playerLeave', { instanceId: id, ...data }),
    );
    instance.on('nameListChanged', (data) =>
      this.emit('instance:nameListChanged', { instanceId: id, ...data }),
    );
    instance.on('playerDeath', (data) =>
      this.emit('instance:playerDeath', { instanceId: id, ...data }),
    );
    instance.on('playerRespawn', (data) =>
      this.emit('instance:playerRespawn', { instanceId: id, ...data }),
    );
    instance.on('playerChat', (data) =>
      this.emit('instance:playerChat', { instanceId: id, ...data }),
    );
    instance.on('achievement', (data) =>
      this.emit('instance:achievement', { instanceId: id, ...data }),
    );
    instance.on('performanceUpdate', (data) =>
      this.emit('instance:performanceUpdate', { instanceId: id, ...data }),
    );
    instance.on('weatherUpdate', (data) =>
      this.emit('instance:weatherUpdate', { instanceId: id, ...data }),
    );
    instance.on('playerStatsUpdate', (data) =>
      this.emit('instance:playerStatsUpdate', { instanceId: id, ...data }),
    );
    instance.on('playerSleep', (data) =>
      this.emit('instance:playerSleep', { instanceId: id, ...data }),
    );
    instance.on('worldUpgrade', (data) =>
      this.emit('instance:worldUpgrade', { instanceId: id, ...data }),
    );

    return instance;
  }

  getInstance(id) {
    return this.instances.get(id);
  }

  getAllInstances() {
    return Array.from(this.instances.values()).map((i) => i.toStatus());
  }

  /** 运行中的实例对象（到期清扫要按实例扫官方封禁文件，DB 里未必有对应记录） */
  getRunningInstances() {
    return Array.from(this.instances.values()).filter((i) => i.isRunning);
  }

  // 显式停止全部运行中实例：等待 stop 命令送达 + MC 正常退出，超时兜底强杀，
  // 避免残留孤儿进程、在线玩家数据（离开事件/60s 保存）丢失。
  // 注意：面板停机（SIGTERM/SIGINT/崩溃）已不调用本方法——停机不停实例，
  // 由下次启动的 adoptOrphanInstances 接管。
  async stopAll({ timeout = 8000 } = {}) {
    await Promise.all(
      Array.from(this.instances.values())
        .filter((i) => i.isRunning)
        .map((instance) => instance.stopGracefully({ timeout })),
    );
  }
}

export class MCServerInstance extends EventEmitter {
  constructor({
    id,
    name,
    description,
    javaPath,
    jarFile,
    maxMemory,
    minMemory,
    serverPath,
    startCommand,
    jvmArgs,
    autoRestart,
    autoStart,
    circuitBreakerCrashCount,
    mcVersion,
    modLoader,
  }) {
    super();
    this.id = id;
    this.name = name;
    this.description = description ?? null;
    this.javaPath = javaPath;
    this.jarFile = jarFile;
    this.maxMemory = maxMemory;
    this.minMemory = minMemory;
    this.serverPath = serverPath;
    this.startCommand = startCommand || null;
    // 结构化 JVM 参数（闭环：实例级持久化，start() 无传参时使用）
    this.jvmArgs = Array.isArray(jvmArgs) ? jvmArgs : null;
    // 意外停止自动重启开关（DB 持久化，默认开）
    this.autoRestart = autoRestart !== undefined ? Boolean(autoRestart) : true;
    // DB 持久化的 MC 版本号（部署/升级时写入），运行时以此为准
    this.mcVersion = mcVersion || null;
    // 服务端类型（小写枚举，见 toStatus 里为何不从 jar 推断）
    this.modLoader = modLoader ? String(modLoader).toLowerCase() : null;
    // 是否主动停止（stop/kill 设置），用于区分「意外停止/崩溃」与「用户主动停止」
    this._manualStop = false;
    this.process = null;
    this.isRunning = false;
    this._startupReady = false;
    // 孤儿接管态：adopted=本实例进程非本面板 spawn、由 pid 文件接管而来。
    // 接管实例无 stdout/stdin 管道（this.process 保持 null），命令仅 RCON 通道，
    // 退出感知走看门狗轮询（adopt.js），this.process 众多守卫据此放行。
    this.adopted = false;
    this.adoptedPid = null;
    this._adoptTimer = null;
    // 接管实例日志续读（log-tail 域）：定时器与读取游标
    this._logTailTimer = null;
    this._logTailState = null;
    this.startTime = null;
    this.logBuffer = [];
    this.players = new Map();
    this.playerEvents = new Map();
    this._pendingIps = new Map();
    // 今日新增玩家计数缓存（{date: 'YYYY-MM-DD', count}）；跨天/服务重启后惰性全量重算
    this._todayNewCache = null;
    this.tps = null;
    this._mspt = 0;
    this._cpuUsage = 0;
    this._memoryUsage = 0;
    this._statsTimer = null;
    this.lastOutput = '';
    this.properties = this._loadProperties();
    // RCON 客户端（rcon-client 库管理连接/认证/分包）
    this._rconClient = null;
    this._rconConnecting = null;
    this._lastCpuTime = undefined;
    // Windows 采集告警去重位（见 stats-collector 的 win32 分支）：记的是 exec 层失败，
    // 只在「正常→失败」的转折处告警一次；每轮运行由 _initializeRuntimeState 复位
    this._win32StatsError = false;
    this._saveTimer = null;
    this._playerStatsTimer = null; // 玩家血量/坐标/入睡状态采集定时器
    this._playerStatsEpoch = 0; // 采集代际：stop 时自增，作废在途回调的续链
    this._msptTimer = null; // MSPT 采集定时器
    this._msptEpoch = 0; // MSPT 采集代际：stop 时自增，作废在途回调的续链
    this._worldStateTimer = null; // 世界状态（时间/天气）采集定时器
    this._worldStateEpoch = 0; // 世界状态采集代际：stop 时自增，作废在途回调的续链
    this._rosterTimer = null; // 在线名单对账定时器
    this._rosterEpoch = 0; // 名单对账代际：stop 时自增，作废在途回调的续链
    // MSMP 可用性：由名单查询实测得出（拿到结构化名单即记可用），不用版本号推断
    this._msmpAvailable = false;
    // MSMP 通知面（一期）连接状态：socket/定时器/退避，生命周期由 _msmpNotifStart/Stop 管
    this._msmpNotifActive = false;
    this._msmpNotifSocket = null;
    this._msmpNotifHeartbeat = null;
    this._msmpNotifPongTimer = null;
    this._msmpNotifReconnectTimer = null;
    this._msmpNotifBackoffMs = 0;
    this._msmpNotifAlive = false;
    // 可信连通状态：open 置真、close/error/stop 置假。`_msmpNotifAlive` 只表示
    // 「上一轮心跳有回音」（半开探测用），不能当连通性读——两者语义不同
    this._msmpNotifConnected = false;
    // 端点等待已累计的时长（有界等待窗口用）
    this._msmpNotifEndpointWaitedMs = 0;
    // 结构化日志覆盖配置的绝对路径：启动前置阶段解析（版本不达门槛时为 null＝不启用）
    this._structuredLogConfigPath = null;
    // 死亡事件聚合窗口：团灭等批量场景 5s 内合并为单条事件（防通知风暴）
    this._deathAggBuffer = [];
    this._deathAggTimer = null;
    this._restartTimer = null; // 崩溃自动重启定时器
    this._stopOperation = null;
    this._restartOperation = null;
    this._readyWhileStopping = false;
    // 崩溃循环熔断（运维韧性）
    this._consecutiveCrashes = 0;
    this._crashWindowStart = null;
    this.circuitBreakerCrashCount = Number.isSafeInteger(circuitBreakerCrashCount)
      ? Math.max(0, circuitBreakerCrashCount)
      : 0;
    this._crashRecoveryTimer = null;
    this.autoStart = autoStart === true; // 面板重启后自动恢复（DB 持久化，默认关）
    this._lastSaveTime = null; // 真实存档时刻（来自 "Saved the game" 日志）
    // 仪表盘扩展状态
    this._weather = 'clear'; // clear / rain / thunder
    this._worldTime = null; // 0-24000 ticks
    this._worldDay = null; // MC 世界天数
    this._sleepingPlayers = 0; // 入睡玩家数
    this._worldTimer = null; // 世界时间查询定时器
    this._publicIp = null; // 公网 IP（异步探测后缓存）
    this._worldSpawn = null; // 世界出生点 { x, y, z }（从 level.dat 读取）
    this._worldSpawnRaw = null; // 上次成功解析时 level.dat 的原始字节，运行期变更检测用
    // JAR 版本信息缓存 { statKey, value }：getAllInstances() 会逐实例走 toStatus()，
    // 无缓存时每次列表请求都要解压 55MB 的 jar（详见 jar-version.js 头注释）
    this._jarVersionCache = undefined;
    // 异步探测公网 IP（环境变量 → 云元数据 → ipify），不阻塞构造
    this._detectPublicIp();
    // 启动时读取世界出生点（纯文件 I/O，不阻塞）
    this._readWorldSpawnFromLevelDat();
    // 面板（重）启动时从 latest.log 回填当次运行日志，见方法注释
    this._loadLogBufferFromLatestLog();
  }

  /// 面板（重）启动时从 vanilla 的 latest.log 回填日志缓冲：
  /// logBuffer 是纯内存态，面板重启即清空——运行中实例的当次运行日志
  /// （含启动段）随面板重启从终端消失，孤儿接管场景同样断档。
  /// latest.log 由 MC 自身每次启动重写、持续落盘，天然就是「当次运行」
  /// 的权威日志；取尾部至多 1000 行（与 logBuffer 滚动上限一致）注入。
  /// start() 的 _initializeRuntimeState 仍会清空缓冲：新一次运行从空开始，
  /// 与 vanilla 重写 latest.log 的行为一致。只读尾部 2MB 按行切分，
  /// 避免长运行服务器全文件读入内存。
  _loadLogBufferFromLatestLog() {
    const logPath = path.join(this.serverPath, 'logs', 'latest.log');
    try {
      if (!fs.existsSync(logPath)) return;
      const size = fs.statSync(logPath).size;
      if (size === 0) return;
      const readBytes = Math.min(size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(readBytes);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buf, 0, readBytes, size - readBytes);
      } finally {
        fs.closeSync(fd);
      }
      let text = buf.toString('utf8');
      // 非整块起点时首行可能被截断（含 UTF-8 多字节边界），丢弃首行残段
      if (readBytes < size) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline >= 0) text = text.slice(firstNewline + 1);
      }
      const lines = this._filterLogNoise(text.replace(/\r/g, ''))
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .slice(-1000);
      if (lines.length === 0) return;
      this.logBuffer = lines.map((l) => ({ time: Date.now(), text: l, type: 'stdout' }));
      logger.info(`[${this.id}] Restored ${lines.length} log line(s) from latest.log`);
    } catch (e) {
      logger.warn(`[${this.id}] Failed to restore logs from latest.log:`, e.message);
    }
  }

  /// 世界出生点缓存（从 level.dat 读取）。
  /// 运行期惰性刷新：游戏内 /setworldspawn 会把新出生点写回 level.dat
  /// （随服务器存档落盘，默认约 5 分钟），玩家列表/详情读取时通过
  /// level.dat 原始字节对比检测变更后重读，避免 spawnPoint 一直显示旧坐标直到服务重启。
  /// 变更检测以内容级字节对比为唯一判定，禁止引入 mtime/size 等 stat 摘要
  /// 快速路径：粗粒度文件系统上同时间片内重写 mtime 不变、gzip 同尺寸
  /// size 不变，两者叠加会在窗口内漏检写回，出生点显示陈旧坐标（fix-1
  /// 回归，实测碰撞率高）。读盘成本可控：level.dat 读取是页缓存命中，
  /// 真正的开销在 NBT 解压解析，字节未变化时零解析。
  get _worldSpawn() {
    try {
      const levelName = this._getSafeLevelName();
      const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
      if (fs.existsSync(levelDatPath)) {
        const raw = fs.readFileSync(levelDatPath);
        // 内容级变更检测：仅在字节变化时重新解析，未变更时零解析开销
        if (!this._worldSpawnRaw || !raw.equals(this._worldSpawnRaw)) {
          this._readWorldSpawnFromLevelDat(raw);
        }
      }
    } catch {
      // 读取失败（文件被占用/瞬断等）：沿用缓存值，下次访问重试
    }
    return this._worldSpawnValue;
  }

  set _worldSpawn(value) {
    this._worldSpawnValue = value;
  }

  /// 异步探测公网 IP。
  /// 优先级：环境变量 PUBLIC_IP → 阿里云元数据服务 → ifconfig.me → null
  /// 探测结果缓存到 this._publicIp，供 _resolveServerAddress() 同步使用。
  /// 一键部署脚本会把探测值写进 .env 的 PUBLIC_IP，故正常部署走第一个分支、
  /// 不需要联网探测（探测链本身不可靠：多网卡/NAT 出口池会拿到非入口地址）。
  async _detectPublicIp() {
    // 1. 环境变量 PUBLIC_IP 优先（部署脚本写入 .env，或用户手改）
    if (process.env.PUBLIC_IP && process.env.PUBLIC_IP.trim()) {
      this._publicIp = process.env.PUBLIC_IP.trim();
      return;
    }
    // 2. 阿里云元数据服务（100.100.100.200，eipv4 = Elastic Public IP）
    try {
      const resp = await fetch('http://100.100.100.200/latest/meta-data/eipv4', {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const ip = (await resp.text()).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          this._publicIp = ip;
          return;
        }
      }
    } catch {}
    // 3. ifconfig.me 公网 IP 探测（国内可访问的备用服务）
    try {
      const resp = await fetch('http://ifconfig.me', {
        signal: AbortSignal.timeout(3000),
        headers: { 'User-Agent': 'curl/8.0' },
      });
      if (resp.ok) {
        const ip = (await resp.text()).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          this._publicIp = ip;
          return;
        }
      }
    } catch {}
    // 4. 探测失败，保持 null，_resolveServerAddress 回退到局域网 IP（标 private）
  }

  get isRconConnected() {
    // 每次重读文件而非仅读构造时缓存：files 路由编辑/游戏内命令会写回
    // server.properties（如启用 enable-rcon），内存缓存恒为 truthy 对象
    // （{} 也是对象），旧的 `this.properties || this._loadProperties()` 兜底
    // 重读分支永不生效，文件编辑后仍判 RCON 关闭。重读成功时顺带刷新缓存，
    // 供 toStatus 等后续读取最新值。
    const fresh = this._loadProperties();
    if (fresh && Object.keys(fresh).length > 0) {
      this.properties = fresh;
      return this.isRunning && fresh['enable-rcon'] === 'true' && !!fresh['rcon.password'];
    }
    // 文件缺失/解析失败：回退内存缓存（启动初期/无 properties 文件场景）
    return (
      this.isRunning &&
      this.properties['enable-rcon'] === 'true' &&
      !!this.properties['rcon.password']
    );
  }

  _loadProperties() {
    const propsPath = path.join(this.serverPath, 'server.properties');
    if (!fs.existsSync(propsPath)) return {};
    try {
      const content = fs.readFileSync(propsPath, 'utf-8');
      const props = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        // Java properties 的注释行以 `#` **或** `!` 起始；只认 `#` 时，
        // `! 说明 = 20` 这类注释会被当成键读出来（幽灵键流入界面与 API）
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex).trim();
          const value = trimmed.substring(eqIndex + 1).trim();
          props[key] = this._unescapePropertyValue(value);
        }
      }
      return props;
    } catch {
      return {};
    }
  }

  /// 属性值反解义：把 Java properties 的转义序列还原为字面值。
  /// 与 _escapePropertyValue 成对——只写不读会让 `minecraft\:normal` 这类转义形式
  /// 原样流到界面（实测世界类型显示成 `minecraft\:normal`），而它是文件格式的编码细节，
  /// 不是用户该看到的值。MC 自身按 properties 语义解析该文件，故读取侧必须同语义。
  _unescapePropertyValue(value) {
    const s = String(value);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '\\' || i === s.length - 1) {
        out += s[i];
        continue;
      }
      const next = s[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
        i += 4;
      } else {
        // \\ \: \= \# \! 等：反斜杠是转义前缀，丢弃它保留字面字符
        out += next;
      }
      i++;
    }
    return out;
  }

  /// 属性值转义：与 _unescapePropertyValue 成对，按 Java properties 语义编码。
  /// ① 反斜杠必须**最先**转义——否则会把后面新生成的 `\n`/`\r` 再转义一层，
  ///    写成 `\\n`（读回是字面 `\n` 两字符）而非换行；
  /// ② 值内真实换行（\n/\r）转成字面 "\\n"/"\\r"，防止单属性值内嵌换行走私多键注入
  ///    （server.properties 为逐行 key=value，真实换行会被当作行分隔符）；
  /// ③ 用户输入的**字面**反斜杠（如 motd 里的 `C:\temp`）必须转义成 `\\`：
  ///    MC 按 Java properties 解析该文件，未转义的 `\t` 会被读成制表符，
  ///    即面板存进去的值与 MC 实际读到的值不一致。
  _escapePropertyValue(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/\r\n/g, '\\n')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  /// 底层全量写：只落给定键值，不保留磁盘上已有的注释行。对外保存路径走
  /// saveProperties（它按 Java properties 语义把 `#` / `!` 注释行原样留住）。
  _saveProperties(props) {
    const propsPath = path.join(this.serverPath, 'server.properties');
    const lines = Object.entries(props).map(
      ([key, value]) => `${key}=${this._escapePropertyValue(value)}`,
    );
    atomicWriteFile(propsPath, lines.join('\n') + '\n');
    this.properties = props;
  }

  /// 公开方法：保存 server.properties（供 routes 调用）
  /// 保留原注释行（Java properties 里 `#` 与 `!` 都是注释起始符），仅更新键值对；
  /// 未在 props 中出现的键保留原值。
  /// 注释是**整行搬移**的：解析出的注释行统一落在文件开头，与它说明的键不再相邻。
  /// 这不丢信息——Java properties 语义下注释位置无意义，MC 自己只按 Properties 读写；
  /// 代价仅是人工阅读时的相邻性，为保留相邻性去维护「注释块 ↔ 键」映射不划算。
  /// 另：**MC 本身不带「每键注释」**。它写盘走 java.util.Properties.store，输出只有
  /// `#Minecraft server properties` 与 `#<日期>` 两行头 + 纯键值（26.3 实例文件实测如此，
  /// 该 store 的 load→store 往返还会把文件里已有的注释全部丢掉），所以这里不存在
  /// 「丢掉 MC 自带说明」的问题；磁盘上的用户注释反倒是本函数替 MC 多留的。
  /// 保留文件级"未知键自动追加"合并行为（files 路由直接编辑文件场景需要；
  /// API 路径的键白名单由 status-route 路由层负责）。
  saveProperties(props) {
    const propsPath = path.join(this.serverPath, 'server.properties');
    // 读取原文件，保留注释行。读取即判定：文件不存在（ENOENT）＝ 首次写入，
    // 直接从空基址起写；不做 existsSync 预检——预检判定「不存在」而窗口内文件
    // 被外部创建（files 路由/游戏内命令）时，会以空基址覆盖掉刚写入的整份配置
    let comments = [];
    let onDisk = {};
    try {
      const content = fs.readFileSync(propsPath, 'utf-8');
      comments = content.split('\n').filter((l) => /^[#!]/.test(l.trim()));
      // 合并基址取磁盘最新内容而非内存缓存：缓存仅构造时加载一次，
      // 文件被外部编辑（files 路由/游戏内命令）后不刷新，以陈旧缓存
      // 为基址会把文件编辑值回滚（如 max-players=100 被覆盖回 20）
      onDisk = this._loadProperties();
    } catch {
      /* 不存在或读失败：按空基址合并 */
    }
    // 合并：磁盘原属性 → 新属性覆盖
    const merged = { ...onDisk, ...props };
    const lines = [
      ...comments,
      ...Object.entries(merged).map(([key, value]) => `${key}=${this._escapePropertyValue(value)}`),
    ];
    atomicWriteFile(propsPath, lines.join('\n') + '\n');
    this.properties = merged;
  }

  /// 获取服务器对外可达地址（仪表盘顶栏展示 + 复制）。
  /// 优先级：公网 IP（环境变量 PUBLIC_IP 或自动探测）→ server.properties 的 server-ip
  ///         （非空、非 0.0.0.0）→ 本机局域网 IPv4 → localhost 兜底。
  /// 返回 { address, addressType }：addressType 由 addressReachability 按**地址本身**派生，
  /// 供前端标注「这条地址玩家能不能直连」。两条纪律：
  /// ① 不在前端重算——双端各算一次必然漂移；
  /// ② 不按来源判——同一个 IP 从哪个分支来都必须得到同一个结论。
  ///    按来源判会得到同值两判：「PUBLIC_IP=100.64.0.1」标 public 而
  ///    「server-ip=100.64.0.1」标 private，且网卡上挂着真实公网 IP 的机器
  ///    （探测失败时）会被误标成内网。
  _resolveServerAddress(props) {
    const port = props['server-port'] || '25565';
    // 优先使用公网 IP（云服务器场景下局域网 IP 对客户端不可达）。
    // PUBLIC_IP 由部署脚本或用户写入，值本身可能是内网（CGNAT、手填错误），故照值判。
    if (this._publicIp) {
      return {
        address: `${this._publicIp}:${port}`,
        addressType: addressReachability(this._publicIp),
      };
    }
    const ip = props['server-ip'];
    if (ip && ip.trim() && ip !== '0.0.0.0' && ip !== '::') {
      // server-ip 可能是公网，也可能是内网（同机房互连常见写法），按实际值判
      return { address: `${ip}:${port}`, addressType: addressReachability(ip) };
    }
    try {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            // 回退到网卡地址：是不是「玩家连不上」由地址本身决定，不由「走了兜底分支」决定——
            // 网卡上挂公网 IP 的机器（探测服务不可达时）不该被误标成内网。
            return {
              address: `${net.address}:${port}`,
              addressType: addressReachability(net.address),
            };
          }
        }
      }
    } catch {}
    // localhost 兜底：环回，本机以外一律连不上
    return { address: `localhost:${port}`, addressType: 'private' };
  }

  /// 校验可执行文件是否为合法 java 启动器（javaPath 校验）：
  /// - 路径形式（含路径分隔符/绝对路径）：必须 existsSync，且文件名符合 java 特征
  ///   （java/javaw/java.exe/javaw.exe）；
  /// - 纯命令名：仅允许 java 系列（走 PATH，existsSync 对 PATH 命令恒 false 无法预校验），
  ///   其余命令名（bash/sh/python/node/perl 等）一律拒绝。
  _isValidJavaExecutable(candidate) {
    const name = String(candidate || '').trim();
    if (!name) return false;
    const isPathLike = name.includes('/') || name.includes('\\') || path.isAbsolute(name);
    if (isPathLike) {
      if (!fs.existsSync(name)) return false;
      const base = path.basename(name);
      return /^java(?:w)?(?:\.exe)?$/i.test(base);
    }
    // 纯命令名：仅 java 系列，拒绝 bash/python/sh 等非 java 可执行
    return /^java(?:w)?(?:\.exe)?$/i.test(name);
  }

  /**
   * 启动前自愈已失效的 javaPath，返回是否替换过。
   *
   * 实例存的是**绝对路径**时会随 JDK 一起消失：面板自供的运行时按主版本装在
   * `<jreDir>/<主版本>/bin/java`，换档/重装/清理 JRE 目录后旧路径就断了；系统包
   * 升级删掉旧 openjdk 目录同理。此时启动抛的是「非法 javaPath…（仅允许 java
   * 可执行文件，拒绝 bash/python/sh 等）」——用户从没填过 bash，那句话把他引向
   * 一个不存在的问题，而真正该做的是重新选一个能用的 Java。
   *
   * 只在路径形态失效时介入：裸命令名（`java`）走 PATH、存在性无法预检，交给
   * spawn 的 ENOENT 报错；文件在但不可执行的权限问题也交给 spawn（替换 Java
   * 解决不了权限）。
   *
   * @returns {boolean} 是否把 javaPath 换成了别的可用路径
   */
  _repairStaleJavaPath() {
    const current = String(this.javaPath || '').trim();
    if (!current) return false;
    const isPathLike = current.includes('/') || current.includes('\\') || path.isAbsolute(current);
    // 裸命令名没有「路径失效」这回事；能通过校验就不动它
    if (!isPathLike) return false;
    if (this._isValidJavaExecutable(current)) return false;

    // 要求的主版本以**实例自己的 jar** 为准（version.json 是服务端自带的事实），
    // 拿不到才退回版本推荐表。不能拿「宿主装的最高版本」顶：那会把一台该跑
    // Java 17 的旧服推到 25 上，症状从「起不来」变成「起来后类版本不兼容」
    const required = this._requiredJavaMajor();
    const replacement = selectJavaPath(getAllJavaVersions(), required, (p) =>
      this._isValidJavaExecutable(p),
    );
    if (!replacement) {
      // 宿主没有任何满足要求的 Java。这里**不能**退回「随便挑一个能跑的」：
      // 用低版本 JVM 加载高版本 class 会抛 UnsupportedClassVersionError，
      // 用户看到的是看不懂的堆栈，且会误判成服务端坏了而不是缺 Java。
      // 启动前就把「缺哪个、怎么补」说清，是这条自愈唯一有意义的出口
      throw new AppError(
        ErrorCodes.INSTANCE_JAVA_UNAVAILABLE,
        `该实例需要 Java ${required}，但本机没有找到可用的版本` +
          `（当前配置的 ${current} 已失效）。请先安装 Java ${required}，或把实例切换到可在本机运行的版本`,
      );
    }
    if (replacement === current) return false;

    logger.warn(
      `[${this.id}] javaPath 已失效（${current}），改用 ${replacement}` +
        (required ? `（需要 Java ${required}）` : ''),
    );
    this.javaPath = replacement;
    // 落库：不写回则面板重启后又是坏路径，用户每次启动都要重新触发一次自愈
    try {
      InstanceModel.update(this.id, { javaPath: replacement });
    } catch (e) {
      logger.warn(`[${this.id}] javaPath 自愈后写库失败（本次启动仍用新路径）:`, e.message);
    }
    return true;
  }

  /// 该实例需要的主 Java 版本：jar 内 version.json 优先，退回版本推荐表
  _requiredJavaMajor() {
    try {
      const info = this._getJarVersionInfo();
      if (info?.javaVersion) return String(info.javaVersion);
    } catch {
      // 读不到 jar（还没下载/损坏）：交给推荐表
    }
    return getRecommendedJavaVersion(this.mcVersion) || null;
  }

  /// 启动参数白名单校验（结构化参数）：
  /// 仅允许 -X/-D 前缀参数、'nogui' 与 '-jar'；'-jar' 的路径参数 resolve 后
  /// 必须位于 serverPath 内（越界拒绝）。非法参数抛错拒绝启动，
  /// 杜绝经 jvmArgs/旧 startCommand 注入任意可执行行为。
  /// 结构化 jvmArgs 补全基础参数（回归修复）：
  /// 客户端语义为「附加 JVM flags」（-jar 之前的 token，见 instance_settings_dialog），
  /// -Xmx/-Xms 由 maxMemory/minMemory 字段管理、-jar/nogui 由 jarFile 字段管理；
  /// 此处按该语义补全缺失项（已显式提供则尊重原值，如显式 -jar 视为完整参数），
  /// 补全后统一过白名单校验，保证 java 命令始终含可执行目标（防无主类退出）。
  _buildFullJvmArgs(extraArgs, serverPath) {
    const finalArgs = [];
    // -Xmx/-Xms 前置（与客户端启动命令预览顺序一致：内存 → flags → -jar）
    if (!extraArgs.some((a) => String(a).startsWith('-Xmx'))) {
      finalArgs.push(`-Xmx${this.maxMemory}`);
    }
    if (!extraArgs.some((a) => String(a).startsWith('-Xms'))) {
      finalArgs.push(`-Xms${this.minMemory}`);
    }
    finalArgs.push(...extraArgs);
    if (!extraArgs.includes('-jar')) {
      finalArgs.push('-jar', path.join(serverPath, this.jarFile), 'nogui');
    }
    return this._validateJvmArgs(finalArgs, serverPath);
  }

  _validateJvmArgs(args, serverPath) {
    const result = [];
    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]);
      if (arg.startsWith('-X') || arg.startsWith('-D')) {
        result.push(arg);
        continue;
      }
      if (arg === 'nogui') {
        result.push(arg);
        continue;
      }
      if (arg === '-jar') {
        const jarArg = String(args[i + 1] ?? '');
        if (!jarArg || jarArg.startsWith('-')) {
          throw new Error('启动参数 -jar 缺少 jar 文件路径');
        }
        if (!isPathContained(serverPath, jarArg)) {
          throw new Error(`启动参数 -jar 的 jar 路径越出实例目录: ${jarArg}`);
        }
        result.push('-jar', jarArg);
        i++;
        continue;
      }
      throw new Error(`不支持的启动参数: ${arg}（仅允许 -X/-D 前缀、-jar 与 nogui）`);
    }
    return result;
  }

  /// 旧 startCommand 兼容解析（兼容读取）：
  /// 旧实例配置的 startCommand / 调用方传入的字符串命令解析为 命令+参数，
  /// 逐项校验（可执行文件 java 特征 + 参数白名单），不合法时拒绝启动并报清晰错误，
  /// 而不是静默按自由字符串执行。
  _parseLegacyStartCommand(cmdStr) {
    const parts = String(cmdStr).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      throw new Error('启动命令为空');
    }
    const command = parts[0];
    if (!this._isValidJavaExecutable(command)) {
      throw new Error(`非法启动命令: ${command}（仅允许 java 可执行文件，拒绝 bash/python/sh 等）`);
    }
    const args = this._validateJvmArgs(parts.slice(1), this.serverPath);
    return { command, args };
  }

  _syncRecoveryConfig() {
    syncInstanceJson(this);
  }

  get circuitBreakerTripped() {
    return this.circuitBreakerCrashCount > 0;
  }

  _cancelCrashRecovery() {
    if (this._crashRecoveryTimer) clearTimeout(this._crashRecoveryTimer);
    this._crashRecoveryTimer = null;
  }

  get startupState() {
    if (!this.isRunning) return 'stopped';
    if (this._startupReady) return 'ready';
    return this.process ? 'starting' : 'unknown';
  }

  _markStartupReady() {
    if (!this.isRunning || this._startupReady) return;
    if (this._manualStop) {
      if (this._stopOperation) this._readyWhileStopping = true;
      return;
    }
    this._startupReady = true;
    this._worldSizeDirty = true;
    this.refreshReachability().catch(() => {});
    this._observeCrashRecovery();
    this.emit('status', { event: 'ready' });
  }

  _observeCrashRecovery() {
    // 只认当次子进程的实时就绪日志；接管时旧日志和 PID 不能证明本次就绪。
    const child = this.process;
    if (
      !child ||
      !this.circuitBreakerTripped ||
      !this.isRunning ||
      this._manualStop ||
      this._crashRecoveryTimer
    )
      return;

    this._crashRecoveryTimer = setTimeout(() => {
      this._crashRecoveryTimer = null;
      if (
        child !== this.process ||
        child.exitCode != null ||
        child.signalCode != null ||
        !this.isRunning ||
        this._manualStop
      )
        return;
      this._resumeAutomaticStart();
    }, config.crashLoop.windowMs);
    this._crashRecoveryTimer.unref?.();
  }

  _resumeAutomaticStart() {
    try {
      const stored = InstanceModel.getById(this.id);
      if (!stored) throw new Error('找不到实例记录');
      // 快照单独承载保护时先补写 SQLite，快照清零后事务中断仍有保护。
      if (!(stored.circuitBreakerCrashCount > 0)) {
        InstanceModel.update(this.id, { circuitBreakerCrashCount: this.circuitBreakerCrashCount });
      }
      getDb().transaction(() => {
        if (!InstanceModel.update(this.id, { circuitBreakerCrashCount: 0 })) {
          throw new Error('找不到实例记录');
        }
        syncInstanceJson({ ...this, circuitBreakerCrashCount: 0 }, { strict: true });
      })();
    } catch (err) {
      logger.warn(`[${this.id}] Failed to resume automatic startup:`, err.message);
      this._observeCrashRecovery();
      return;
    }
    this.circuitBreakerCrashCount = 0;
    this._consecutiveCrashes = 0;
    this._crashWindowStart = null;
    this.emit('status', { event: 'auto_start_resumed' });
  }

  get lifecycleInProgress() {
    return Boolean(
      this._stopOperation?.sameRun() ||
        this._restartOperation ||
        (this.isRunning && this._manualStop),
    );
  }

  _assertNoBackupOperation() {
    if (isBackupInProgress(this.id)) throw new AppError(ErrorCodes.BACKUP_IN_PROGRESS);
  }

  start(startCommand) {
    this._assertNoBackupOperation();
    if (this.isRunning) {
      throw new Error('Server is already running');
    }

    if (!this._restartOperation?.launching) this.cancelRestart();
    this._manualStop = false;
    this._readyWhileStopping = false;
    // 新 spawn 覆盖一切接管残留态（接管实例 restart 必经看门狗确认退出后才到这）
    this.adopted = false;
    this.adoptedPid = null;

    // 子阶段编排（各阶段实现见 start-lifecycle.js，经原型注入 this 绑定实例）：
    // EULA 检查 → tempban 对账 → world 锁清理 → 结构化日志配置（写覆盖配置，供下一步注入 -D）
    // → 实时推送配置补齐（写 management-server-* 三项，服务器启动时读）
    // → 启动命令/参数构建（四种来源优先级）
    // → spawn 与进程/stdin/输出/exit 监听器挂载 → 运行时状态初始化 → 收尾
    // （started 事件 → 定时存档）。
    this._ensureEulaAccepted();
    this._reconcileTempBansSafe();
    this._cleanWorldLock();
    this._ensureStructuredLogConfig();
    // 实时推送配置也在启动前补齐：服务器本次启动即读到，用户零交互
    this._ensureMsmpConfiguredSafe();

    // 必须在解析启动命令之前：javaPath 已失效时，_resolveStartCommand 会先抛出
    // 「非法 javaPath」把用户引向一个不存在的问题
    this._repairStaleJavaPath();

    const { command, args } = this._resolveStartCommand(startCommand);
    this._spawnServerProcess(command, args);
    // pid 文件由服务端按 --pidFile 自己写出；接管侧用 /proc 兜住「文件还没写出」的窗口
    this._attachSpawnErrorListener();
    this._attachStdinErrorListener();
    this._initializeRuntimeState();
    this._attachOutputStreamListeners();
    this._attachExitListener();
    this._finalizeStartup();
  }

  async _rconEnsureConnected() {
    // 已有可用连接。注意：rcon-client 4.x 没有 connected getter（值为 undefined），
    // 连接建立后 socket 非空、close 时置 null，必须用 socket 判断，
    // 否则每次 _rconSend 都会新建连接，导致 RCON 连接/线程无限泄漏。
    if (this._rconClient && this._rconClient.socket) {
      return;
    }
    // 正在连接中，复用同一个 Promise
    if (this._rconConnecting) return this._rconConnecting;

    // 建立新连接前重读磁盘 server.properties：文件编辑/游戏内命令修改
    // rcon.password 后，内存缓存仍是构造时快照（恒为 truthy 对象，
    // `this.properties || this._loadProperties()` 式兜底重读分支永不生效），
    // 用陈旧密码认证会持续失败。重读成功时顺带刷新缓存。
    const fresh = this._loadProperties();
    if (fresh && Object.keys(fresh).length > 0) {
      this.properties = fresh;
    }
    const pwd = this.properties['rcon.password'] || '';
    const port = parseInt(this.properties['rcon.port'] || '25575', 10);

    const connecting = (async () => {
      // 手动 new Rcon 并先注册 error 监听再 connect：
      // rcon-client 的 Rcon.connect 在连接完成前没有对外暴露 error 监听，
      // MC 崩溃导致连接建立/认证期间 socket ECONNRESET 会触发
      // "Unhandled 'error' event"，使整个 node 进程崩溃
      // （自动重启 setTimeout 随之丢失，实例无法恢复）。
      const client = new Rcon({
        host: '127.0.0.1',
        port,
        password: pwd,
        timeout: 5000,
      });
      client.on('error', (err) => {
        logger.error(`RCON error on ${this.id}:`, err.message);
      });
      try {
        await client.connect();
      } catch (e) {
        // 连接失败（如 MC 未启动/已崩溃），清理 socket 引用，避免连接泄漏。
        // 注意：client.end() 是 async 方法，reject 需用 .catch 处理，
        // 同步 try/catch 捕获不到，否则触发 unhandledRejection 使 node 进程崩溃
        // （部署后 MC 未启动时 _collectWorldState 触发 RCON 连接失败即因此崩溃）。
        client.end().catch(() => {});
        throw e;
      }
      if (this._rconConnecting !== connecting) {
        client.end().catch(() => {});
        throw new Error('RCON connection cancelled');
      }
      this._rconClient = client;
      // 连接意外断开时清理引用，下次调用会自动重连
      client.on('end', () => {
        if (this._rconClient === client) {
          this._rconClient = null;
        }
        // 断连时统一拒绝该 client 队列中滞留的请求，避免 promise 永不 settle：
        // rcon-client 4.x 的 PromiseQueue 在断连时仅 pause()，sendPacket 的
        // createSendPromise（含 onEnd 监听与超时）只在 item 出队执行时才被调用，
        // 队列中滞留 item 的 resolve/reject 无人调用 → _rconSend 永不 settle，
        // 导致 _collectPlayerStats 串行链卡死、玩家详情 HTTP 挂起。
        // 这里依赖库内部结构（sendQueue.queue），包 try/catch 防御结构变化。
        try {
          const pending = client.sendQueue && client.sendQueue.queue;
          if (Array.isArray(pending) && pending.length > 0) {
            for (const item of pending) {
              const err = new Error('RCON connection closed');
              // 队列滞留项从未被 dequeue 执行 → 命令从未写入 socket，
              // 标记"确认未送达"：sendCommand 据此判断可安全回退 stdin
              // （与在途项 "Connection closed"（已发包、可能已执行）语义区分）
              err.rconConfirmedNotSent = true;
              item.reject(err);
            }
            pending.length = 0;
          }
        } catch {}
      });
    })();

    this._rconConnecting = connecting;
    try {
      await connecting;
    } finally {
      if (this._rconConnecting === connecting) this._rconConnecting = null;
    }
  }

  _rconCleanup() {
    if (this._rconClient) {
      // end() 是 async，reject 需用 .catch，避免 unhandledRejection 崩溃
      this._rconClient.end().catch(() => {});
      this._rconClient = null;
    }
    this._rconConnecting = null;
  }

  async _rconSend(command, assertCanSend) {
    try {
      await this._rconEnsureConnected();
    } catch (err) {
      // 连接建立失败：命令尚未进入 RCON 队列、未写入 socket → 确认未送达，
      // 标记供 sendCommand 判断可安全回退 stdin（此时不回退才会丢命令）
      if (err && typeof err === 'object') err.rconConfirmedNotSent = true;
      throw err;
    }
    assertCanSend?.();
    const client = this._rconClient;
    const queue = client?.sendQueue;
    if (!client?.socket) {
      throw Object.assign(new Error('RCON connection closed'), { rconConfirmedNotSent: true });
    }
    if (!assertCanSend || !queue?.add) return client.send(command);
    // rcon-client 4.x 同步入队；等待前一请求完成后才调用生成器写包。
    const add = queue.add;
    queue.add = (generate) =>
      add.call(queue, () => {
        assertCanSend();
        return generate();
      });
    try {
      return client.send(command);
    } finally {
      queue.add = add;
    }
  }

  /// 按属性名查询实体属性值，兼容 1.21.2+（26.x）属性ID前缀移除变更
  /// @param rconFn RCON 调用函数 (cmd) => Promise<string>
  /// @param name 实体名/玩家名
  /// @param oldId 旧版属性ID（含 generic. 前缀，≤1.21.1）
  /// @param newId 新版属性ID（无前缀，1.21.2+ / 26.x）
  /// @param useBase true=查基值(base get)，false=查最终值(get)
  /// @returns {number|null}
  async _queryAttribute(rconFn, name, oldId, newId, useBase = false) {
    const suffix = useBase ? ' base get' : ' get';
    // 旧版 (≤1.21.1): minecraft:generic.<attr>
    let result = await rconFn(`attribute ${name} ${oldId}${suffix}`).catch(() => null);
    if (result) {
      // /attribute get 输出: "Total value for attribute ... is 8.0"
      // /attribute base get 输出: "Base value of attribute ... is 20.0"
      const m = result.match(/is\s+([\d.]+)/);
      if (m) return parseFloat(m[1]);
    }
    // 新版 (1.21.2+ / 26.x): minecraft:<attr>（移除 generic. 前缀）
    result = await rconFn(`attribute ${name} ${newId}${suffix}`).catch(() => null);
    if (result) {
      const m = result.match(/is\s+([\d.]+)/);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  stop() {
    this._assertNoBackupOperation();
    const cancelled = this.cancelRestart();
    if (!this.isRunning && !cancelled) {
      throw new AppError(ErrorCodes.INSTANCE_NOT_RUNNING);
    }
    return this._stopCurrentRun();
  }

  stopGracefully(options) {
    this._assertNoBackupOperation();
    this.cancelRestart();
    return this._stopCurrentRun({ ...options, forceOnTimeout: true });
  }

  _stopCurrentRun({ timeout = 8000, forceOnTimeout = false } = {}) {
    const { process: child, adoptedPid } = this;
    if (!this.isRunning || (!child && !adoptedPid)) return Promise.resolve();
    const sameRun = this._currentRunGuard();
    if (this._stopOperation?.sameRun()) {
      this._stopOperation.forceOnTimeout ||= forceOnTimeout;
      return this._stopOperation.promise;
    }

    this._manualStop = true;
    this._cancelCrashRecovery();
    const { promise, resolve, reject } = Promise.withResolvers();
    const starting = this.startupState === 'starting';
    const operation = {
      sameRun,
      promise,
      starting,
      forceOnTimeout: forceOnTimeout || starting || Boolean(adoptedPid),
      terminating: false,
    };
    this._stopOperation = operation;
    this._confirmStop(operation, timeout).then(resolve, reject);
    return promise;
  }

  async _confirmStop(operation, timeout) {
    const { sameRun } = operation;
    try {
      const exited = this._waitForRunExit(sameRun, timeout);
      if (operation.starting) {
        // 启动期的控制台管道不依赖管理端口就绪。
        this._writeToStdin('stop\n');
      } else {
        const isCurrentRun = () => this._stopOperation === operation && sameRun();
        // 通道回执可能卡在请求队列，不能延长退出等待的上限。
        void Promise.resolve()
          .then(() => {
            if (isCurrentRun()) return this.stopServer({ isCurrentRun });
          })
          .catch(() => {});
      }
      await exited;
      if (!sameRun()) return;
      if (!operation.forceOnTimeout && !operation.terminating) {
        throw new AppError(ErrorCodes.INSTANCE_STOP_UNCONFIRMED);
      }
      if (!operation.terminating) this._terminateCurrentRun();
      // 接管看门狗负责收敛运行态，确认窗口须覆盖其一次完整轮询。
      await this._waitForRunExit(
        sameRun,
        this.adopted ? adopt.ADOPT_WATCHDOG_INTERVAL_MS + 250 : 2000,
      );
      if (sameRun()) throw new AppError(ErrorCodes.INSTANCE_STOP_UNCONFIRMED);
    } finally {
      if (this._stopOperation === operation) {
        this._stopOperation = null;
        if (sameRun()) {
          this._manualStop = false;
          if (this._readyWhileStopping) this._markStartupReady();
          else if (this._startupReady) this._observeCrashRecovery();
          this._readyWhileStopping = false;
        }
      }
    }
  }

  _waitForRunExit(sameRun, timeout) {
    if (!sameRun()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve();
      };
      const onStatus = () => {
        if (!sameRun()) finish();
      };
      const timer = setTimeout(finish, timeout);
      this.on('status', onStatus);
    });
  }

  restart() {
    this._assertNoBackupOperation();
    if (this._restartOperation) return this._restartOperation.promise;
    this.cancelRestart();
    const { promise, resolve, reject } = Promise.withResolvers();
    const operation = { promise, reject, launching: false };
    this._restartOperation = operation;
    this._restartCurrentRun(operation).then(resolve, reject);
    return promise;
  }

  async _restartCurrentRun(operation) {
    try {
      await this._stopCurrentRun();
      if (this._restartOperation !== operation) return;
      operation.launching = true;
      this.start();
      if (this._restartOperation !== operation) return;
      await once(this.process, 'spawn');
    } finally {
      if (this._restartOperation === operation) this._restartOperation = null;
    }
  }

  cancelRestart() {
    const cancelled = Boolean(this._restartTimer || this._restartOperation);
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    if (this._restartOperation) {
      this._restartOperation.reject(new AppError(ErrorCodes.TASK_CANCELLED, '重启已取消'));
      this._restartOperation = null;
    }
    return cancelled;
  }

  kill() {
    this._assertNoBackupOperation();
    this._manualStop = true;
    this._cancelCrashRecovery();
    this.cancelRestart();
    if (this._stopOperation?.sameRun()) this._stopOperation.terminating = true;
    this._terminateCurrentRun();
  }

  _terminateCurrentRun() {
    const pid = this.process?.pid ?? (this.adopted ? this.adoptedPid : null);
    if (pid) killProcessTree(this.process, { pid, detached: true });
    this._rconCleanup();
  }

  /// 向子进程 stdin 写入数据（统一入口，防 EPIPE 竞态崩溃）。
  /// sendCommand 的 isRunning 检查与 write 之间存在竞态窗口：kill() 同步杀进程、
  /// isRunning=false 需 exit 事件在下一轮事件循环派发，窗口内检查通过但管道已
  /// 关闭。对已销毁的流直接短路返回 false；存活流上 write 的 EPIPE 是异步 error
  /// 事件，由 start() 注册的 stdin error 监听消费（否则 unhandled 'error' event
  /// 崩溃整个 node 进程），同步异常由 try/catch 兜底。返回是否被流接受
  /// （false = 背压或已关闭，命令未投递）。
  _writeToStdin(data) {
    const stdin = this.process && this.process.stdin;
    if (!stdin || stdin.destroyed) return false;
    try {
      return stdin.write(data);
    } catch (err) {
      logger.warn(`[${this.id}] stdin write failed:`, err.message);
      return false;
    }
  }

  _currentRunGuard() {
    const { process, adoptedPid, startTime } = this;
    return () =>
      this.isRunning &&
      this.process === process &&
      this.adoptedPid === adoptedPid &&
      this.startTime === startTime;
  }

  _deliverConsoleCommand(command) {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || stdin.writable === false || stdin.writableEnded) {
      throw new AppError(ErrorCodes.COMMAND_NOT_SENT);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError(ErrorCodes.COMMAND_UNCONFIRMED)), 5000);
      const finish = (err) => {
        clearTimeout(timer);
        if (err) reject(new AppError(ErrorCodes.COMMAND_NOT_SENT));
        else resolve(null);
      };
      // write 返回 false 表示背压；只有写回调能确认管道是否接受。
      try {
        stdin.write(`${command}\n`, finish);
      } catch (err) {
        finish(err);
      }
    });
  }

  async sendCommand(
    command,
    { source = 'api', stopping = false, requireResponse = false, isCurrentRun } = {},
  ) {
    if (!this.isRunning || (!this.process && !this.adopted)) {
      throw new AppError(ErrorCodes.INSTANCE_NOT_RUNNING);
    }
    if (!stopping && this.startupState === 'starting') {
      throw new AppError(ErrorCodes.INSTANCE_STARTING);
    }
    command = command
      .trim()
      .replace(/^\/+/, '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
    if (!command) throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Command is required');
    const sameRun = this._currentRunGuard();
    const assertCanSend = () => {
      if (!sameRun() || (isCurrentRun && !isCurrentRun()))
        throw new AppError(ErrorCodes.COMMAND_NOT_SENT, '命令未送达：实例运行轮次已变更');
      if (
        isBackupInProgress(this.id) &&
        /^(?:minecraft:)?(?:save-(?:on|off|all)|stop)(?:\s|$)/i.test(command)
      ) {
        throw new AppError(
          ErrorCodes.BACKUP_IN_PROGRESS,
          '在线备份进行中，请等待备份完成后再执行该命令',
        );
      }
    };
    const auditCommand = maskSensitiveCommand(command);
    const startedAt = Date.now();
    let success = false;
    let response = null;
    try {
      assertCanSend();
      this.emit('log', { text: `> ${auditCommand}`, type: 'command' });
      if (this.isRconConnected) {
        try {
          response = await this._rconSend(command, assertCanSend);
          if (typeof response !== 'string') throw new AppError(ErrorCodes.COMMAND_UNCONFIRMED);
          const failure = matchCommandFailure(response);
          if (failure) {
            const err = new AppError(ErrorCodes.COMMAND_REJECTED, `命令执行失败: ${failure}`);
            err.isCommandExecutionError = true;
            throw err;
          }
          success = true;
          return response;
        } catch (err) {
          if (err instanceof AppError) throw err;
          // 已发包但没收到回执时不能重发给 stdin，命令可能已经生效。
          if (!err?.rconConfirmedNotSent) throw new AppError(ErrorCodes.COMMAND_UNCONFIRMED);
        }
      }
      assertCanSend();
      if (requireResponse) throw new AppError(ErrorCodes.RCON_UNAVAILABLE);
      if (!this.process && this.adopted) {
        throw new AppError(
          ErrorCodes.COMMAND_NOT_SENT,
          '接管实例无控制台管道且 RCON 不可用，命令未送达',
        );
      }
      await this._deliverConsoleCommand(command);
      success = true;
      return null;
    } finally {
      try {
        CommandHistoryModel.create({
          instanceId: this.id,
          command: auditCommand,
          source,
          success,
          // 审计只存回执是否存在；原始回包可能回显命令中的敏感参数。
          response: typeof response === 'string' ? '' : null,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // 审计写入失败不影响已发出的命令。
      }
    }
  }

  sendCommandWithResponse(command, { timeout = 5000 } = {}) {
    const sameRun = this._currentRunGuard();
    return new Promise((resolve, reject) => {
      if (!this.isRunning || (!this.process && !this.adopted)) {
        return reject(new Error('Server is not running'));
      }

      // 兜底：剥离前导 `/` —— RCON 同样不接受 `/` 前缀
      if (typeof command === 'string' && command.startsWith('/')) {
        command = command.replace(/^\/+/, '');
      }

      // 使用 RCON
      if (this.isRconConnected) {
        // 调用方级超时：rcon-client 仅在请求出队执行时才启动全局 5000ms 超时，
        // 队列滞留期（前序请求在途占满 maxPending=1）无任何超时计时，
        // 出队后的超时也非调用方传入值。这里手动计时强制 timeout 上限。
        let expired = false;
        const timeoutTimer = setTimeout(() => {
          expired = true;
          reject(new Error('Command timeout'));
        }, timeout);
        this._rconSend(command, () => {
          if (expired || !sameRun()) throw new Error('Command no longer applicable');
        }).then(
          (result) => {
            clearTimeout(timeoutTimer);
            resolve(result);
          },
          (err) => {
            clearTimeout(timeoutTimer);
            reject(err);
          },
        );
        return;
      }

      // 无第二通道可用：RCON 未连接时无法取得命令回执。
      // 不能退回自造的 `mcsmp_<id>` stdin 行协议：那个协议需要配套 Mod，而该 Mod 在
      // 全仓与 git 历史中都不存在 ⇒ 正常部署下这条路径无人应答，用户只能
      // 等到 5s 后一条含义不明的 `Command timeout`。明确报错比伪装成「发出去了」诚实。
      // （与外部增强通信的正统路径是官方 MSMP，见 config 的 management-server-* 键。）
      reject(new Error('Command response unavailable: RCON is not connected'));
    });
  }

  /// 死亡事件聚合发射：5s 窗口内单条保持原格式；多条（团灭等批量场景）
  /// 合并为 { players: [...], count: N } 单条广播，防通知风暴刷屏。
  /// 窗口内单条 → 前端按原格式解析；多条 → 前端按 players 数组逐条/合并展示。
  _emitDeathAggregated(playerName, cause, killer) {
    this._deathAggBuffer.push({ name: playerName, cause, killer });
    if (this._deathAggTimer) return;
    this._deathAggTimer = setTimeout(() => {
      this._deathAggTimer = null;
      const batch = this._deathAggBuffer;
      this._deathAggBuffer = [];
      if (batch.length === 1) {
        this.emit('playerDeath', batch[0]);
      } else {
        this.emit('playerDeath', { players: batch, count: batch.length });
      }
    }, 5000);
  }

  /** 性能读数的当前值。拼装与广播分开，是为了让「订阅即补一份」能复用同一份拼装 */
  _performancePayload() {
    // 基于内存中的玩家入睡状态聚合名称列表，供仪表盘卡片显示
    const sleepingPlayerNames = [];
    const awakePlayerNames = [];
    for (const [name, player] of this.players) {
      if (player?._cachedDetails?.isSleeping) {
        sleepingPlayerNames.push(name);
      } else {
        awakePlayerNames.push(name);
      }
    }
    return {
      cpu: this._cpuUsage,
      memory: this._memoryUsage,
      tps: this.tps,
      mspt: this._mspt || 0,
      worldTime: this._worldTime,
      worldDay: this._worldDay,
      sleepingPlayers: this._sleepingPlayers,
      sleepingPlayerNames,
      awakePlayerNames,
    };
  }

  _emitPerformance() {
    this.emit('performanceUpdate', this._performancePayload());
    // tps 随 performanceUpdate 的 payload 统一广播——契约里没有独立的 tps 事件
    // 事件（避免 websocket 双消息冗余）
  }

  /**
   * 刷新玩家连接可达性缓存。实例没在运行时直接归 null：那时端口本来就不监听，
   * 探出来的「连不上」是「没启动」而不是「端口没放行」，报给用户只会误导。
   */
  async refreshReachability() {
    if (!this.isRunning || this.startupState === 'starting') return null;
    const processIdentity = this.process ?? this.adoptedPid;
    const port = parseInt(this.properties['server-port'] || '0', 10);
    const result = await checkInstanceReachability({ port, publicHost: this._publicIp });
    if (!this.isRunning || processIdentity !== (this.process ?? this.adoptedPid)) return null;
    this._reachability = result.state;
    return this._reachability;
  }

  toStatus() {
    const props = this.properties;
    const uptimeMs = this.isRunning && this.startTime ? Date.now() - this.startTime : 0;
    // 地址与可达范围必须同源产出：分两处各算一次，会出现「地址是内网、类型却标公网」
    // 这类自相矛盾（前端只信 addressType 就会把内网地址当对外地址展示）
    const { address, addressType } = this._resolveServerAddress(props);
    return {
      id: this.id,
      name: this.name,
      isRunning: this.isRunning,
      startupState: this.startupState,
      // 可用通道分开报：「能不能执行命令」与「能不能读到结构化事实」是两件事。
      // rcon 判据是配置齐全且在运行（RCON 无握手概念，配置即判据，每次实时读）；
      // msmp 判据是**最近一次查询实测成功**（端口可随机、可被反代，配置推不出可用性）。
      // 实例已停时 msmp 一律报 false：那是上一次运行的残留实测值，不是当前状态。
      capabilities: {
        rcon: this.isRconConnected,
        // MSMP 查询面
        msmp: this.isRunning && this._msmpAvailable,
        // MSMP 推送面（常驻连接）：查询面成功不代表推送面连上了——端口随机、密钥由
        // 服务端生成写回，两者各自实测。实例已停时归零，避免显示上一次运行的残留
        msmpPush: this.isRunning && this._msmpNotifConnected,
      },
      // 意外停止自动重启开关（供前端设置页读写）
      autoRestart: this.autoRestart,
      uptime: Math.floor(uptimeMs / 1000),
      address,
      addressType,
      // 异步探测的结果缓存在实例上：toStatus 是同步方法且会被列表接口逐实例调用，
      // 在里面直接探端口会让一次列表请求退化成 N 次超时等待
      reachability:
        this.isRunning && this.startupState !== 'starting' ? (this._reachability ?? null) : null,
      players: Array.from(this.players.values()),
      playerCount: this.players.size,
      maxPlayers: parseInt(props['max-players'] || '20'),
      mcVersion: this._getMcVersion(),
      // 服务端类型取部署/升级时写入的记录，不从文件面推断：所有类型的落地 jar 都叫
      // server.jar（Forge 的启动 jar 由安装器生成），Paper/Purpur/Vanilla 三者在目录里
      // 没有可区分的痕迹，嗅探只会把 Paper 报成 Vanilla。小写形态与部署/升级请求里的
      // type 枚举同一口径，展示层再转标题形态。
      modLoader: (this.modLoader || 'vanilla').toLowerCase(),
      tps: this.tps,
      mspt: this._mspt,
      cpuUsage: this._cpuUsage,
      memoryUsage: this._memoryUsage,
      totalMemory: Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10,
      worldSize: this._getWorldSize(),
      seed: this._readSeedFromLevelDat(),
      lastSave: this._getLastSaveTime(),
      lastOutput: this.lastOutput,
      gameMode: props['gamemode'] || 'survival',
      difficulty: props['difficulty'] || 'easy', // 同上：与 vanilla 默认一致，别让读不到值时显示错难度
      whitelisted: props['white-list'] === 'true',
      onlineMode: props['online-mode'] !== 'false',
      viewDistance: parseInt(props['view-distance'] || '10'),
      spawnProtection: parseInt(props['spawn-protection'] || '16'),
      // ── 仪表盘原型扩展字段（真实数据）──
      worldDay: this._worldDay,
      worldTime: this._worldTime,
      weather: this._weather,
      opCount: this._getOnlineOpCount(),
      opNames: this._getOnlineOpList(),
      todayNewPlayers: this.getTodayNewPlayers(),
      sleepingPlayers: this._sleepingPlayers,
      sleepingPlayerNames: this._getSleepingPlayerNames(),
      awakePlayerNames: this._getAwakePlayerNames(),
      totalUptime: this._getTotalUptime(),
      startTime: this.startTime ? new Date(this.startTime).toISOString() : null,
      // ── 运维韧性字段──
      autoStart: this.autoStart,
      circuitBreakerTripped: this.circuitBreakerTripped,
      checkingStartupStability: this._crashRecoveryTimer !== null,
      consecutiveCrashes: this.circuitBreakerCrashCount || this._consecutiveCrashes,
      // ── 启动配置（供实例设置弹窗读写）──
      startCommand: this.startCommand,
      jvmArgs: this.jvmArgs,
      javaPath: this.javaPath,
      maxMemory: this.maxMemory,
      minMemory: this.minMemory,
      jarFile: this.jarFile,
    };
  }

  /// 今日新增玩家数：join 事件增量维护 + 跨天/重启后按会话记录全量重算。
  /// 新玩家会话历史不会触发 20 条上限截断，sessions[0].start 即首次登录时间，重算准确。
  getTodayNewPlayers() {
    const key = this._todayKey();
    if (this._todayNewCache && this._todayNewCache.date === key) return this._todayNewCache.count;

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    let count = 0;
    for (const [, info] of this.players) {
      if (info.sessions?.[0]?.start >= dayStart.getTime()) count++;
    }
    for (const [name] of this.getAllKnownPlayers()) {
      if (this.players.has(name)) continue;
      const sd = this._loadPlayerData(name) || {};
      if (sd.sessions?.[0]?.start >= dayStart.getTime()) count++;
    }
    this._todayNewCache = { date: key, count };
    return count;
  }

  /// 本地时区日期键（「今日新增」缓存的分桶键，见 utils/local-date.js）
  _todayKey() {
    return localDateKey();
  }

  /// 获取累计运行时长（秒）：数据库持久化的累计值 + 本次运行时长
  _getTotalUptime() {
    let total = 0;
    try {
      total = InstanceModel.getTotalUptime(this.id) || 0;
    } catch {}
    if (this.isRunning && this.startTime) {
      total += Math.floor((Date.now() - this.startTime) / 1000);
    }
    return total;
  }

  // 读取 ops.json 返回全部 OP 名称列表（内部辅助）
  _getAllOpNames() {
    try {
      const opsPath = path.join(this.serverPath, 'ops.json');
      if (fs.existsSync(opsPath)) {
        const ops = JSON.parse(fs.readFileSync(opsPath, 'utf-8'));
        if (Array.isArray(ops)) {
          return ops.map((op) => op.name).filter(Boolean);
        }
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  /// 统计在线 OP 数量（在线玩家 ∩ ops.json）
  _getOnlineOpCount() {
    const allOps = this._getAllOpNames();
    if (allOps.length === 0) return 0;
    let count = 0;
    for (const [name] of this.players) {
      if (allOps.includes(name)) count++;
    }
    return count;
  }

  /// 返回在线 OP 名称列表
  _getOnlineOpList() {
    const allOps = this._getAllOpNames();
    if (allOps.length === 0) return [];
    const online = [];
    for (const [name] of this.players) {
      if (allOps.includes(name)) online.push(name);
    }
    return online;
  }

  /// 返回当前入睡玩家名称列表（基于 RCON 采集的 isSleeping 状态）
  _getSleepingPlayerNames() {
    const names = [];
    for (const [name, player] of this.players) {
      if (player?._cachedDetails?.isSleeping) names.push(name);
    }
    return names;
  }

  /// 返回当前清醒玩家名称列表
  _getAwakePlayerNames() {
    const names = [];
    for (const [name, player] of this.players) {
      if (!player?._cachedDetails?.isSleeping) names.push(name);
    }
    return names;
  }

  getAllKnownPlayers() {
    const knownPlayers = new Map();

    const userCachePath = path.join(this.serverPath, 'usercache.json');
    if (fs.existsSync(userCachePath)) {
      try {
        const cache = JSON.parse(fs.readFileSync(userCachePath, 'utf-8'));
        for (const entry of cache) {
          if (entry.name) {
            knownPlayers.set(entry.name, {
              name: entry.name,
              uuid: entry.uuid || '',
              // usercache **不携带**最后在线时间：它的 expiresOn 是「条目创建 + 1 个月」
              // 的缓存过期时刻，与最后在线无关。拿它当 lastSeen 会显示一个
              // 看似权威、实为「缓存创建 + 1 个月」的时间。准确的 lastSeen 由自有影子
              // 档案提供（玩家离开时写入，见 _supplementKnownPlayersFromProfiles）。
              lastSeen: null,
            });
          }
        }
      } catch {}
    }

    const whitelistPath = path.join(this.serverPath, 'whitelist.json');
    if (fs.existsSync(whitelistPath)) {
      try {
        const whitelist = JSON.parse(fs.readFileSync(whitelistPath, 'utf-8'));
        for (const entry of whitelist) {
          if (entry.name && !knownPlayers.has(entry.name)) {
            knownPlayers.set(entry.name, {
              name: entry.name,
              uuid: entry.uuid || '',
              lastSeen: null,
            });
          }
          if (knownPlayers.has(entry.name)) {
            knownPlayers.get(entry.name).isWhitelisted = true;
          }
        }
      } catch {}
    }

    const opsPath = path.join(this.serverPath, 'ops.json');
    if (fs.existsSync(opsPath)) {
      try {
        const ops = JSON.parse(fs.readFileSync(opsPath, 'utf-8'));
        for (const entry of ops) {
          if (entry.name && !knownPlayers.has(entry.name)) {
            knownPlayers.set(entry.name, {
              name: entry.name,
              uuid: entry.uuid || '',
              lastSeen: null,
            });
          }
          if (knownPlayers.has(entry.name)) {
            knownPlayers.get(entry.name).isOp = true;
          }
        }
      } catch {}
    }

    const bannedPath = path.join(this.serverPath, 'banned-players.json');
    if (fs.existsSync(bannedPath)) {
      try {
        const banned = JSON.parse(fs.readFileSync(bannedPath, 'utf-8'));
        for (const entry of banned) {
          if (entry.name && !knownPlayers.has(entry.name)) {
            knownPlayers.set(entry.name, {
              name: entry.name,
              uuid: entry.uuid || '',
              lastSeen: null,
            });
          }
          if (knownPlayers.has(entry.name)) {
            knownPlayers.get(entry.name).isBanned = true;
            knownPlayers.get(entry.name).banReason = entry.reason || '';
          }
        }
      } catch {}
    }

    // 自有影子档案补足：usercache 会被 MC 按 expiresOn 剪枝（条目创建 + 1 个月），
    // 只依赖它会让历史玩家从名单里静默消失；且它是唯一携带准确 lastSeen 的来源。
    this._supplementKnownPlayersFromProfiles(knownPlayers);

    return knownPlayers;
  }

  /// 用 `playerdata/<uuid>.json` 补足已知玩家名单。
  /// 文件名即 UUID（档案按 UUID 落盘），档案内的 `name`/`lastSeen` 由本仓在玩家离开时写入。
  _supplementKnownPlayersFromProfiles(knownPlayers) {
    const dir = path.join(this.serverPath, 'playerdata');
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return; // 目录不存在＝从未有玩家落盘
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      if (!isPathContained(dir, filePath)) continue;
      let profile;
      try {
        profile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        continue; // 半写/损坏的档案跳过，不影响其余玩家
      }
      const name = typeof profile?.name === 'string' && profile.name ? profile.name : null;
      if (!name) continue;
      const uuid = file.slice(0, -'.json'.length);
      const entry = knownPlayers.get(name) || { name, uuid, lastSeen: null };
      if (!entry.uuid) entry.uuid = uuid;
      // 档案是唯一准确的最后在线来源：有值就用它，没有则保持未知（不拿别的字段顶替）
      if (profile.lastSeen) entry.lastSeen = profile.lastSeen;
      knownPlayers.set(name, entry);
    }
  }

  /// MC 版本：以服务端 JAR 内 version.json 为权威（用户绕过面板手动换 jar 或外部升级
  /// 后仍准确），DB 字段仅作 JAR 不可读时的回退。
  /// 该值被两处功能性消费——gamerule 版本选集（1.21.11 前后规则名体系不同）与
  /// 推荐 JDK——故陈旧值会让面板选错规则表、推荐错 Java，不只是显示不准。
  _getMcVersion() {
    const info = this._getJarVersionInfo();
    if (info?.id) return info.id;
    // JAR 不可读（Fabric/Forge 的启动 jar 由安装器生成、不含 version.json，或实例
    // 目录尚未产出 jar）：回退 DB 持久化版本（部署/升级时写入）
    if (this.mcVersion) return this.mcVersion;
    return 'unknown';
  }

  getLogs(lines = 100) {
    return this.logBuffer.slice(-lines);
  }

  _getPlayerUuid(playerName) {
    return readUuidFromUsercache(this.serverPath, playerName);
  }

  /// 影子档案路径：键是 UUID，不是玩家名（改名不再断链，见 player-utils 的
  /// shadowProfileKey / shadowProfilePath）。返回 null 表示键越界——usercache 是本机文件、可被篡改，
  /// 落点仍须自证，UUID 化不能替代这一层。
  _shadowProfilePath(playerName, uuid) {
    return resolveShadowProfilePath({ serverPath: this.serverPath, playerName, uuid });
  }

  _savePlayerData(playerName, data) {
    try {
      const dir = path.join(this.serverPath, 'playerdata');
      const filePath = this._shadowProfilePath(playerName);
      if (!filePath) return;
      ensureDir(dir);
      const existing = this._loadPlayerData(playerName) || {};
      // 浅拷贝后再删除：调用方（60s 定时保存、玩家离开落盘）传入的是 this.players
      // 的内存 player 对象同一引用，直接 delete data._cachedDetails 会把写盘时的
      // 清理副作用强加于运行时内存状态，导致下一轮采集把「持续入睡」误判为
      // 「刚入睡」，每 60 秒重复触发 playerSleep 事件并重复记录 sleep 事件。
      const dataCopy = { ...data };
      const cached = { ...(dataCopy._cachedDetails || {}) };
      delete dataCopy._cachedDetails;
      // 总游戏时长由 join/leave 累加维护，不从 RCON 缓存覆盖
      delete cached.totalPlayTime;
      delete cached.onlineTime;
      // 持久化行为事件（成就/死亡/入睡等）：合并既有文件与内存事件并去重，
      // 保证服务端重启/玩家离线后详情页历史不丢。内存上限 50 条，持久化同样收敛。
      const savedEvents = Array.isArray(existing.events) ? existing.events : [];
      const memEvents = this.playerEvents.get(playerName) || [];
      const mergedEvents = this._mergePlayerEvents(savedEvents, memEvents).slice(0, 50);
      // 原子写（先写唯一 .tmp 再 rename 覆盖）：直接 writeFileSync 覆盖（默认 flag 'w'
      // 先 truncate 再写）在 60s 定时保存/离开保存中途进程崩溃或断电时，会残留半写 JSON；
      // 重启后 _loadPlayerData 解析失败静默返回 null，下一次保存把旧 totalPlayTime/事件/
      // lastSeen 全部清空归零。原子写崩溃只影响 .tmp（finally 清理），目标文件保持完整。
      atomicWriteFile(
        filePath,
        JSON.stringify(
          {
            ...existing,
            ...dataCopy,
            ...cached,
            _cachedDetails: undefined,
            events: mergedEvents,
            // lastSeen 语义为「最后离线时间」：仅在玩家离开/服务器退出时由调用方
            // 设置为离线时刻。日常 60s 自动保存/在线保存不得用 Date.now() 覆盖，
            // 否则「最后在线时间」会被刷成「最后保存时间」。
            lastSeen: dataCopy.lastSeen ?? existing.lastSeen ?? null,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      // 写盘失败（磁盘满/权限异常等）不得静默吞掉：
      // 60s 定时保存与离开/停机最终保存都会走这里，失败意味着
      // 玩家累计时长/事件/lastSeen 回退丢失，必须留日志可排查
      logger.error(`[${this.id}] Failed to save player data for ${playerName}:`, e.message);
    }
  }

  _loadPlayerData(playerName) {
    return readShadowProfile({ serverPath: this.serverPath, playerName });
  }

  // ══════════════════════════════════════════════════════════
  // 玩家物品栏 / 末影箱数据获取
  // 方案：dat 文件解析（可靠快照）+ RCON 在线实时查询（截断降级）
  // ══════════════════════════════════════════════════════════

  // 从 JSON 文本名称中提取纯文本（MC 名称格式 {"text":"名字"} 或纯字符串）
  _extractTextName(raw) {
    if (!raw) return null;
    const s = String(raw);
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed;
      return parsed.text || (Array.isArray(parsed.extra) && parsed.extra[0]?.text) || s;
    } catch {
      return s;
    }
  }

  // 将单个 NBT 物品（prismarine-nbt 解析后的对象）转换为客户端格式
  // 兼容两种结构：list 内元素（无 value 包装）和独立 compound（有 value 包装）
  _parseNbtItem(nbtItem) {
    if (!nbtItem) return null;
    const v = nbtItem.value || nbtItem;
    const rawId = v.id?.value ?? v.id;
    const id = String(rawId || '').replace(/^minecraft:/, '');
    if (!id || id === 'minecraft:air') return null;

    const count = v.Count?.value ?? v.count?.value ?? 1;
    const slot = v.Slot?.value ?? v.slot?.value ?? 0;

    // 附魔检测：旧版 tag.Enchantments / 新版 components."minecraft:enchantments"
    let enchanted = false;
    const tag = v.tag?.value;
    if (tag?.Enchantments?.value?.length > 0) enchanted = true;
    const components = v.components?.value;
    if (components) {
      for (const key of Object.keys(components)) {
        if (key === 'minecraft:enchantments' || key === 'minecraft:stored_enchantments') {
          enchanted = true;
          break;
        }
      }
    }

    // 自定义名称
    let customName = null;
    if (tag?.display?.value?.Name?.value) {
      customName = this._extractTextName(tag.display.value.Name.value);
    }
    if (!customName && components) {
      const cn =
        components['minecraft:custom_name']?.value || components['minecraft:item_name']?.value;
      if (cn) customName = this._extractTextName(cn);
    }

    return { id, count: Math.max(1, count), slot, durability: null, enchanted, customName };
  }

  // 将已解析的物品列表构建为客户端 PlayerInventory 结构
  // invList/enderList 元素应为 { id, count, slot, ... } 格式（由 _parseNbtItem 或 _parseSnbtItem 解析）
  _buildInventoryResult(invList, enderList, source, isPartial = false) {
    const quickbar = new Array(9).fill(null);
    const main = new Array(27).fill(null);
    const equipment = {
      helmet: null,
      chestplate: null,
      leggings: null,
      boots: null,
      offhand: null,
    };
    const enderChest = new Array(27).fill(null);

    const place = (item) => {
      if (!item) return;
      const { slot, ...data } = item;
      if (slot >= 0 && slot <= 8) quickbar[slot] = data;
      else if (slot >= 9 && slot <= 35) main[slot - 9] = data;
      else if (slot === 103) equipment.helmet = data;
      else if (slot === 102) equipment.chestplate = data;
      else if (slot === 101) equipment.leggings = data;
      else if (slot === 100) equipment.boots = data;
      else if (slot === -106) equipment.offhand = data;
    };

    for (const item of invList || []) place(item);
    for (const item of enderList || []) {
      if (!item) continue;
      const { slot, ...data } = item;
      if (slot >= 0 && slot <= 26) enderChest[slot] = data;
    }

    return { quickbar, main, equipment, enderChest, source, partial: !!isPartial };
  }

  // 从 playerdata/<uuid>.dat 读取物品栏（gzip NBT），返回快照数据
  _loadInventoryFromDat(uuid, playerName) {
    // level-name 服务层兜底校验：非法/越界回退 'world'
    const levelName = this._getSafeLevelName();
    const candidates = [
      // MC 26.1+ 新世界格式：players/data
      path.join(this.serverPath, levelName, 'players', 'data', `${uuid}.dat`),
      path.join(this.serverPath, 'world', 'players', 'data', `${uuid}.dat`),
      // 旧格式：playerdata
      path.join(this.serverPath, levelName, 'playerdata', `${uuid}.dat`),
      path.join(this.serverPath, 'world', 'playerdata', `${uuid}.dat`),
      path.join(this.serverPath, 'playerdata', `${uuid}.dat`),
    ];
    const offlineUuid = computeOfflineUuid(playerName);
    if (offlineUuid && offlineUuid !== uuid) {
      candidates.push(
        path.join(this.serverPath, levelName, 'players', 'data', `${offlineUuid}.dat`),
      );
      candidates.push(path.join(this.serverPath, 'world', 'players', 'data', `${offlineUuid}.dat`));
      candidates.push(path.join(this.serverPath, levelName, 'playerdata', `${offlineUuid}.dat`));
      candidates.push(path.join(this.serverPath, 'world', 'playerdata', `${offlineUuid}.dat`));
      candidates.push(path.join(this.serverPath, 'playerdata', `${offlineUuid}.dat`));
    }

    let datPath = null;
    for (const c of candidates) {
      // 兜底防御：候选路径 resolve 后必须位于 serverPath 内，越界丢弃
      if (!isPathContained(this.serverPath, c)) continue;
      if (fs.existsSync(c)) {
        datPath = c;
        break;
      }
    }
    if (!datPath) return null;

    try {
      const raw = fs.readFileSync(datPath);
      const decompressed = zlib.gunzipSync(raw);
      const parsed = parseNbtSync(decompressed);
      const root = parsed?.value || parsed || {};

      // NBT list 结构: { type: 'list', value: { type: 'compound', value: [...] } }
      // 实际数组在 .value.value，兼容直接为数组的旧格式
      const extractList = (tag) => {
        if (!tag) return [];
        const v = tag.value;
        return Array.isArray(v) ? v : v?.value || [];
      };

      // 兼容新旧字段名（1.20.5+ 用小写）
      const invList = extractList(root.Inventory)
        .map((i) => this._parseNbtItem(i))
        .filter(Boolean);
      const enderList = extractList(root.EnderItems)
        .map((i) => this._parseNbtItem(i))
        .filter(Boolean);

      // MC 26.1+ 新增 equipment 字段（装备物品独立存储，不在 Inventory 列表中）
      const eqNbt = root.equipment?.value || root.Equipment?.value;
      if (eqNbt && typeof eqNbt === 'object') {
        const eqSlots = { head: 103, chest: 102, legs: 101, feet: 100, offhand: -106 };
        for (const [key, slotNum] of Object.entries(eqSlots)) {
          const item = this._parseNbtItem(eqNbt[key]);
          if (item) {
            item.slot = slotNum;
            invList.push(item);
          }
        }
      }

      return this._buildInventoryResult(invList, enderList, 'snapshot');
    } catch (e) {
      logger.warn(`[${this.id}] Failed to read player dat for ${playerName}:`, e.message);
      return null;
    }
  }

  // 在线玩家 RCON 实时查询物品栏（带截断降级）
  // 返回 { inventory, source } —— 成功解析返回 'realtime'，截断返回 null（由调用方降级到快照）
  async _loadInventoryFromRcon(playerName) {
    if (!this.isRconConnected) return null;
    const _r = (cmd) => this.sendCommandWithResponse(cmd, { timeout: 5000 }).catch(() => null);
    try {
      const invResult = await _r(`data get entity ${playerName} Inventory`);
      const enderResult = await _r(`data get entity ${playerName} EnderItems`);

      const invNbt = this._extractNbtFromResponse(invResult || '');
      const enderNbt = this._extractNbtFromResponse(enderResult || '');
      if (!invNbt) return null;

      // 截断检测：MC 输出过长会截断，且 RCON 单包 4096 字节限制
      const invComplete = invNbt.trim().endsWith(']');
      const enderComplete = !enderNbt || enderNbt.trim().endsWith(']');
      if (!invComplete || !enderComplete) return null; // 截断，降级到快照

      // 解析 SNBT 物品列表
      const invList = this._parseSnbtItemList(invNbt);
      const enderList = enderNbt ? this._parseSnbtItemList(enderNbt) : [];
      if (invList.length === 0 && enderList.length === 0) return null;

      return this._buildInventoryResult(invList, enderList, 'realtime', false);
    } catch {
      return null;
    }
  }

  // 从 RCON 响应文本提取 NBT 部分（"Player has the following entity data: [...]"）
  //
  // 起点取首个 `[` 或 `{` 中**位置靠前者**，不能只找 `{`：
  // `data get entity <玩家> Inventory` 返回的是**列表** `[{...},{...}]`，只找 `{` 会
  // 丢掉最外层 `[`。丢了它会有两处连锁后果（都让实时背包恒不可用）：
  //   ① `_parseSnbtItemList` 靠 `/\[(.*)\]/s` 匹配 ⇒ 永不命中，返回空列表；
  //   ② 截断检测判「完整」的条件是 `endsWith(']')` ⇒ 丢 `[` 后提取结果以 `}` 结尾，
  //      即便解析能命中也会先被判成「已截断」而返回 null。
  // 两者叠加使在线玩家背包**恒降级为 `.dat` 快照**（用户一直看到「数据来自上次存档
  // 快照，可能非实时」）。找 `{` 对单对象返回（如 `data get entity <玩家> SelectedItem`
  // 或 NBT 对象形态）仍然正确，故取二者较小者而非改成只找 `[`。
  _extractNbtFromResponse(text) {
    if (!text) return null;
    const objIdx = text.indexOf('{');
    const listIdx = text.indexOf('[');
    const candidates = [objIdx, listIdx].filter((i) => i !== -1);
    if (candidates.length === 0) return null;
    return text.substring(Math.min(...candidates));
  }

  // 简化 SNBT 物品列表解析：用括号匹配提取每个顶层 {} 物品，再正则提取字段
  // 适用于 Inventory/EnderItems 的 [{...},{...}] 格式
  _parseSnbtItemList(snbt) {
    if (!snbt) return [];
    // 提取最外层 [...] 内的内容
    const listMatch = snbt.match(/\[(.*)\]/s);
    if (!listMatch) return [];
    const inner = listMatch[1];

    const items = [];
    let depth = 0,
      start = -1,
      inStr = false,
      strCh = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (inStr) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        strCh = ch;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          items.push(inner.substring(start, i + 1));
          start = -1;
        }
      }
    }

    return items.map((snbtItem) => this._parseSnbtItem(snbtItem)).filter(Boolean);
  }

  // 解析单个物品 SNBT 字符串（简化版，提取 id/count/slot，附魔检测）
  _parseSnbtItem(snbt) {
    // id: "minecraft:xxx" 或 'minecraft:xxx'
    const idMatch = snbt.match(/id:\s*["']([^"']+)["']/i);
    if (!idMatch) return null;
    const id = idMatch[1].replace(/^minecraft:/, '');
    if (!id || id === 'air') return null;

    // count: Count:1b（旧版）或 count:1（新版）
    const countMatch = snbt.match(/(?:Count|count):\s*(\d+)/i);
    const count = countMatch ? Math.max(1, parseInt(countMatch[1], 10)) : 1;

    // slot: Slot:0b（旧版）或 slot:0（新版）
    const slotMatch = snbt.match(/(?:Slot|slot):\s*(-?\d+)/i);
    const slot = slotMatch ? parseInt(slotMatch[1], 10) : 0;

    // 附魔检测
    const enchanted =
      /Enchantments:\s*\[/i.test(snbt) ||
      /"minecraft:enchantments"/i.test(snbt) ||
      /"minecraft:stored_enchantments"/i.test(snbt);

    // 自定义名称（简化提取）
    let customName = null;
    const nameMatch =
      snbt.match(/Name:\s*'(\{[^']*\})'/) || snbt.match(/"minecraft:custom_name":\s*'([^']*)'/);
    if (nameMatch) customName = this._extractTextName(nameMatch[1]);

    return { id, count, slot, durability: null, enchanted, customName };
  }

  async getPlayerDetails(playerName) {
    const player = this.players.get(playerName);
    const savedData = this._loadPlayerData(playerName);

    // 合并事件：内存（实时）优先，合并 playerdata（服务端重启后不丢失）
    const memEvents = this.playerEvents.get(playerName) || [];
    const savedEvents = Array.isArray(savedData?.events) ? savedData.events : [];
    const events = this._mergePlayerEvents(savedEvents, memEvents);

    // 会话历史：内存（含当前在线会话）或 playerdata
    const sessions =
      player?.sessions && player.sessions.length > 0
        ? player.sessions
        : Array.isArray(savedData?.sessions)
          ? savedData.sessions
          : [];

    // 统计（优先 MC 官方真实统计，回退会话/事件聚合）
    const stats = this._computePlayerStats(sessions, events, player, playerName);

    const details = {
      name: playerName,
      isOnline: this.players.has(playerName),
      health: null,
      maxHealth: null,
      hunger: null,
      xpLevel: null,
      xpProgress: null,
      gameMode: null,
      dimension: null,
      position: null,
      spawnPoint: null,
      respawnPoint: null,
      events,
      totalPlayTime: 0,
      sessions,
      stats,
      inventory: null,
    };

    // 优先使用我自行追踪的累计游戏时长（来自 playerdata 持久化）
    const accumulatedTime = player?.totalPlayTime || savedData?.totalPlayTime || 0;
    const sessionSeconds = player?.joinTime ? Math.floor((Date.now() - player.joinTime) / 1000) : 0;
    details.totalPlayTime = accumulatedTime + sessionSeconds;

    // 尝试从 stats 文件读取总游戏时长（MC 官方统计）。
    // 与 players.js 列表接口取大值语义保持一致（仅当 stats 值更大时采用，
    // 避免 stats 文件缺失时清零）：
    // 仅当 stats 值更大时采用 stats，否则保留自追踪累计值 + 会话时长，
    // 避免 stats 文件缺失（getTotalPlayTime 返回 0）时把详情页总时长清零。
    const uuid = this._getPlayerUuid(playerName) || '';
    // uuid 空串（usercache 缺失）时 getTotalPlayTime 内部走 offline uuid 兜底
    const statsPlayTime = getTotalPlayTime({
      serverPath: this.serverPath,
      uuid,
      playerName,
      levelName: this._getSafeLevelName(),
    });
    if (statsPlayTime > details.totalPlayTime) {
      details.totalPlayTime = statsPlayTime;
    }

    // 物品栏：先尝试 dat 文件快照（离线/在线均可用，为上次存档的快照）。
    // _loadInventoryFromDat 内部有 offline uuid 兜底——uuid 空串传入即可
    const datInventory = this._loadInventoryFromDat(uuid, playerName);
    if (datInventory) details.inventory = datInventory;

    // 世界出生点：从 level.dat 缓存读取（离线/在线均可用）
    if (this._worldSpawn) {
      details.spawnPoint = { ...this._worldSpawn };
    }

    if (!this.isRunning) {
      return details;
    }

    // RCON 串行调用（MC 服务器并行 RCON 存在响应交叉问题）
    if (this.isRconConnected) {
      try {
        // 连接失败（如服务器重启/RCON 端口暂时不可达）时返回 null，
        // 绝不让连接错误消息（如 "connect ECONNREFUSED 127.0.0.1:25575"）混入数据解析
        const _r = (cmd) => this.sendCommandWithResponse(cmd, { timeout: 5000 }).catch(() => null);
        // 仅当响应是有效的 data get 成功输出（"xxx has the following entity data: 值"）时才解析，
        // 命令失败/连接错误的返回文本不包含该标记，直接跳过，避免被正则误解析为坐标/数值
        const _isValidDataGet = (resp) =>
          typeof resp === 'string' && resp.includes('has the following entity data');

        const posResult = await _r(`data get entity ${playerName} Pos`);
        const healthResult = await _r(`data get entity ${playerName} Health`);
        const hungerResult = await _r(`data get entity ${playerName} foodLevel`);
        const xpResult = await _r(`data get entity ${playerName} XpLevel`);
        const gmResult = await _r(`data get entity ${playerName} playerGameType`);
        const dimResult = await _r(`data get entity ${playerName} Dimension`);

        const posMatch = _isValidDataGet(posResult)
          ? posResult.match(/\[(-?[\d.]+)(?:d)?, (-?[\d.]+)(?:d)?, (-?[\d.]+)(?:d)?\]/)
          : null;
        if (posMatch) {
          details.position = {
            x: parseFloat(posMatch[1]),
            y: parseFloat(posMatch[2]),
            z: parseFloat(posMatch[3]),
          };
        }

        // 注意：data get entity 返回格式为 "玩家名 has the following entity data: 值"
        // 正则必须通过冒号定位避免匹配到玩家名中的数字
        const healthMatch = _isValidDataGet(healthResult)
          ? healthResult.match(/:\s*([\d.]+)/)
          : null;
        if (healthMatch) details.health = parseFloat(healthMatch[1]);

        // MaxHealth：使用 /attribute 按属性名查询基值（兼容新旧版属性ID变更）
        // 旧代码用 Attributes[0].base 硬编码索引，插件改变属性顺序时会读到错误值
        const maxHealthVal = await this._queryAttribute(
          _r,
          playerName,
          'minecraft:generic.max_health',
          'minecraft:max_health',
          true,
        );
        // 查不到就留 null（前端显示 --）：编造成 20 会与真实 health 组成错误比例，
        // 而「未知」这条路前端本来就支持
        details.maxHealth = maxHealthVal ?? null;

        // 护甲：使用 /attribute 查询最终值（含装备加成），兼容新旧版
        const armorVal = await this._queryAttribute(
          _r,
          playerName,
          'minecraft:generic.armor',
          'minecraft:armor',
        );
        if (armorVal != null) details.armor = armorVal;

        const hungerMatch = _isValidDataGet(hungerResult) ? hungerResult.match(/:\s*(\d+)/) : null;
        if (hungerMatch) details.hunger = parseInt(hungerMatch[1]);

        const xpMatch = _isValidDataGet(xpResult) ? xpResult.match(/:\s*(\d+)/) : null;
        if (xpMatch) details.xpLevel = parseInt(xpMatch[1]);

        const gmMatch = _isValidDataGet(gmResult) ? gmResult.match(/:\s*(\d+)/) : null;
        if (gmMatch) {
          const gm = parseInt(gmMatch[1]);
          const gmMap = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' };
          details.gameMode = gmMap[gm] || 'survival';
        }

        if (_isValidDataGet(dimResult)) {
          if (dimResult.includes('minecraft:the_nether')) {
            details.dimension = 'nether';
          } else if (dimResult.includes('minecraft:the_end')) {
            details.dimension = 'end';
          } else {
            details.dimension = 'overworld';
          }
        }

        // 个人复活点（床/重生锚），兼容新旧版数据格式：
        // - MC 1.21.2+/26.x : respawn compound（pos 为 Int Array，RCON 输出 [I; x, y, z]）
        // - 旧版（< 1.21.2）  : 顶层 SpawnX/SpawnY/SpawnZ 三个 Int
        let respawnPoint = null;
        const respawnPosResult = await _r(`data get entity ${playerName} respawn.pos`);
        // 匹配 [I; 100, 64, -50]、[100, 64, -50]、[100.0d, 64.0d, -50.0d] 等输出形态
        const respawnPosMatch = _isValidDataGet(respawnPosResult)
          ? respawnPosResult.match(
              /\[(?:I;\s*)?(-?[\d.]+)[a-zA-Z]?[\s,]+(-?[\d.]+)[a-zA-Z]?[\s,]+(-?[\d.]+)[a-zA-Z]?/,
            )
          : null;
        if (respawnPosMatch) {
          respawnPoint = {
            x: parseInt(respawnPosMatch[1], 10),
            y: parseInt(respawnPosMatch[2], 10),
            z: parseInt(respawnPosMatch[3], 10),
          };
        }

        // 旧版兜底：顶层 SpawnX/SpawnY/SpawnZ
        if (!respawnPoint) {
          const spawnXResult = await _r(`data get entity ${playerName} SpawnX`);
          const spawnXMatch = _isValidDataGet(spawnXResult)
            ? spawnXResult.match(/:\s*(-?[\d.]+)/)
            : null;
          if (spawnXMatch) {
            const spawnYResult = await _r(`data get entity ${playerName} SpawnY`);
            const spawnZResult = await _r(`data get entity ${playerName} SpawnZ`);
            const spawnYMatch = _isValidDataGet(spawnYResult)
              ? spawnYResult.match(/:\s*(-?[\d.]+)/)
              : null;
            const spawnZMatch = _isValidDataGet(spawnZResult)
              ? spawnZResult.match(/:\s*(-?[\d.]+)/)
              : null;
            if (spawnYMatch && spawnZMatch) {
              respawnPoint = {
                x: parseInt(spawnXMatch[1], 10),
                y: parseInt(spawnYMatch[1], 10),
                z: parseInt(spawnZMatch[1], 10),
              };
            }
          }
        }

        if (respawnPoint) {
          details.respawnPoint = respawnPoint;
        }

        // 缓存 RCON 获取的详情到玩家对象
        const playerEntry = this.players.get(playerName);
        if (playerEntry) {
          if (!playerEntry._cachedDetails) playerEntry._cachedDetails = {};
          Object.assign(playerEntry._cachedDetails, details);
        }

        // 物品栏增强：在线玩家尝试 RCON 实时查询，成功则覆盖 dat 快照
        // RCON 整包查询受 4096 字节限制，截断时降级保留 dat 快照
        const rconInventory = await this._loadInventoryFromRcon(playerName);
        if (rconInventory) details.inventory = rconInventory;

        return details;
      } catch (e) {
        logger.warn(`RCON 获取玩家详情失败 ${playerName}:`, e.message);
      }
    }

    // RCON 不可用时返回基本详情（health/position 等字段为 null）
    return details;
  }

  /// 合并玩家事件：内存（实时）与持久化（playerdata）去重合并，按时间倒序。
  /// 服务端重启后内存清空，需合并 playerdata 保证日志不丢失。
  _mergePlayerEvents(savedEvents, memEvents) {
    const seen = new Set();
    const merged = [];
    for (const e of [...savedEvents, ...memEvents]) {
      const key = `${e.type}|${e.message}|${e.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(e);
      }
    }
    merged.sort((a, b) => b.timestamp - a.timestamp);
    return merged;
  }

  /// 从 MC 官方统计文件读取玩家真实统计（MC 26.1+ 位于 world/players/stats/<uuid>.json）。
  /// 返回 { deaths, sleepInBed, playTime(tick), leaveGame }，文件缺失/解析失败时返回 null。
  _loadPlayerRealStats(playerName) {
    try {
      const uuid = this._getPlayerUuid(playerName);
      // level-name 服务层兜底校验：非法/越界回退 'world'
      const levelName = this._getSafeLevelName();
      // 两种 UUID（usercache 的 / 离线派生的）乘两条目录版式：
      // 26.1+ 在 <level>/players/stats，1.20.5–1.21.10 在 <level>/stats。
      // 此处曾把两条 UUID 分支各写一遍候选，而离线分支漏了 `stats/` 版式——
      // 旧版本的离线玩家因此读不到统计。改成两层循环，版式只有一处定义。
      const uuids = [uuid];
      const offlineUuid = computeOfflineUuid(playerName);
      // 无 usercache 记录（Carpet 假人 / usercache 被剪枝）时用离线派生 UUID 兜底
      if (offlineUuid && offlineUuid !== uuid) uuids.push(offlineUuid);
      const candidates = [];
      for (const id of uuids) {
        for (const dirName of [levelName, 'world']) {
          candidates.push(path.join(this.serverPath, dirName, 'players', 'stats', `${id}.json`));
          candidates.push(path.join(this.serverPath, dirName, 'stats', `${id}.json`));
        }
      }
      for (const statsPath of candidates) {
        // 兜底防御：候选路径 resolve 后必须位于 serverPath 内，越界丢弃
        if (!isPathContained(this.serverPath, statsPath)) continue;
        if (!fs.existsSync(statsPath)) continue;
        const raw = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
        const custom = raw?.stats?.['minecraft:custom'] || raw?.['minecraft:custom'] || {};
        return {
          deaths: custom['minecraft:deaths'] ?? null,
          sleepInBed: custom['minecraft:sleep_in_bed'] ?? null,
          playTime: custom['minecraft:play_time'] ?? null,
          leaveGame: custom['minecraft:leave_game'] ?? null,
        };
      }
    } catch {}
    return null;
  }

  /// 计算玩家日志统计（供日志 Tab 底部统计卡片）。
  /// [sessions] 会话历史；[events] 合并后的事件；[player] 在线玩家对象（离线为 null）；
  /// [playerName] 玩家名（用于读取 MC 官方真实统计，为空时回退自建近似）。
  /// 返回 totalOnline（总在线秒）/ loginCount（登录次数）/ offlineSince（已离线秒）/
  /// deathCount / achievementCount / sleepCount。
  _computePlayerStats(sessions, events, player, playerName) {
    const now = Date.now();

    // MC 官方真实统计优先：从 world/players/stats/<uuid>.json 读取
    // deaths / sleep_in_bed / play_time / leave_game；文件缺失时回退自建近似。
    // 成就计数用日志解析事件（MC advancements 文件是进度树结构，解析成本高于收益）。
    if (playerName) {
      const real = this._loadPlayerRealStats(playerName);
      if (
        real &&
        (real.deaths != null ||
          real.playTime != null ||
          real.sleepInBed != null ||
          real.leaveGame != null)
      ) {
        let lastClosedEnd = null;
        for (const s of sessions) {
          if (s.end != null) lastClosedEnd = s.end;
        }
        const offlineSince = player
          ? 0
          : lastClosedEnd
            ? Math.max(0, Math.floor((now - lastClosedEnd) / 1000))
            : 0;
        let achievementCount = 0;
        for (const e of events) {
          if (e.type === 'achievement') achievementCount++;
        }
        return {
          // play_time 单位为 tick，换算为秒（与 getTotalPlayTime 一致）
          totalOnline: real.playTime != null ? Math.floor(real.playTime / 20) : 0,
          loginCount: real.leaveGame ?? sessions.length,
          offlineSince,
          deathCount: real.deaths ?? 0,
          achievementCount,
          sleepCount: real.sleepInBed ?? 0,
        };
      }
    }

    // 自建近似统计（fallback：stats 文件缺失或未传 playerName）
    let totalOnline = 0;
    let lastClosedEnd = null;
    for (const s of sessions) {
      // 进行中的会话（end 为 null）：在线玩家按当前时刻计算时长，离线玩家按开始时刻（0 时长）
      const end = s.end != null ? s.end : player ? now : s.start;
      totalOnline += Math.max(0, Math.floor((end - s.start) / 1000));
      if (s.end != null) lastClosedEnd = s.end;
    }
    const loginCount = sessions.length;
    // 已离线：最后一个结束会话的结束时刻至今（在线玩家为 0）
    const offlineSince = player
      ? 0
      : lastClosedEnd
        ? Math.max(0, Math.floor((now - lastClosedEnd) / 1000))
        : 0;

    let deathCount = 0;
    let achievementCount = 0;
    let sleepCount = 0;
    for (const e of events) {
      if (e.type === 'death') deathCount++;
      else if (e.type === 'achievement') achievementCount++;
      else if (e.type === 'sleep') sleepCount++;
    }

    return { totalOnline, loginCount, offlineSince, deathCount, achievementCount, sleepCount };
  }
}

// 世界存档数据读取域挂载：level-dat 模块经原型注入复用，
// 模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例）。

// 实例启动生命周期域挂载：start-lifecycle 模块经原型注入复用，
// 模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例），
// start() 主体只做子阶段编排。
Object.assign(MCServerInstance.prototype, startLifecycle);
Object.assign(MCServerInstance.prototype, levelDat);

// 进程输出解析域挂载：output-parser 模块经原型注入复用，
// 模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例）。
Object.assign(MCServerInstance.prototype, outputParser);

// 实例统计采集域挂载：stats-collector 模块经原型注入复用，
// 模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例）。
Object.assign(MCServerInstance.prototype, statsCollector);

// 接管实例日志续读域挂载（后续）：log-tail 模块经原型注入复用，
// 接管实例改读 latest.log 尾部以恢复日志与事件解析（详见模块头注释）。
Object.assign(MCServerInstance.prototype, logTail);

// 孤儿进程接管域挂载（根修）：pid 文件与面板重启后接管，机制见 adopt.js 头注释。
Object.assign(MCServerInstance.prototype, adopt);

// 崩溃诊断产物域挂载：读取并解析 crash-reports/crash-*.txt 与 hs_err_pid*.log，
// 只读呈现（格式依据与实测样本见模块头注释）。
Object.assign(MCServerInstance.prototype, crashArtifacts);

// 实例版本读取域挂载：从服务端 JAR 内 version.json 取权威 mcVersion/javaVersion，
// 供 _getMcVersion 与 _getRequiredJavaVersion 使用（机制见 jar-version.js 头注释）。
Object.assign(MCServerInstance.prototype, jarVersion);

// 在线名单对账域挂载：RCON `list` 作为在线名单权威来源，接管时补齐缺席期间的
// 在线玩家、运行期周期性纠偏（机制见 roster-sync.js 头注释）。
Object.assign(MCServerInstance.prototype, rosterSync);

// MSMP 查询域挂载：结构化查询面（1.21.9+ 且用户开启时可用）。命令面进不来——
// MSMP 没有执行控制台命令的方法，故命令通道仍是 RCON/stdin（见 msmp-client.js 头注释）。
Object.assign(MCServerInstance.prototype, msmpClient);

// MSMP 通知面（一期）域挂载：常驻连接接收服务端推送的 world/upgrade_* 与
// server/started|stopping|saving|saved（与 stdout 解析零冲突的两族，见模块头注释）。
Object.assign(MCServerInstance.prototype, msmpNotifications);

// 结构化日志域挂载：为实例写一份 log4j2 覆盖配置（纯文本通道不变 + 多一份 JSONL），
// 启动时经 -D 注入（版本门槛与选型依据见模块头注释）。
Object.assign(MCServerInstance.prototype, structuredLogConfig);

// 方法面域挂载：白名单/OP/踢人/封禁走结构化方法、拿不到再退回等价命令
// （判据与两条通道的差异见模块头注释）。依赖 msmp-client 的 _msmpRequest。
Object.assign(MCServerInstance.prototype, msmpMethods);

// 游戏规则读值域挂载：名单由服务器自述（MSMP 结构化 / help gamerule），读值走
// sendCommandWithResponse 以免写命令史（机制与逐版本回包文案见模块头注释）。
Object.assign(MCServerInstance.prototype, gameruleReader);
