import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import { Rcon } from 'rcon-client';
import { parseUncompressed as parseNbtSync } from 'prismarine-nbt';
import config from '../config.js';
import { InstanceModel, CommandHistoryModel } from '../db/index.js';
import { atomicWriteFile, ensureDir } from '../utils/fs-utils.js';
import { killProcessTree } from '../utils/process-tree.js';
import { maskSensitiveCommand } from '../utils/command-mask.js';
import { localDateKey } from '../utils/local-date.js';
// offline uuid / stats 时长读取全仓公共实现（与 routes/players.js 共用 player-utils.js）
import {
  offlineUuid as computeOfflineUuid,
  getTotalPlayTime,
  readUuidFromUsercache,
  shadowProfilePath,
} from '../utils/player-utils.js';
import { isPathContained } from '../utils/fs-utils.js';
// addressReachability / isPrivateIp 复用 url-guard 的私有网段判定（SSRF 防护用的同一把尺子）：
// 地址「能不能发给玩家」与「能不能作为出站目标」用的是同一套可达性语义，
// 各写一份正则会漂移（如漏掉 100.64.0.0/10 这类 CGNAT 段）
import { addressReachability } from '../utils/url-guard.js';
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
    this.loadInstances();
  }

  loadInstances() {
    ensureDir(config.serversDir);

    // 1. 从 SQLite 加载实例
    let dbInstances = [];
    try {
      dbInstances = InstanceModel.getAll();
      logger.info(`Loading ${dbInstances.length} instances from DB`);
    } catch (e) {
      logger.warn('Failed to load instances from DB, will try file system:', e.message);
    }

    // 2. 从 DB 加载到内存
    for (const inst of dbInstances) {
      try {
        this.createInstance({
          id: inst.id,
          name: inst.name,
          javaPath: inst.javaPath || 'java',
          jarFile: inst.jarFile,
          maxMemory: inst.maxMemory || '2G',
          minMemory: inst.minMemory || '1G',
          serverPath: inst.serverPath || path.join(config.serversDir, inst.id),
          startCommand: inst.startCommand,
          jvmArgs: inst.jvmArgs,
          autoRestart: inst.autoRestart,
          autoStart: inst.autoStart,
          mcVersion: inst.mcVersion,
        });
        logger.info(`Loaded instance from DB: ${inst.id}`);
      } catch (e) {
        logger.error(`Failed to load DB instance ${inst.id}:`, e);
      }
    }

    // 3. 迁移文件系统中的旧实例（instance.json 存在但 DB 无记录）
    // readdirSync 即判定：serversDir 已在方法起手 ensureDir 建好，故不做 existsSync
    // 预检（预检也护不住紧随其后的 readdir——它不在预检的保护范围内）；极端并发
    // 删除下 readdir 抛 ENOENT，语义等价于「没有旧实例可迁移」
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

        // 已迁移标记，跳过
        if (instanceConfig.migrated === true) {
          // 如果 DB 中没有但已标记迁移，说明 DB 记录被删除了，重新迁移
          const dbRecord = InstanceModel.getById(instanceConfig.id);
          if (dbRecord) {
            // 已在 DB 中，确保内存中也加载
            if (!this.instances.has(instanceConfig.id)) {
              this.createInstance({
                ...instanceConfig,
                serverPath: path.join(config.serversDir, dir.name),
              });
              logger.info(`Loaded migrated instance: ${instanceConfig.id}`);
            }
            continue;
          }
          // DB 无记录但已标记迁移，移除标记重新迁移
          delete instanceConfig.migrated;
        }

        // 检查 DB 是否已有此实例
        const existing = InstanceModel.getById(instanceConfig.id);
        if (existing) {
          // DB 已有记录，确保内存加载（避免重复）
          if (!this.instances.has(instanceConfig.id)) {
            this.createInstance({
              ...instanceConfig,
              serverPath: path.join(config.serversDir, dir.name),
            });
          }
          // 标记为已迁移
          instanceConfig.migrated = true;
          atomicWriteFile(configPath, JSON.stringify(instanceConfig, null, 2));
          continue;
        }

        // DB 无记录，执行迁移
        logger.info(`Migrating instance ${instanceConfig.id} from JSON to DB...`);
        const serverPath = path.join(config.serversDir, dir.name);
        const migrated = InstanceModel.migrateFromJson(instanceConfig, serverPath);
        if (migrated) {
          // 确保内存加载
          if (!this.instances.has(instanceConfig.id)) {
            this.createInstance({
              ...instanceConfig,
              serverPath,
            });
          }
          // 标记为已迁移
          instanceConfig.migrated = true;
          atomicWriteFile(configPath, JSON.stringify(instanceConfig, null, 2));
          logger.info(`Migrated instance ${instanceConfig.id} to DB`);
        }
      } catch (e) {
        logger.error(`Failed to load/migrate instance ${dir.name}:`, e);
      }
    }
  }

  createInstance({
    id,
    name,
    javaPath = 'java',
    jarFile,
    maxMemory = '2G',
    minMemory = '1G',
    serverPath,
    ...rest
  }) {
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
      ...rest,
    });

    this.instances.set(id, instance);

    instance.on('log', (data) => this.emit('instance:log', { instanceId: id, ...data }));
    instance.on('status', (data) => this.emit('instance:status', { instanceId: id, ...data }));
    instance.on('playerJoin', (data) =>
      this.emit('instance:playerJoin', { instanceId: id, ...data }),
    );
    instance.on('playerLeave', (data) =>
      this.emit('instance:playerLeave', { instanceId: id, ...data }),
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

  // 显式停止全部运行中实例：等待 stop 命令送达 + MC 正常退出，超时兜底强杀，
  // 避免残留孤儿进程、在线玩家数据（离开事件/60s 保存）丢失。
  // 注意：面板停机（SIGTERM/SIGINT/崩溃）已不调用本方法——停机不停实例，
  // 由下次启动的 adoptOrphanInstances 接管（owner 2026-09-09 拍板）。
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
    javaPath,
    jarFile,
    maxMemory,
    minMemory,
    serverPath,
    startCommand,
    jvmArgs,
    autoRestart,
    autoStart,
    mcVersion,
  }) {
    super();
    this.id = id;
    this.name = name;
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
    // 是否主动停止（stop/kill 设置），用于区分「意外停止/崩溃」与「用户主动停止」
    this._manualStop = false;
    this.process = null;
    this.isRunning = false;
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
    this.tps = 20;
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
    // 结构化日志覆盖配置的绝对路径：启动前置阶段解析（版本不达门槛时为 null＝不启用）
    this._structuredLogConfigPath = null;
    // 死亡事件聚合窗口：团灭等批量场景 5s 内合并为单条事件（防通知风暴）
    this._deathAggBuffer = [];
    this._deathAggTimer = null;
    this._restartTimer = null; // 重启延迟启动定时器（stop/kill 时取消）
    // 崩溃循环熔断（运维韧性）
    this._consecutiveCrashes = 0;
    this._crashWindowStart = null;
    this._circuitBreakerTripped = false;
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
        if (!trimmed || trimmed.startsWith('#')) continue;
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

  _saveProperties(props) {
    const propsPath = path.join(this.serverPath, 'server.properties');
    const lines = Object.entries(props).map(
      ([key, value]) => `${key}=${this._escapePropertyValue(value)}`,
    );
    atomicWriteFile(propsPath, lines.join('\n') + '\n');
    this.properties = props;
  }

  /// 公开方法：保存 server.properties（供 routes 调用）
  /// 保留原注释行（以 # 开头），仅更新键值对；未在 props 中出现的键保留原值。
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
      comments = content.split('\n').filter((l) => l.trim().startsWith('#'));
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
  ///    曾经 PUBLIC_IP 分支硬编码 public、网卡分支硬编码 private，于是
  ///    「PUBLIC_IP=100.64.0.1」标 public 而「server-ip=100.64.0.1」标 private（同值两判），
  ///    且网卡上挂着真实公网 IP 的机器（探测失败时）会被误标成内网。
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

  start(startCommand) {
    if (this.isRunning) {
      throw new Error('Server is already running');
    }

    // 启动视为非主动停止（自动重启/崩溃恢复均会走这里）
    this._manualStop = false;
    // 新 spawn 覆盖一切接管残留态（接管实例 restart 必经看门狗确认退出后才到这）
    this.adopted = false;
    this.adoptedPid = null;

    // 子阶段编排（各阶段实现见 start-lifecycle.js，经原型注入 this 绑定实例）：
    // EULA 检查 → tempban 对账 → world 锁清理 → 结构化日志配置（写覆盖配置，供下一步注入 -D）
    // → 启动命令/参数构建（四种来源优先级）
    // → spawn 与进程/stdin/输出/exit 监听器挂载 → 运行时状态初始化 → 收尾
    // （熔断重置 → started 事件 → 定时存档）。按原始执行顺序依次调用，行为零变化。
    this._ensureEulaAccepted();
    this._reconcileTempBansSafe();
    this._cleanWorldLock();
    this._ensureStructuredLogConfig();

    const { command, args } = this._resolveStartCommand(startCommand);
    this._spawnServerProcess(command, args);
    // pid 文件是面板重启后接管孤儿进程的唯一线索，spawn 成功即落盘
    this._writePidFile();
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

    this._rconConnecting = (async () => {
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

    try {
      await this._rconConnecting;
    } finally {
      this._rconConnecting = null;
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

  async _rconSend(command) {
    try {
      await this._rconEnsureConnected();
    } catch (err) {
      // 连接建立失败：命令尚未进入 RCON 队列、未写入 socket → 确认未送达，
      // 标记供 sendCommand 判断可安全回退 stdin（此时不回退才会丢命令）
      if (err && typeof err === 'object') err.rconConfirmedNotSent = true;
      throw err;
    }
    // rcon-client 内置 packet queue，send 返回响应字符串
    // timeout 在 Rcon.connect 时全局配置
    return this._rconClient.send(command);
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
    if (!this.isRunning || (!this.process && !this.adopted)) {
      throw new Error('Server is not running');
    }
    // 用户主动停止：标记为手动，避免被误判为意外停止而触发自动重启，
    // 并取消重启的延迟启动（用户明确停止后不得 3 秒后被自动拉起）
    this._manualStop = true;
    this.cancelRestart();
    // 接管实例无控制台管道：统一走优雅停流程（RCON stop / 失败则按平台
    // 信号或 taskkill 兜底），fire-and-forget 语义与常规 stop 一致
    if (this.adopted) {
      this.stopGracefully().catch(() => {});
      return;
    }
    this.stopServer().catch(() => {});
  }

  // 优雅停止：await 发送 stop 命令并等待 MC 正常退出（exit 事件），
  // 超时后强杀兜底。供服务端停机流程（stopAll）使用——原 stop() 为
  // fire-and-forget，停机时 MC 可能收不到命令就随父进程退出成为孤儿，
  // 在线玩家数据（离开事件/60s 保存）随之丢失。
  async stopGracefully({ timeout = 8000 } = {}) {
    if (!this.isRunning || (!this.process && !this.adopted)) return;
    this._manualStop = true;
    this.cancelRestart();
    try {
      await this.stopServer();
    } catch {
      // 发送失败（RCON 断开等）：直接进入等待/强杀流程
    }
    if (!this.isRunning) return; // 发送阶段就已退出
    if (this.adopted) {
      // 接管实例无 exit 事件：轮询 pid 验活等待，语义与下方 exit 等待一致
      await this._waitForAdoptedExit(timeout);
    } else {
      if (!this.process) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.process?.removeListener('exit', onExit);
          resolve();
        }, timeout);
        const onExit = () => {
          clearTimeout(timer);
          resolve();
        };
        this.process.once('exit', onExit);
      });
    }
    // 超时仍未退出 → 强杀，不留孤儿进程
    if (this.isRunning) {
      try {
        this.kill();
      } catch {}
    }
  }

  restart() {
    if (this.isRunning) {
      // 主动重启：标记为手动停止，避免 stop 阶段触发自动重启
      this._manualStop = true;
      this.stopServer().catch(() => {});
    }
    this._scheduleRestartStart();
  }

  // 调度延迟启动（restart 与 status.js restart 端点共用，
  // 替代原裸 setTimeout——无法取消、重复重启叠加）
  _scheduleRestartStart() {
    // 先前待执行的延迟启动作废（重复重启/重启后立即再重启）
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      // 接管实例：stop 到进程退出经看门狗轮询感知（最长 ADOPT_WATCHDOG_INTERVAL_MS），
      // 固定 3s 窗口可能早于死亡——轮询等待退出（上限 10s）后再启动。
      // 轮询句柄复用 _restartTimer：stop/kill 的 cancelRestart() 可中断等待
      if (this.adopted && this.isRunning) {
        const begin = Date.now();
        const waitAdoptedExit = () => {
          if (!this.isRunning) {
            this._restartTimer = null;
            return this._startAfterRestartWindow();
          }
          if (Date.now() - begin >= 10000) {
            this._restartTimer = null;
            logger.warn(`[${this.id}] Restart cancelled: adopted process did not exit in time`);
            return;
          }
          this._restartTimer = setTimeout(waitAdoptedExit, 250);
        };
        return waitAdoptedExit();
      }
      this._startAfterRestartWindow();
    }, 3000);
  }

  // 延迟窗口届满后的实际启动（窗口内已退出/已取消的守卫在此收敛）
  _startAfterRestartWindow() {
    // 延迟窗口内服务器已被其他路径启动 → 放弃
    if (this.isRunning) return;
    // 实例目录已被删除（用户卸载）→ 放弃延迟启动
    if (!fs.existsSync(path.join(this.serverPath, this.jarFile))) {
      logger.info(`[${this.id}] Restart cancelled: server jar no longer exists`);
      return;
    }
    try {
      this.start();
    } catch (e) {
      logger.error('Restart failed:', e);
    }
  }

  // 取消待执行的延迟启动（用户 stop/kill 实例时调用）
  cancelRestart() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  kill() {
    // 主动强杀：标记为手动，避免被误判为崩溃触发自动重启，
    // 并取消重启的延迟启动
    this._manualStop = true;
    this.cancelRestart();
    // pid 来源：常规实例取子进程句柄；接管实例（管道不可恢复）取 pid 文件记录。
    // 接管实例杀后的运行态收尾由看门狗轮询完成（检测死亡 → stopped 事件 →
    // 清 pid 文件），此处不重复清理。
    const pid = this.process?.pid ?? (this.adopted ? this.adoptedPid : null);
    if (pid) {
      // 终止整棵进程树（Bundler 结构的 server.jar 会派生真正运行的 JVM），
      // 平台策略见 utils/process-tree.js；start() 在非 win32 上以 detached 启动，
      // 故按进程组终止有效
      killProcessTree(this.process, { pid, detached: true });
    }
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

  /**
   * 执行一条命令并落命令史。
   * @param {string} command
   * @param {{ source?: string }} [options] 命令史来源标记（默认 `api`）。
   *   仅供调用方区分「同一端点的不同语义」——目前是审计页的行内重发（`replay`），
   *   使重发在命令史里可辨认，而不是与一次普通下发混同。
   */
  async sendCommand(command, { source = 'api' } = {}) {
    if (!this.isRunning || (!this.process && !this.adopted)) {
      throw new Error('Server is not running');
    }
    // 兜底：剥离前导 `/` —— MC 服务器控制台/RCON 不接受 `/` 前缀
    // （仅玩家聊天框需要 `/`，客户端某些入口可能误带）
    if (typeof command === 'string' && command.startsWith('/')) {
      command = command.replace(/^\/+/, '');
    }
    // 防御：非 tellraw 命令中的真实换行符会被 stdin 当作命令分隔符，
    // 导致多行内容被截断。tellraw 使用 JSON 转义 \n（两字符），不受影响。
    if (typeof command === 'string' && command.includes('\n') && !command.startsWith('tellraw')) {
      command = command.replace(/\n/g, ' ');
    }
    // 拦截 weather 命令，同步更新天气缓存
    const weatherMatch = command.match(/^weather\s+(clear|rain|thunder)/i);
    if (weatherMatch) {
      this._weather = weatherMatch[1].toLowerCase();
      this.emit('weatherUpdate', { weather: this._weather });
    }
    // 拦截 time 命令，同步更新时间缓存并立即推送
    const timePresetMatch = command.match(/^time\s+set\s+(day|night|noon|midnight)/i);
    if (timePresetMatch) {
      const presetMap = { day: 1000, night: 13000, noon: 6000, midnight: 18000 };
      const tick = presetMap[timePresetMatch[1].toLowerCase()];
      if (tick != null) {
        this._worldTime = tick;
        this._emitPerformance();
      }
    }
    const timeSetMatch = command.match(/^time\s+set\s+(\d+)/i);
    if (timeSetMatch) {
      this._worldTime = parseInt(timeSetMatch[1], 10) % 24000;
      this._emitPerformance();
    }
    const timeAddMatch = command.match(/^time\s+add\s+(\d+)/i);
    if (timeAddMatch) {
      this._worldTime = (this._worldTime + parseInt(timeAddMatch[1], 10)) % 24000;
      this._emitPerformance();
    }
    // 记录用户发送的命令到日志流（终端显示 "> 命令"，供操作反馈上下文）
    this.emit('log', { text: `> ${command}`, type: 'command' });
    // : 命令历史落库（chokepoint finally）
    const cmdStart = Date.now();
    let cmdSuccess = true;
    try {
      // 优先使用 RCON：stdin 管道对含特殊字符（" [ ] { }）的命令处理不可靠，
      // 特别是 MC 1.20.5+ Data Components 格式（如 give ... [enchantments={...}]）
      // 中的引号会被 stdin 错误解析，导致附魔装备给予失败。
      // RCON 协议以二进制包传输，不存在字符转义问题。
      if (this.isRconConnected) {
        try {
          // await 确保命令真正送达并收到响应后才返回，
          // 让前端顺序 await 时多条命令串行化，避免并发投递导致丢失
          const response = await this._rconSend(command);
          // MC 命令执行失败（离线玩家/未知物品/语法错误）不会抛异常，只返回错误文本；
          // 解析响应检测失败短语并抛错，避免前端误判为成功
          if (typeof response === 'string') {
            const failure = matchCommandFailure(response);
            if (failure) {
              const err = new Error(`命令执行失败: ${failure}`);
              err.isCommandExecutionError = true;
              throw err;
            }
          }
          return response;
        } catch (err) {
          // 命令执行失败（已解析出失败响应）→ 直接抛错，不回退 stdin（避免重复执行）
          if (err && err.isCommandExecutionError) throw err;
          // 仅当确认命令未送达（连接建立失败 / 队列滞留项：命令从未写入 RCON
          // socket）才回退 stdin 兜底。其余错误（"Timeout for packet id N"、
          // 在途断连 "Connection closed"）都发生在发包之后——超时仅代表响应未在
          // 5s 内返回、命令很可能已执行（RCON 协议"响应超时≠命令未执行"），
          // 回退 stdin 重发会让 give/kick/tp/ban 等非幂等命令重复生效
          // → 直接向调用方抛错，保持 RCON 队列语义
          if (!(err && err.rconConfirmedNotSent)) throw err;
          logger.warn(`[Instance ${this.id}] RCON send failed, fallback to stdin:`, err.message);
          this._writeToStdin(command + '\n');
          return null;
        }
      }
      // 接管实例无 stdin 管道（面板重启后接管，stdout/stdin 随旧面板进程消失）：
      // RCON 不可达时命令没有任何投递通道，如实报错而非静默丢弃
      if (!this.process && this.adopted) {
        throw new Error('接管实例无控制台管道且 RCON 未连接，命令未送达——请在实例设置中启用 RCON');
      }
      this._writeToStdin(command + '\n');
      return null;
    } catch (err) {
      cmdSuccess = false;
      throw err;
    } finally {
      try {
        CommandHistoryModel.create({
          instanceId: this.id,
          // 落库前遮蔽敏感值（用户自由输入的命令可能含密钥；见 utils/command-mask.js）
          command: maskSensitiveCommand(command),
          source,
          success: cmdSuccess ? 1 : 0,
          durationMs: Date.now() - cmdStart,
        });
      } catch {
        /* audit write failure never blocks command flow */
      }
    }
  }

  sendCommandWithResponse(command, { timeout = 5000 } = {}) {
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
        const timeoutTimer = setTimeout(() => {
          reject(new Error('Command timeout'));
        }, timeout);
        this._rconSend(command).then(
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
      // 此前这里退回一条自造的 `mcsmp_<id>` stdin 行协议，但那个协议需要配套 Mod，
      // 而该 Mod 在全仓与 git 历史中都不存在 ⇒ 正常部署下这条路径无人应答，用户只能
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
      // 可用通道分开报：「能不能执行命令」与「能不能读到结构化事实」是两件事。
      // rcon 判据是配置齐全且在运行（RCON 无握手概念，配置即判据，每次实时读）；
      // msmp 判据是**最近一次查询实测成功**（端口可随机、可被反代，配置推不出可用性）。
      // 实例已停时 msmp 一律报 false：那是上一次运行的残留实测值，不是当前状态。
      capabilities: {
        rcon: this.isRconConnected,
        msmp: this.isRunning && this._msmpAvailable,
      },
      // 意外停止自动重启开关（供前端设置页读写）
      autoRestart: this.autoRestart,
      uptime: Math.floor(uptimeMs / 1000),
      address,
      addressType,
      players: Array.from(this.players.values()),
      playerCount: this.players.size,
      maxPlayers: parseInt(props['max-players'] || '20'),
      mcVersion: this._getMcVersion(),
      modLoader: this._getModLoader(),
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
      circuitBreakerTripped: this._circuitBreakerTripped,
      consecutiveCrashes: this._consecutiveCrashes,
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
              // 的缓存过期时刻，与最后在线无关。此前拿它当 lastSeen，界面会显示一个
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

  _getModLoader() {
    const fabricPath = path.join(this.serverPath, 'fabric-server-launch.jar');
    if (fs.existsSync(fabricPath)) return 'Fabric';

    try {
      const files = fs.readdirSync(this.serverPath);
      for (const file of files) {
        if (/^forge-.*-universal\.jar$/.test(file)) return 'Forge';
      }
    } catch {}
    return 'Vanilla';
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
    const dir = path.join(this.serverPath, 'playerdata');
    const filePath = shadowProfilePath({ serverPath: this.serverPath, playerName, uuid });
    if (!isPathContained(dir, filePath)) {
      logger.error(`[${this.id}] 拒绝越界影子档案路径: ${JSON.stringify(filePath)}`);
      return null;
    }
    return filePath;
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
    try {
      const filePath = this._shadowProfilePath(playerName);
      if (!filePath) return null;
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
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
        details.maxHealth = maxHealthVal != null ? maxHealthVal : 20;

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
    // 成就计数仍用日志解析事件（MC advancements 文件为进度树结构，解析复杂暂不接入）。
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

// 世界存档数据读取域挂载（issue 490 治理线·服务端第一阶段）：level-dat 模块经原型注入复用，
// 模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例），
// 全部调用点零改动，对外接口零变化。

// 实例启动生命周期域挂载（issue 513 治理线·服务端第四阶段）：start-lifecycle 模块经原型
// 注入复用，模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例），
// start() 主体降为子阶段编排，全部调用点零改动，对外接口零变化。
Object.assign(MCServerInstance.prototype, startLifecycle);
Object.assign(MCServerInstance.prototype, levelDat);

// 进程输出解析域挂载（issue 494 治理线·服务端第二阶段）：output-parser 模块经原型注入复用，
// 模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例），
// 全部调用点零改动，对外接口零变化。
Object.assign(MCServerInstance.prototype, outputParser);

// 实例统计采集域挂载（issue 502 治理线·服务端第三阶段）：stats-collector 模块经原型注入复用，
// 模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例），
// 全部调用点零改动，对外接口零变化。
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
