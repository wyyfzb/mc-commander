import { spawn, spawnSync, exec } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import { Rcon } from 'rcon-client';
import { parseUncompressed as parseNbtSync } from 'prismarine-nbt';
import config from '../config.js';
import { InstanceModel, CommandHistoryModel } from '../db/index.js';
import { atomicWriteFile } from '../utils/fs-utils.js';
import { reconcileTempBans } from '../utils/ban-reconcile.js';
// offline uuid / stats 时长读取全仓公共实现（与 routes/players.js 共用 player-utils.js）
import { offlineUuid as computeOfflineUuid, getTotalPlayTime } from '../utils/player-utils.js';
import * as levelDat from './mc-server/level-dat.js';
import * as outputParser from './mc-server/output-parser.js';
import { logger } from '../utils/logger.js';

// 原子写统一走 utils/fs-utils.js 公共实现（写唯一 .tmp 再 rename，失败清残留）。
// 保留 re-export：routes/status.js（_syncInstanceJson 同步 instance.json）与
// routes/server-jar.js（创建实例首次写入 instance.json）仍从本文件导入，
// 避免这两个调用点各自定义本地副本。

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

// 日志单行最大长度：超长行截断并加标记，防超长输出（崩溃堆栈/异常打印）撑爆
// logBuffer 与 WebSocket 广播（find-023-server 单行截断）。
const LOG_LINE_MAX_LENGTH = 4096;

/// 路径包含校验（服务层统一兜底，find-006/007/004/extra-1/find-008-read 共用模式）：
/// ①path.resolve 归一化；②严格前缀校验（相等排除 + base + path.sep 边界）。
/// targetPath 为相对路径时以 basePath 为基准解析（与 spawn cwd=serverPath 的
/// 相对路径解析语义一致）。返回是否位于 base 内。
function isPathContained(basePath, targetPath) {
  const base = path.resolve(basePath);
  const target = path.resolve(base, targetPath);
  return target === base || target.startsWith(base + path.sep);
}

/// 单行日志截断：按行截断超过 LOG_LINE_MAX_LENGTH 的行，超长部分加 "…[truncated]" 标记。
function truncateLogText(text) {
  return String(text).split('\n').map((line) => {
    if (line.length <= LOG_LINE_MAX_LENGTH) return line;
    return line.substring(0, LOG_LINE_MAX_LENGTH) + '…[truncated]';
  }).join('\n');
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
    this.loadInstances();
  }

  loadInstances() {
    if (!fs.existsSync(config.serversDir)) {
      fs.mkdirSync(config.serversDir, { recursive: true });
    }

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
    if (fs.existsSync(config.serversDir)) {
      const dirs = fs.readdirSync(config.serversDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

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
                  serverPath: path.join(config.serversDir, dir.name)
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
                serverPath: path.join(config.serversDir, dir.name)
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
                serverPath
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
  }

  createInstance({ id, name, javaPath = 'java', jarFile, maxMemory = '2G', minMemory = '1G', serverPath, ...rest }) {
    const instancePath = serverPath || path.join(config.serversDir, id);
    if (!fs.existsSync(instancePath)) {
      fs.mkdirSync(instancePath, { recursive: true });
    }

    const instance = new MCServerInstance({
      id, name, javaPath, jarFile, maxMemory, minMemory, serverPath: instancePath, ...rest
    });

    this.instances.set(id, instance);

    instance.on('log', (data) => this.emit('instance:log', { instanceId: id, ...data }));
    instance.on('status', (data) => this.emit('instance:status', { instanceId: id, ...data }));
    instance.on('playerJoin', (data) => this.emit('instance:playerJoin', { instanceId: id, ...data }));
    instance.on('playerLeave', (data) => this.emit('instance:playerLeave', { instanceId: id, ...data }));
    instance.on('playerDeath', (data) => this.emit('instance:playerDeath', { instanceId: id, ...data }));
    instance.on('playerRespawn', (data) => this.emit('instance:playerRespawn', { instanceId: id, ...data }));
    instance.on('achievement', (data) => this.emit('instance:achievement', { instanceId: id, ...data }));
    instance.on('tpsUpdate', (data) => this.emit('instance:tpsUpdate', { instanceId: id, ...data }));
    instance.on('performanceUpdate', (data) => this.emit('instance:performanceUpdate', { instanceId: id, ...data }));
    instance.on('weatherUpdate', (data) => this.emit('instance:weatherUpdate', { instanceId: id, ...data }));
    instance.on('playerStatsUpdate', (data) => this.emit('instance:playerStatsUpdate', { instanceId: id, ...data }));
    instance.on('playerSleep', (data) => this.emit('instance:playerSleep', { instanceId: id, ...data }));

    return instance;
  }

  getInstance(id) {
    return this.instances.get(id);
  }

  getAllInstances() {
    return Array.from(this.instances.values()).map(i => i.toStatus());
  }

  // 优雅停止全部运行中实例：等待 stop 命令送达 + MC 正常退出，
  // 超时兜底强杀，避免停机（systemctl stop / Ctrl+C）时 MC 子进程
  // 残留为孤儿、在线玩家数据（离开事件/60s 保存）丢失。
  async stopAll({ timeout = 8000 } = {}) {
    await Promise.all(
      Array.from(this.instances.values())
        .filter((i) => i.isRunning)
        .map((instance) => instance.stopGracefully({ timeout }))
    );
  }
}

export class MCServerInstance extends EventEmitter {
  constructor({ id, name, javaPath, jarFile, maxMemory, minMemory, serverPath, startCommand, jvmArgs, autoRestart, autoStart, mcVersion }) {
    super();
    this.id = id;
    this.name = name;
    this.javaPath = javaPath;
    this.jarFile = jarFile;
    this.maxMemory = maxMemory;
    this.minMemory = minMemory;
    this.serverPath = serverPath;
    this.startCommand = startCommand || null;
    // 结构化 JVM 参数（find-002 闭环：实例级持久化，start() 无传参时使用）
    this.jvmArgs = Array.isArray(jvmArgs) ? jvmArgs : null;
    // 意外停止自动重启开关（DB 持久化，默认开）
    this.autoRestart = autoRestart !== undefined ? Boolean(autoRestart) : true;
    // DB 持久化的 MC 版本号（部署/升级时写入），运行时以此为准
    this.mcVersion = mcVersion || null;
    // 是否主动停止（stop/kill 设置），用于区分「意外停止/崩溃」与「用户主动停止」
    this._manualStop = false;
    this.process = null;
    this.isRunning = false;
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
    this._commandResponsePromises = new Map();
    this._commandIdCounter = 0;
    // RCON 客户端（rcon-client 库管理连接/认证/分包）
    this._rconClient = null;
    this._rconConnecting = null;
    this._lastCpuTime = undefined;
    this._saveTimer = null;
    this._playerStatsTimer = null;  // 玩家血量/坐标/入睡状态采集定时器
    this._playerStatsEpoch = 0;     // 采集代际：stop 时自增，作废在途回调的续链
    this._msptTimer = null;         // MSPT 采集定时器
    this._msptEpoch = 0;            // MSPT 采集代际：stop 时自增，作废在途回调的续链
    this._worldStateTimer = null;   // 世界状态（时间/天气）采集定时器
    this._worldStateEpoch = 0;      // 世界状态采集代际：stop 时自增，作废在途回调的续链
    // 死亡事件聚合窗口：团灭等批量场景 5s 内合并为单条事件（防通知风暴）
    this._deathAggBuffer = [];
    this._deathAggTimer = null;
    this._restartTimer = null;      // 重启延迟启动定时器（stop/kill 时取消）
    // 崩溃循环熔断（feat-5 运维韧性）
    this._consecutiveCrashes = 0;
    this._crashWindowStart = null;
    this._circuitBreakerTripped = false;
    this.autoStart = autoStart === true;  // 面板重启后自动恢复（DB 持久化，默认关）
    this._lastSaveTime = null;      // 真实存档时刻（来自 "Saved the game" 日志）
    // 仪表盘扩展状态
    this._weather = 'clear';       // clear / rain / thunder
    this._worldTime = null;        // 0-24000 ticks
    this._worldDay = null;         // MC 世界天数
    this._sleepingPlayers = 0;     // 入睡玩家数
    this._worldTimer = null;       // 世界时间查询定时器
    this._publicIp = null;         // 公网 IP（异步探测后缓存）
    this._worldSpawn = null;       // 世界出生点 { x, y, z }（从 level.dat 读取）
    this._worldSpawnRaw = null;    // 上次成功解析时 level.dat 的原始字节，运行期变更检测用
    // 异步探测公网 IP（环境变量 → 云元数据 → ipify），不阻塞构造
    this._detectPublicIp();
    // 启动时读取世界出生点（纯文件 I/O，不阻塞）
    this._readWorldSpawnFromLevelDat();
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
  /// 探测结果缓存到 this._publicIp，供 _getServerAddress() 同步使用。
  async _detectPublicIp() {
    // 1. 环境变量 PUBLIC_IP 优先（部署时由用户/systemd 注入）
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
    // 4. 探测失败，保持 null，_getServerAddress 回退到局域网 IP
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
    return this.isRunning && this.properties['enable-rcon'] === 'true' && !!this.properties['rcon.password'];
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
          props[key] = value;
        }
      }
      return props;
    } catch {
      return {};
    }
  }

  /// 属性值转义：将值内真实换行（\n/\r）替换为字面 "\\n"/"\\r"，
  /// 防止单属性值内嵌换行走私多键注入（find-018-service）。
  /// server.properties 为逐行 key=value 格式，真实换行会被当作行分隔符解析。
  _escapePropertyValue(value) {
    return String(value)
      .replace(/\r\n/g, '\\n')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  _saveProperties(props) {
    const propsPath = path.join(this.serverPath, 'server.properties');
    const lines = Object.entries(props)
      .map(([key, value]) => `${key}=${this._escapePropertyValue(value)}`);
    atomicWriteFile(propsPath, lines.join('\n') + '\n');
    this.properties = props;
  }

  /// 公开方法：保存 server.properties（供 routes 调用）
  /// 保留原注释行（以 # 开头），仅更新键值对；未在 props 中出现的键保留原值。
  /// 保留文件级"未知键自动追加"合并行为（files 路由直接编辑文件场景需要；
  /// API 路径的键白名单由 status-route 路由层负责）。
  saveProperties(props) {
    const propsPath = path.join(this.serverPath, 'server.properties');
    // 读取原文件，保留注释行
    let comments = [];
    let onDisk = {};
    if (fs.existsSync(propsPath)) {
      try {
        const content = fs.readFileSync(propsPath, 'utf-8');
        comments = content.split('\n').filter(l => l.trim().startsWith('#'));
        // 合并基址取磁盘最新内容而非内存缓存：缓存仅构造时加载一次，
        // 文件被外部编辑（files 路由/游戏内命令）后不刷新，以陈旧缓存
        // 为基址会把文件编辑值回滚（如 max-players=100 被覆盖回 20）
        onDisk = this._loadProperties();
      } catch {}
    }
    // 合并：磁盘原属性 → 新属性覆盖
    const merged = { ...onDisk, ...props };
    const lines = [
      ...comments,
      ...Object.entries(merged).map(([key, value]) => `${key}=${this._escapePropertyValue(value)}`)
    ];
    atomicWriteFile(propsPath, lines.join('\n') + '\n');
    this.properties = merged;
  }


  /// 获取服务器对外可达地址（仪表盘顶栏展示 + 复制）。
  /// 优先级：公网 IP（环境变量 PUBLIC_IP 或自动探测）→ server.properties 的 server-ip
  ///         （非空、非 0.0.0.0）→ 本机局域网 IPv4 → localhost 兜底。
  _getServerAddress(props) {
    const port = props['server-port'] || '25565';
    // 优先使用公网 IP（云服务器场景下局域网 IP 对客户端不可达）
    if (this._publicIp) {
      return `${this._publicIp}:${port}`;
    }
    const ip = props['server-ip'];
    if (ip && ip.trim() && ip !== '0.0.0.0' && ip !== '::') {
      return `${ip}:${port}`;
    }
    try {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            return `${net.address}:${port}`;
          }
        }
      }
    } catch {}
    return `localhost:${port}`;
  }


  /// 校验可执行文件是否为合法 java 启动器（find-002-service javaPath 校验）：
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

  /// 启动参数白名单校验（find-002-service 结构化参数）：
  /// 仅允许 -X/-D 前缀参数、'nogui' 与 '-jar'；'-jar' 的路径参数 resolve 后
  /// 必须位于 serverPath 内（越界拒绝）。非法参数抛错拒绝启动，
  /// 杜绝经 jvmArgs/旧 startCommand 注入任意可执行行为。
  /// 结构化 jvmArgs 补全基础参数（find-002 回归修复）：
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

  /// 旧 startCommand 兼容解析（find-002-service 兼容读取）：
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

    // 实例启动前对账 tempban 状态：停机期间用户可能直接编辑
    // banned-players.json 添加/删除封禁，导致面板 DB 与文件不一致。
    // 方向 1：文件有但 DB 无活跃记录 → 文件直接添加的封禁，补入 DB（永久）
    // 方向 2：DB 已过期但文件仍存在 → 停机期间到期未 pardon，清理文件 + 停用记录
    try { reconcileTempBans(this.id, this.serverPath); } catch (e) {
      logger.warn(`[${this.id}] tempban 对账失败（不阻塞启动）:`, e.message);
    }

    // 清理 world 锁文件，防止 session.lock 冲突
    // 注意：不使用 pkill，避免误杀同名进程和命令注入风险
    this.process = null;
    // 使用 level-name 而非硬编码 'world'，兼容自定义世界目录名；
    // 服务层兜底校验（extra-1）：非法/越界 level-name 回退 'world'，
    // 保证 unlink 只作用于实例目录内的锁文件（越界拒绝并告警）
    const lockLevelName = this._getSafeLevelName();
    const lockPath = path.join(this.serverPath, lockLevelName, 'session.lock');
    try { fs.unlinkSync(lockPath); } catch {}

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
    if (!this.isRunning || !this.process) {
      throw new Error('Server is not running');
    }
    // 用户主动停止：标记为手动，避免被误判为意外停止而触发自动重启，
    // 并取消重启的延迟启动（用户明确停止后不得 3 秒后被自动拉起）
    this._manualStop = true;
    this.cancelRestart();
    this.sendCommand('stop').catch(() => {});
  }

  // 优雅停止：await 发送 stop 命令并等待 MC 正常退出（exit 事件），
  // 超时后强杀兜底。供服务端停机流程（stopAll）使用——原 stop() 为
  // fire-and-forget，停机时 MC 可能收不到命令就随父进程退出成为孤儿，
  // 在线玩家数据（离开事件/60s 保存）随之丢失。
  async stopGracefully({ timeout = 8000 } = {}) {
    if (!this.isRunning || !this.process) return;
    this._manualStop = true;
    this.cancelRestart();
    try {
      await this.sendCommand('stop');
    } catch {
      // 发送失败（RCON 断开等）：直接进入等待/强杀流程
    }
    if (!this.isRunning || !this.process) return; // 发送阶段就已退出
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
    // 超时仍未退出 → 强杀，不留孤儿进程
    if (this.isRunning) {
      try { this.kill(); } catch {}
    }
  }

  restart() {
    if (this.isRunning) {
      // 主动重启：标记为手动停止，避免 stop 阶段触发自动重启
      this._manualStop = true;
      this.sendCommand('stop').catch(() => {});
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
    }, 3000);
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
    if (this.process) {
      const pid = this.process.pid;
      // 只杀主进程不够：MC 1.18+/26.x 官方 server.jar 为 Bundler 结构，
      // java 主进程（BundlerMain 引导器）经 ProcessBuilder 派生真正运行的
      // 服务器 JVM，主进程被杀后 JVM 成为孤儿继续运行（Linux 被 init 收养
      // 继续占用/写世界数据；Windows 上 libuv job object 的
      // JOB_OBJECT_KILL_ON_JOB_CLOSE 因宿主 mc-commander 进程仍存活而不触发）。
      // 旧版（1.17-）server.jar 直接运行服务器主类、无派生进程，进程树终止
      // 对其同样有效，保持新旧版本兼容。
      if (pid) {
        if (process.platform === 'win32') {
          // taskkill /T 从根进程向下递归遍历，根必须先存活才能定位整棵树
          // （先杀根会让 taskkill 报"找不到进程"而无法递归）。
          try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {}
        } else {
          // Linux/macOS：start() 以 detached:true spawn 使主进程成为进程组组长
          // （pid 即 PGID），kill(-pid) 一次性终止整组（含组长自身）
          try { process.kill(-pid, 'SIGKILL'); } catch {}
        }
      }
      // 单进程 SIGKILL 兜底（进程树杀失败/pid 缺失时仍杀主进程本身）
      try { this.process.kill('SIGKILL'); } catch {}
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

  async sendCommand(command) {
    if (!this.isRunning || !this.process) {
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
    // feat-2: 命令历史落库（chokepoint finally）
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
    this._writeToStdin(command + '\n');
    return null;
    } catch (err) {
      cmdSuccess = false;
      throw err;
    } finally {
      try {
        CommandHistoryModel.create({
          instanceId: this.id,
          command,
          source: 'api',
          success: cmdSuccess ? 1 : 0,
          durationMs: Date.now() - cmdStart,
        });
      } catch { /* audit write failure never blocks command flow */ }
    }
  }

  sendCommandWithResponse(command, { timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isRunning || !this.process) {
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
          }
        );
        return;
      }

      // Fallback: 使用 stdin/stdout + mcsmp 协议（需要 Mod 支持）
      const commandId = ++this._commandIdCounter;
      const responseBuffer = [];

      const timeoutTimer = setTimeout(() => {
        this._commandResponsePromises.delete(commandId);
        reject(new Error('Command timeout'));
      }, timeout);

      this._commandResponsePromises.set(commandId, {
        resolve: (output) => {
          clearTimeout(timeoutTimer);
          this._commandResponsePromises.delete(commandId);
          resolve(output);
        },
        reject: (error) => {
          clearTimeout(timeoutTimer);
          this._commandResponsePromises.delete(commandId);
          reject(error);
        },
        buffer: responseBuffer,
      });

      this._writeToStdin(`mcsmp_${commandId} ${command}\n`);
    });
  }

  _startStatsCollection() {
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
  _schedulePlayerStats() {
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
  _scheduleMspt() {
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
  _scheduleWorldState() {
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

  _stopStatsCollection() {
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

  _collectStats() {
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

  _collectLinuxStats(pid) {
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
  async _collectMspt() {
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
  async _collectWorldState() {
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
  async _queryWorldTime() {
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
  async _queryWorldDay() {
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
  async _collectPlayerStats() {
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

  _emitPerformance() {
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
    this.emit('performanceUpdate', {
      cpu: this._cpuUsage,
      memory: this._memoryUsage,
      tps: this.tps,
      mspt: this._mspt || 0,
      worldTime: this._worldTime,
      worldDay: this._worldDay,
      sleepingPlayers: this._sleepingPlayers,
      sleepingPlayerNames,
      awakePlayerNames,
    });
    // tps 随 performanceUpdate 的 payload 统一广播，不再单独发送 tpsUpdate
    // 事件（避免 websocket 双消息冗余）
  }

  toStatus() {
    const props = this.properties;
    const uptimeMs = this.isRunning && this.startTime ? Date.now() - this.startTime : 0;
    return {
      id: this.id,
      name: this.name,
      isRunning: this.isRunning,
      isRconConnected: this.isRconConnected,
      // 意外停止自动重启开关（供前端设置页读写）
      autoRestart: this.autoRestart,
      uptime: Math.floor(uptimeMs / 1000),
      address: this._getServerAddress(props),
      players: Array.from(this.players.values()),
      playerCount: this.players.size,
      maxPlayers: parseInt(props['max-players'] || '20'),
      mcVersion: this._getMcVersion(),
      modLoader: this._getModLoader(),
      tps: this.tps,
      mspt: this._mspt,
      cpuUsage: this._cpuUsage,
      memoryUsage: this._memoryUsage,
      totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10,
      worldSize: this._getWorldSize(),
      seed: this._readSeedFromLevelDat(),
      lastSave: this._getLastSaveTime(),
      lastOutput: this.lastOutput,
      gameMode: props['gamemode'] || 'survival',
      difficulty: props['difficulty'] || 'normal',
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
      // ── 运维韧性字段（feat-5）──
      autoStart: this.autoStart,
      circuitBreakerTripped: this._circuitBreakerTripped,
      consecutiveCrashes: this._consecutiveCrashes,
      // ── 启动配置（供实例设置弹窗读写）──
      startCommand: this.startCommand,
      jvmArgs: this.jvmArgs,
      javaPath: this.javaPath,
      maxMemory: this.maxMemory,
      minMemory: this.minMemory,
      jarFile: this.jarFile
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

  _todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /// 获取累计运行时长（秒）：数据库持久化的累计值 + 本次运行时长
  _getTotalUptime() {
    let total = 0;
    try { total = InstanceModel.getTotalUptime(this.id) || 0; } catch {}
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
          return ops.map(op => op.name).filter(Boolean);
        }
      }
    } catch { /* ignore */ }
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
              lastSeen: entry.expiresOn || null,
            });
          }
        }
      } catch {
      }
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
      } catch {
      }
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
      } catch {
      }
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
      } catch {
      }
    }

    return knownPlayers;
  }

  _getMcVersion() {
    // DB 持久化版本优先（部署/升级时写入，重启后由 loadInstances 传入）
    if (this.mcVersion) return this.mcVersion;
    // 兜底：扫描实例目录 versions/ 子目录（仅当 DB 无版本时）
    const versionPath = path.join(this.serverPath, 'versions');
    if (fs.existsSync(versionPath)) {
      try {
        const versions = fs.readdirSync(versionPath);
        if (versions.length > 0) return versions[0];
      } catch {
      }
    }
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
    } catch {
    }
    return 'Vanilla';
  }

  getLogs(lines = 100) {
    return this.logBuffer.slice(-lines);
  }

  _getPlayerUuid(playerName) {
    const cachePath = path.join(this.serverPath, 'usercache.json');
    if (!fs.existsSync(cachePath)) return null;
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      for (const entry of cache) {
        if (entry.name === playerName && entry.uuid) return entry.uuid;
      }
    } catch {}
    return null;
  }

  _savePlayerData(playerName, data) {
    try {
      const dir = path.join(this.serverPath, 'playerdata');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${playerName}.json`);
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
      atomicWriteFile(filePath, JSON.stringify({
        ...existing,
        ...dataCopy,
        ...cached,
        _cachedDetails: undefined,
        events: mergedEvents,
        // lastSeen 语义为「最后离线时间」：仅在玩家离开/服务器退出时由调用方
        // 设置为离线时刻。日常 60s 自动保存/在线保存不得用 Date.now() 覆盖，
        // 否则「最后在线时间」会被刷成「最后保存时间」。
        lastSeen: dataCopy.lastSeen ?? existing.lastSeen ?? null,
      }, null, 2));
    } catch (e) {
      // 写盘失败（磁盘满/权限异常等）不得静默吞掉：
      // 60s 定时保存与离开/停机最终保存都会走这里，失败意味着
      // 玩家累计时长/事件/lastSeen 回退丢失，必须留日志可排查
      logger.error(`[${this.id}] Failed to save player data for ${playerName}:`, e.message);
    }
  }

  _loadPlayerData(playerName) {
    try {
      const filePath = path.join(this.serverPath, 'playerdata', `${playerName}.json`);
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
      const cn = components['minecraft:custom_name']?.value || components['minecraft:item_name']?.value;
      if (cn) customName = this._extractTextName(cn);
    }

    return { id, count: Math.max(1, count), slot, durability: null, enchanted, customName };
  }

  // 将已解析的物品列表构建为客户端 PlayerInventory 结构
  // invList/enderList 元素应为 { id, count, slot, ... } 格式（由 _parseNbtItem 或 _parseSnbtItem 解析）
  _buildInventoryResult(invList, enderList, source, isPartial = false) {
    const quickbar = new Array(9).fill(null);
    const main = new Array(27).fill(null);
    const equipment = { helmet: null, chestplate: null, leggings: null, boots: null, offhand: null };
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

    for (const item of (invList || [])) place(item);
    for (const item of (enderList || [])) {
      if (!item) continue;
      const { slot, ...data } = item;
      if (slot >= 0 && slot <= 26) enderChest[slot] = data;
    }

    return { quickbar, main, equipment, enderChest, source, partial: !!isPartial };
  }

  // 从 playerdata/<uuid>.dat 读取物品栏（gzip NBT），返回快照数据
  _loadInventoryFromDat(uuid, playerName) {
    // level-name 服务层兜底校验（find-008-read）：非法/越界回退 'world'
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
      candidates.push(path.join(this.serverPath, levelName, 'players', 'data', `${offlineUuid}.dat`));
      candidates.push(path.join(this.serverPath, 'world', 'players', 'data', `${offlineUuid}.dat`));
      candidates.push(path.join(this.serverPath, levelName, 'playerdata', `${offlineUuid}.dat`));
      candidates.push(path.join(this.serverPath, 'world', 'playerdata', `${offlineUuid}.dat`));
      candidates.push(path.join(this.serverPath, 'playerdata', `${offlineUuid}.dat`));
    }

    let datPath = null;
    for (const c of candidates) {
      // 兜底防御（find-008-read）：候选路径 resolve 后必须位于 serverPath 内，越界丢弃
      if (!isPathContained(this.serverPath, c)) continue;
      if (fs.existsSync(c)) { datPath = c; break; }
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
        return Array.isArray(v) ? v : (v?.value || []);
      };

      // 兼容新旧字段名（1.20.5+ 用小写）
      const invList = extractList(root.Inventory).map(i => this._parseNbtItem(i)).filter(Boolean);
      const enderList = extractList(root.EnderItems).map(i => this._parseNbtItem(i)).filter(Boolean);

      // MC 26.1+ 新增 equipment 字段（装备物品独立存储，不在 Inventory 列表中）
      const eqNbt = root.equipment?.value || root.Equipment?.value;
      if (eqNbt && typeof eqNbt === 'object') {
        const eqSlots = { head: 103, chest: 102, legs: 101, feet: 100, offhand: -106 };
        for (const [key, slotNum] of Object.entries(eqSlots)) {
          const item = this._parseNbtItem(eqNbt[key]);
          if (item) { item.slot = slotNum; invList.push(item); }
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

  // 从 RCON 响应文本提取 NBT 部分（"Player has the following entity data: {...}"）
  _extractNbtFromResponse(text) {
    if (!text) return null;
    const idx = text.indexOf('{');
    if (idx === -1) return null;
    return text.substring(idx);
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
    let depth = 0, start = -1, inStr = false, strCh = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { items.push(inner.substring(start, i + 1)); start = -1; } }
    }

    return items.map(snbtItem => this._parseSnbtItem(snbtItem)).filter(Boolean);
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
    const enchanted = /Enchantments:\s*\[/i.test(snbt)
      || /"minecraft:enchantments"/i.test(snbt)
      || /"minecraft:stored_enchantments"/i.test(snbt);

    // 自定义名称（简化提取）
    let customName = null;
    const nameMatch = snbt.match(/Name:\s*'(\{[^']*\})'/) || snbt.match(/"minecraft:custom_name":\s*'([^']*)'/);
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
    const sessions = (player?.sessions && player.sessions.length > 0)
      ? player.sessions
      : (Array.isArray(savedData?.sessions) ? savedData.sessions : []);

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
    const sessionSeconds = (player?.joinTime) ? Math.floor((Date.now() - player.joinTime) / 1000) : 0;
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
        const _isValidDataGet = (resp) => typeof resp === 'string' && resp.includes('has the following entity data');

        const posResult = await _r(`data get entity ${playerName} Pos`);
        const healthResult = await _r(`data get entity ${playerName} Health`);
        const hungerResult = await _r(`data get entity ${playerName} foodLevel`);
        const xpResult = await _r(`data get entity ${playerName} XpLevel`);
        const gmResult = await _r(`data get entity ${playerName} playerGameType`);
        const dimResult = await _r(`data get entity ${playerName} Dimension`);

        const posMatch = _isValidDataGet(posResult) ? posResult.match(/\[(-?[\d.]+)(?:d)?, (-?[\d.]+)(?:d)?, (-?[\d.]+)(?:d)?\]/) : null;
        if (posMatch) {
          details.position = {
            x: parseFloat(posMatch[1]),
            y: parseFloat(posMatch[2]),
            z: parseFloat(posMatch[3]),
          };
        }

        // 注意：data get entity 返回格式为 "玩家名 has the following entity data: 值"
        // 正则必须通过冒号定位避免匹配到玩家名中的数字
        const healthMatch = _isValidDataGet(healthResult) ? healthResult.match(/:\s*([\d.]+)/) : null;
        if (healthMatch) details.health = parseFloat(healthMatch[1]);

        // MaxHealth：使用 /attribute 按属性名查询基值（兼容新旧版属性ID变更）
        // 旧代码用 Attributes[0].base 硬编码索引，插件改变属性顺序时会读到错误值
        const maxHealthVal = await this._queryAttribute(_r, playerName, 'minecraft:generic.max_health', 'minecraft:max_health', true);
        details.maxHealth = maxHealthVal != null ? maxHealthVal : 20;

        // 护甲：使用 /attribute 查询最终值（含装备加成），兼容新旧版
        const armorVal = await this._queryAttribute(_r, playerName, 'minecraft:generic.armor', 'minecraft:armor');
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
        const respawnPosMatch = _isValidDataGet(respawnPosResult) ? respawnPosResult.match(/\[(?:I;\s*)?(-?[\d.]+)[a-zA-Z]?[\s,]+(-?[\d.]+)[a-zA-Z]?[\s,]+(-?[\d.]+)[a-zA-Z]?/) : null;
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
          const spawnXMatch = _isValidDataGet(spawnXResult) ? spawnXResult.match(/:\s*(-?[\d.]+)/) : null;
          if (spawnXMatch) {
            const spawnYResult = await _r(`data get entity ${playerName} SpawnY`);
            const spawnZResult = await _r(`data get entity ${playerName} SpawnZ`);
            const spawnYMatch = _isValidDataGet(spawnYResult) ? spawnYResult.match(/:\s*(-?[\d.]+)/) : null;
            const spawnZMatch = _isValidDataGet(spawnZResult) ? spawnZResult.match(/:\s*(-?[\d.]+)/) : null;
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
      const candidates = [
        path.join(this.serverPath, levelName, 'players', 'stats', `${uuid}.json`),
        path.join(this.serverPath, 'world', 'players', 'stats', `${uuid}.json`),
        path.join(this.serverPath, levelName, 'stats', `${uuid}.json`),
        path.join(this.serverPath, 'world', 'stats', `${uuid}.json`),
      ];
      // offline uuid 候选无条件追加：无 usercache 记录时
      // 离线模式玩家的真实统计仍可读取
      const offlineUuid = computeOfflineUuid(playerName);
      if (offlineUuid && offlineUuid !== uuid) {
        candidates.push(path.join(this.serverPath, levelName, 'players', 'stats', `${offlineUuid}.json`));
        candidates.push(path.join(this.serverPath, 'world', 'players', 'stats', `${offlineUuid}.json`));
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
      if (real && (real.deaths != null || real.playTime != null || real.sleepInBed != null || real.leaveGame != null)) {
        let lastClosedEnd = null;
        for (const s of sessions) {
          if (s.end != null) lastClosedEnd = s.end;
        }
        const offlineSince = player
          ? 0
          : (lastClosedEnd ? Math.max(0, Math.floor((now - lastClosedEnd) / 1000)) : 0);
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
      const end = s.end != null ? s.end : (player ? now : s.start);
      totalOnline += Math.max(0, Math.floor((end - s.start) / 1000));
      if (s.end != null) lastClosedEnd = s.end;
    }
    const loginCount = sessions.length;
    // 已离线：最后一个结束会话的结束时刻至今（在线玩家为 0）
    const offlineSince = player
      ? 0
      : (lastClosedEnd ? Math.max(0, Math.floor((now - lastClosedEnd) / 1000)) : 0);

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
Object.assign(MCServerInstance.prototype, levelDat);

// 进程输出解析域挂载（issue 494 治理线·服务端第二阶段）：output-parser 模块经原型注入复用，
// 模块函数体内 this 语义与类内定义完全一致（实例方法调用时 this 绑定实例），
// 全部调用点零改动，对外接口零变化。
Object.assign(MCServerInstance.prototype, outputParser);
