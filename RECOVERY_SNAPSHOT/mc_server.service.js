import { spawn, spawnSync, exec } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import { Rcon } from 'rcon-client';
import { parseUncompressed as parseNbtSync } from 'prismarine-nbt';
import config from '../config.js';
import { InstanceModel } from '../db/index.js';
import { CommandHistoryModel } from '../db/index.js';
import { atomicWriteFile } from '../utils/fs-utils.js';
// offline uuid / stats 时长读取全仓公共实现（与 routes/players.js 共用 player-utils.js）
import { offlineUuid as computeOfflineUuid, getTotalPlayTime } from '../utils/player-utils.js';

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
      console.log(`Loading ${dbInstances.length} instances from DB`);
    } catch (e) {
      console.warn('Failed to load instances from DB, will try file system:', e.message);
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
        });
        console.log(`Loaded instance from DB: ${inst.id}`);
      } catch (e) {
        console.error(`Failed to load DB instance ${inst.id}:`, e);
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
                console.log(`Loaded migrated instance: ${instanceConfig.id}`);
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
          console.log(`Migrating instance ${instanceConfig.id} from JSON to DB...`);
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
            console.log(`Migrated instance ${instanceConfig.id} to DB`);
          }
        } catch (e) {
          console.error(`Failed to load/migrate instance ${dir.name}:`, e);
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
  constructor({ id, name, javaPath, jarFile, maxMemory, minMemory, serverPath, startCommand, jvmArgs, autoRestart }) {
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
  /// 正确性优先：每次访问都 readFileSync + 字节对比，仅在字节变化时才
  /// gunzip/NBT 重解析；字节未变时只付一次文件 I/O，零解析开销。
  /// 不再做 mtime/size 快速路径：同一时间片内重写文件 mtime 可能不变、
  /// gzip 同尺寸改写 size 可能不变（回归测试与真实 /setworldspawn 落盘
  /// 均可命中盲区），stat 快照无法作为新鲜度凭据——详见 CHANGES.md#fix-1。
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

  /// level-name 服务层兜底校验（extra-1，与 status-route 路由层白名单双保险）：
  /// ①正则 ^[A-Za-z0-9_-]+$（不含路径分隔符/..，杜绝路径穿越）；
  /// ②resolve 后必须位于 serverPath 内（路径边界前缀校验）。
  /// 非法/越界时告警并回退 'world'（合法世界名恒在 serverPath 内），
  /// 避免恶意/损坏的 level-name 使本服务的文件读写越出实例目录。
  _getSafeLevelName() {
    const raw = this.properties?.['level-name'] || 'world';
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) {
      console.warn(`[Instance ${this.id}] 非法 level-name '${raw}'（仅允许字母/数字/_/-），回退 'world'`);
      return 'world';
    }
    if (!isPathContained(this.serverPath, raw)) {
      console.warn(`[Instance ${this.id}] level-name '${raw}' 越出实例目录，回退 'world'`);
      return 'world';
    }
    return raw;
  }

  _getWorldSize() {
    // 使用 server.properties 的 level-name 而非硬编码 'world'，
    // 兼容自定义世界目录名的实例（服务层兜底校验防路径穿越）
    const levelName = this._getSafeLevelName();
    const worldPath = path.join(this.serverPath, levelName);
    if (!fs.existsSync(worldPath)) return 0;

    // 带失效机制的缓存（与 _readSeedFromLevelDat 同型）：记录世界目录的
    // mtimeMs/size，每次调用仅对该目录做一次 statSync 校验，目录结构或存档
    // 变化（mtime/size 变化）才重算。worldSize 是低频变化数据（仅存档落盘
    // 时变），若每次轮询都对全树做 readdirSync+statSync 同步遍历，数万文件
    // 目录单次遍历约 3 秒，会同步阻塞 Node 事件循环（HTTP/WS/RCON/定时器
    // 全部延迟）。目录被删除/替换（恢复备份、版本升级等）后 mtime/size 变化
    // 即自动失效重算，对新旧 MC 版本目录结构差异（含 26.x 新增 dimension/
    // minecraft:* 层级）同样生效，无需版本特判。仅成功时缓存：世界目录
    // 不存在/遍历失败不缓存，便于世界生成后立即重算。
    if (this._worldSizeCache !== undefined) {
      const { value, mtimeMs, size } = this._worldSizeCache;
      try {
        const st = fs.statSync(worldPath);
        if (st.mtimeMs === mtimeMs && st.size === size) return value;
      } catch {
        // 世界目录被删除/替换 → 缓存失效，重新计算
      }
      this._worldSizeCache = undefined;
    }

    try {
      // 遍历前先取目录 stat 作缓存键：若遍历期间目录发生变化，下次调用
      // 校验失效触发重算，保证展示值收敛到最新大小。
      const st = fs.statSync(worldPath);
      // 递归累加所有文件大小（region/、playerdata/、data/ 等子目录
      // 占据世界数据主体，仅遍历顶层文件会严重低估存档大小）
      let size = 0;
      const stack = [worldPath];
      while (stack.length > 0) {
        const dir = stack.pop();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(fullPath);
          } else if (entry.isFile()) {
            try {
              size += fs.statSync(fullPath).size;
            } catch {}
          }
        }
      }
      this._worldSizeCache = {
        value: Math.round(size / (1024 * 1024 * 1024) * 100) / 100,
        mtimeMs: st.mtimeMs,
        size: st.size,
      };
      return this._worldSizeCache.value;
    } catch (err) {
      console.warn(`[Instance ${this.id}] 计算存档大小失败:`, err.message);
      return 0;
    }
  }

  /// 读取世界种子（NBT 格式），兼容新旧 MC 版本。
  /// MC 26.1+  : WorldGenSettings 从 level.dat 拆分到独立的 world_gen_settings.dat（优先读取）
  /// MC 1.16+  : Data.WorldGenSettings.seed（level.dat）
  /// 旧版      : Data.RandomSeed（level.dat）
  /// server.properties 的 level-seed 在世界创建后通常为空，无法反映真实种子。
  _readSeedFromLevelDat() {
    // 缓存带失效机制：记录读取源文件的路径、修改时间与大小，每次调用先校验，
    // 源文件被替换（恢复备份、手动替换世界目录等）后 mtime/size 变化即自动
    // 失效重读，避免仪表盘永久显示旧种子。仅成功时缓存：若存档尚未生成或
    // 解析失败，不缓存，便于世界生成/版本升级后重试。
    if (this._seedCache !== undefined) {
      const { value, sourcePath, mtimeMs, size } = this._seedCache;
      try {
        const st = fs.statSync(sourcePath);
        if (st.mtimeMs === mtimeMs && st.size === size) return value;
      } catch {
        // 源文件不存在（世界目录被删除/替换）→ 缓存失效，重新读取
      }
      this._seedCache = undefined;
    }

    // 优先 MC 26.1+ 拆分出的 world_gen_settings.dat
    const genSeed = this._readSeedFromWorldGenSettings();
    if (genSeed != null) {
      this._seedCache = {
        value: genSeed.seed,
        sourcePath: genSeed.path,
        mtimeMs: genSeed.mtimeMs,
        size: genSeed.size,
      };
      return genSeed.seed;
    }

    // 回退旧版 level.dat
    const levelName = this._getSafeLevelName();
    const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
    if (!fs.existsSync(levelDatPath)) return null;

    try {
      const raw = fs.readFileSync(levelDatPath);
      const decompressed = zlib.gunzipSync(raw);
      const parsed = parseNbtSync(decompressed);

      const data = parsed?.value?.Data?.value || parsed?.value || {};
      // 1.16+ 的 WorldGenSettings.seed
      const worldGenSeed = data.WorldGenSettings?.value?.seed?.value;
      if (worldGenSeed != null) {
        this._seedCache = this._makeSeedCache(String(worldGenSeed), levelDatPath);
        return String(worldGenSeed);
      }
      // 旧版的 RandomSeed
      const randomSeed = data.RandomSeed?.value;
      if (randomSeed != null) {
        this._seedCache = this._makeSeedCache(String(randomSeed), levelDatPath);
        return String(randomSeed);
      }
      return null;
    } catch (err) {
      console.warn(`[Instance ${this.id}] 读取世界种子失败:`, err.message);
      return null;
    }
  }

  /// 从 MC 26.1+ 的 world_gen_settings.dat 读取世界种子
  /// 26.1 起 WorldGenSettings 从 level.dat 拆分到独立文件，真实路径为
  /// <world>/<dimension>/data/minecraft/world_gen_settings.dat（主世界用 level-name 对应目录），
  /// 保留世界根目录 world_gen_settings.dat 作为兜底。
  /// 文件根为 { data: {...}, DataVersion }，seed 在 data 子节点；兼容直接以
  /// WorldGenSettings 内容为根的拆分结构。
  _readSeedFromWorldGenSettings() {
    const levelName = this._getSafeLevelName();
    const genPaths = [
      path.join(this.serverPath, levelName, 'data', 'minecraft', 'world_gen_settings.dat'),
      path.join(this.serverPath, levelName, 'world_gen_settings.dat'),
    ];
    const genPath = genPaths.find((p) => fs.existsSync(p));
    if (!genPath) return null;

    try {
      const raw = fs.readFileSync(genPath);
      const decompressed = zlib.gunzipSync(raw);
      const parsed = parseNbtSync(decompressed);
      const root = parsed?.value || {};
      const data = root.data?.value || root;

      const candidates = [
        data.seed,
        data.WorldGenSettings?.value?.seed,
        root.WorldGenSettings?.value?.seed,
        root.seed,
      ];
      for (const c of candidates) {
        if (c?.value != null) {
          const st = fs.statSync(genPath);
          return { seed: String(c.value), path: genPath, mtimeMs: st.mtimeMs, size: st.size };
        }
      }
      return null;
    } catch (err) {
      console.warn(`[Instance ${this.id}] 读取 world_gen_settings.dat 种子失败:`, err.message);
      return null;
    }
  }

  /// 构造种子缓存条目（含源文件 mtime/size，用于校验缓存是否失效）
  _makeSeedCache(value, sourcePath) {
    const st = fs.statSync(sourcePath);
    return { value, sourcePath, mtimeMs: st.mtimeMs, size: st.size };
  }

  /// 获取运行中的真实难度（多端同步用）。
  /// 游戏内 /difficulty 只改 level.dat，不写回 server.properties，因此：
  /// 优先 RCON 实时查询 /difficulty（内存值，无延迟）；
  /// RCON 不可用/失败时回退解析 level.dat
  /// （MC 26.x difficulty_settings.difficulty 字符串 / 旧版 Difficulty 字节）。
  /// 返回 'peaceful'|'easy'|'normal'|'hard'，解析失败返回 null（由调用方回退文件值）。
  async readDifficulty() {
    if (this.isRunning && this.isRconConnected) {
      try {
        const resp = await this.sendCommandWithResponse('difficulty', {
          timeout: 3000,
        });
        const m = String(resp || '').match(/difficulty is\s+(\w+)/i);
        if (m && m[1]) return m[1].toLowerCase();
      } catch {}
    }
    return this._readDifficultyFromLevelDat();
  }

  /// 从 level.dat 读取默认游戏模式（GameType: 0=生存/1=创造/2=冒险/3=旁观）。
  /// 游戏内 /defaultgamemode 修改 level.dat 的 GameType，不写回 server.properties。
  /// 返回 'survival'|'creative'|'adventure'|'spectator'，解析失败返回 null。
  _readGameTypeFromLevelDat() {
    const data = this._readLevelDatData();
    if (!data) return null;
    const num = data.GameType?.value;
    if (typeof num === 'number' && num >= 0 && num <= 3) {
      return ['survival', 'creative', 'adventure', 'spectator'][num];
    }
    return null;
  }

  /// 从 level.dat 读取难度。
  /// MC 26.x：Data.difficulty_settings.difficulty（字符串 peaceful/easy/normal/hard）；
  /// 旧版：Data.Difficulty（字节 0-3）。返回小写难度词或 null。
  _readDifficultyFromLevelDat() {
    const data = this._readLevelDatData();
    if (!data) return null;
    const ds = data.difficulty_settings?.value;
    if (ds?.difficulty?.value) {
      const v = String(ds.difficulty.value).toLowerCase();
      if (['peaceful', 'easy', 'normal', 'hard'].includes(v)) return v;
    }
    const num = data.Difficulty?.value;
    if (typeof num === 'number' && num >= 0 && num <= 3) {
      return ['peaceful', 'easy', 'normal', 'hard'][num];
    }
    return null;
  }

  /// 读取并解压 level.dat，返回 Data 子节点（无/解析失败返回 null）。
  /// 26.x 仍把 difficulty_settings/GameType 存于 Data 子节点。
  _readLevelDatData() {
    const levelName = this._getSafeLevelName();
    const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
    if (!fs.existsSync(levelDatPath)) return null;
    try {
      const parsed = parseNbtSync(
        zlib.gunzipSync(fs.readFileSync(levelDatPath)),
      );
      return parsed?.value?.Data?.value || parsed?.value || null;
    } catch (err) {
      console.warn(`[Instance ${this.id}] 读取 level.dat 失败:`, err.message);
      return null;
    }
  }

  _getLastSaveTime() {
    // 优先返回真实存档时刻（来自 "Saved the game" 日志解析）
    if (this._lastSaveTime) return this._lastSaveTime;
    // 回退：世界目录最后修改时间（服务器未输出存档日志或刚启动尚未存档时）
    const levelName = this._getSafeLevelName();
    const worldPath = path.join(this.serverPath, levelName);
    if (!fs.existsSync(worldPath)) return null;
    try {
      const stat = fs.statSync(worldPath);
      return stat.mtime.toISOString();
    } catch {
      return null;
    }
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

  /// 从存档文件读取天气状态（NBT 格式），兼容新旧 MC 版本。
  /// MC 26.x   : 天气已从 level.dat 移出，存于 <world>/data/minecraft/weather.dat 的 data 子节点
  /// 旧版      : level.dat 的 Data.raining / Data.thundering（含 isRaining/isThundering 兼容）
  /// 返回 'clear' / 'rain' / 'thunder'，读取失败返回 null
  _readWeatherFromLevelDat() {
    const levelName = this._getSafeLevelName();

    // 优先 MC 26.x：weather.dat
    const weatherPath = path.join(this.serverPath, levelName, 'data', 'minecraft', 'weather.dat');
    if (fs.existsSync(weatherPath)) {
      try {
        const parsed = parseNbtSync(zlib.gunzipSync(fs.readFileSync(weatherPath)));
        const root = parsed?.value || {};
        const data = root.data?.value || root;
        const isRaining = data.raining?.value === 1 || data.raining?.value === true;
        const isThundering = data.thundering?.value === 1 || data.thundering?.value === true;

        if (isThundering) return 'thunder';
        if (isRaining) return 'rain';
        return 'clear';
      } catch {
        // weather.dat 读取失败，回退旧版 level.dat
      }
    }

    // 回退旧版 level.dat
    const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
    if (!fs.existsSync(levelDatPath)) return null;

    try {
      const raw = fs.readFileSync(levelDatPath);
      // level.dat 是 gzip 压缩的 NBT 数据
      const decompressed = zlib.gunzipSync(raw);
      const parsed = parseNbtSync(decompressed);

      // NBT 结构: { Data: { raining, thundering, clearWeatherTime, rainTime, thunderTime, ... } }
      const data = parsed?.value?.Data?.value || parsed?.value || {};
      // MC 真实字段名为 raining/thundering；保留 isRaining/isThundering 兼容旧实现
      const isRaining = data.raining?.value === 1 || data.raining?.value === true
        || data.isRaining?.value === 1 || data.isRaining?.value === true;
      const isThundering = data.thundering?.value === 1 || data.thundering?.value === true
        || data.isThundering?.value === 1 || data.isThundering?.value === true;

      if (isThundering) return 'thunder';
      if (isRaining) return 'rain';
      return 'clear';
    } catch {
      // level.dat 读取失败
      return null;
    }
  }

  /// 从 level.dat 读取世界出生点坐标（NBT 格式）
  /// 旧版      : Data.SpawnX, Data.SpawnY, Data.SpawnZ（三个顶层 Int）
  /// MC 1.21+  : Data.spawn compound（含坐标与出生维度），坐标在 pos 列表或 SpawnX/Y/Z 字段中
  _readWorldSpawnFromLevelDat(rawOverride) {
    const levelName = this._getSafeLevelName();
    const levelDatPath = path.join(this.serverPath, levelName, 'level.dat');
    if (!fs.existsSync(levelDatPath)) return;

    try {
      // rawOverride：get _worldSpawn 已读取过原始字节时直接复用，避免重复读盘
      const raw = rawOverride ?? fs.readFileSync(levelDatPath);
      const decompressed = zlib.gunzipSync(raw);
      const parsed = parseNbtSync(decompressed);

      const data = parsed?.value?.Data?.value || parsed?.value || {};
      let spawnX, spawnY, spawnZ;
      // 新版（1.21+）：Data.spawn compound，优先 pos 数组，其次 SpawnX/Y/Z 字段
      const spawn = data.spawn?.value;
      if (spawn) {
        // prismarine-nbt 的 pos 可能是两种类型：
        // - intArray: { type: 'intArray', value: [x, y, z] }（实测 26.x 真实格式，value 直接是数组）
        // - list:     { type: 'list', value: { type, value: [x, y, z] } }
        const posVal = spawn.pos?.value;
        const posArr = Array.isArray(posVal) ? posVal : posVal?.value;
        if (Array.isArray(posArr) && posArr.length >= 3) {
          spawnX = posArr[0];
          spawnY = posArr[1];
          spawnZ = posArr[2];
        } else {
          spawnX = spawn.SpawnX?.value;
          spawnY = spawn.SpawnY?.value;
          spawnZ = spawn.SpawnZ?.value;
        }
      }
      // 旧版兜底：Data.SpawnX/SpawnY/SpawnZ
      if (spawnX == null) spawnX = data.SpawnX?.value;
      if (spawnY == null) spawnY = data.SpawnY?.value;
      if (spawnZ == null) spawnZ = data.SpawnZ?.value;

      if (spawnX != null && spawnY != null && spawnZ != null) {
        this._worldSpawn = { x: spawnX, y: spawnY, z: spawnZ };
        // 记录本次成功解析的原始字节，供 get _worldSpawn 做运行期变更检测；
        // 仅在成功解析后更新，解析失败时下次访问会重试
        this._worldSpawnRaw = raw;
        console.log(`[${this.id}] World spawn initialized from level.dat: ${spawnX}, ${spawnY}, ${spawnZ}`);
      }
    } catch (e) {
      console.warn(`[${this.id}] Failed to read world spawn from level.dat:`, e.message);
    }
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
      console.error(`[${this.id}] Failed to spawn server process:`, err.message);
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
        console.warn(`[${this.id}] Server stdin pipe error (server exited mid-command?):`, err.message);
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
      console.log(`[${this.id}] Weather initialized from level.dat: ${this._weather}`);
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
        try { InstanceModel.addUptime(this.id, uptimeSeconds); } catch (e) { console.warn('Failed to persist uptime:', e.message); }
      }

      // 区分「意外停止/崩溃」与「用户主动停止」：
      // 主动 stop/kill/restart 会设置 _manualStop=true；正常退出 code 通常为 0。
      const unexpectedExit = !this._manualStop && code !== 0;
      if (unexpectedExit) {
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
              console.log(`[${this.id}] Auto-restart cancelled: server jar no longer exists`);
              return;
            }
            try {
              this.start();
              console.log(`[${this.id}] 意外停止后自动重启成功`);
              this.emit('log', { text: '[服务器] 已自动重启', type: 'stdout' });
            } catch (e) {
              console.error(`[${this.id}] 自动重启失败:`, e.message);
              this.emit('log', { text: `[服务器] 自动重启失败: ${e.message}`, type: 'stderr' });
            }
          }, 5000);
        }
      } else {
        this.emit('status', { event: 'stopped', code });
      }
    });

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
        console.error(`RCON error on ${this.id}:`, err.message);
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
        console.log(`[${this.id}] Restart cancelled: server jar no longer exists`);
        return;
      }
      try {
        this.start();
      } catch (e) {
        console.error('Restart failed:', e);
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
      console.warn(`[${this.id}] stdin write failed:`, err.message);
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

    // 命令历史持久化：记录所有通过 RCON/stdin 发送的命令（roadmap 工程基建）
    const cmdStartTime = Date.now();
    let cmdSuccess = true;
    let cmdResponse = null;
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
          cmdResponse = response;
          return response;
        } catch (err) {
          // 命令执行失败（已解析出失败响应）→ 直接抛错，不回退 stdin（避免重复执行）
          if (err && err.isCommandExecutionError) {
            cmdSuccess = false;
            cmdResponse = err.message;
            throw err;
          }
          // 仅当确认命令未送达（连接建立失败 / 队列滞留项：命令从未写入 RCON
          // socket）才回退 stdin 兜底。其余错误（"Timeout for packet id N"、
          // 在途断连 "Connection closed"）都发生在发包之后——超时仅代表响应未在
          // 5s 内返回、命令很可能已执行（RCON 协议"响应超时≠命令未执行"），
          // 回退 stdin 重发会让 give/kick/tp/ban 等非幂等命令重复生效
          // → 直接向调用方抛错，保持 RCON 队列语义
          if (!(err && err.rconConfirmedNotSent)) throw err;
          console.warn(`[Instance ${this.id}] RCON send failed, fallback to stdin:`, err.message);
          this._writeToStdin(command + '\n');
          return null;
        }
      }
      this._writeToStdin(command + '\n');
      return null;
    } finally {
      // 命令历史落库（异步写不阻塞命令返回；写入失败仅 warn 不影响主流程）
      try {
        CommandHistoryModel.create({
          instanceId: this.id,
          command,
          source: 'api',
          success: cmdSuccess,
          response: cmdResponse,
          durationMs: Date.now() - cmdStartTime,
        });
      } catch (e) {
        console.warn(`[Instance ${this.id}] Failed to persist command history:`, e.message);
      }
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

  _parseOutput(text) {
    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
      const responseMatch = line.match(/\[mcsmp_response:(\d+)\]/);
      if (responseMatch) {
        const commandId = parseInt(responseMatch[1]);
        const promiseInfo = this._commandResponsePromises.get(commandId);
        if (promiseInfo) {
          promiseInfo.buffer.push(line.replace(/\[mcsmp_response:\d+\]\s*/, ''));
        }
        continue;
      }

      const responseEndMatch = line.match(/\[mcsmp_end:(\d+)\]/);
      if (responseEndMatch) {
        const commandId = parseInt(responseEndMatch[1]);
        const promiseInfo = this._commandResponsePromises.get(commandId);
        if (promiseInfo) {
          promiseInfo.resolve(promiseInfo.buffer.join('\n'));
        }
        continue;
      }

      const tpsMatch = line.match(/(\d+\.\d+) TPS/);
      if (tpsMatch) {
        this.tps = parseFloat(tpsMatch[1]);
      }

      // MSPT 解析：从 tick query 或 tps 命令输出中提取
      const msptMatch = line.match(/MSPT\s*(?:mean|max|min)?[\s:=]*(\d+\.\d+)/i);
      if (msptMatch) {
        this._mspt = parseFloat(msptMatch[1]);
      }
      // 备用格式: "5.0 ms per tick" 或 "tick time: 5.0ms"
      const msptFallback = line.match(/(\d+\.?\d*)\s*ms\s*per\s*tick/i) ||
                           line.match(/tick\s*time[\s:]+(\d+\.?\d*)\s*ms/i);
      if (msptFallback) {
        this._mspt = parseFloat(msptFallback[1]);
      }

      const joinMatch = line.match(/([^\s\]<>[]+) joined the game/);
      if (joinMatch) {
        const playerIp = this._pendingIps.get(joinMatch[1]) || '';
        this._pendingIps.delete(joinMatch[1]);
        // 从持久化文件加载已有总游戏时长与会话历史
        const savedData = this._loadPlayerData(joinMatch[1]) || {};
        const savedPlayTime = savedData.totalPlayTime || 0;
        const sessions = Array.isArray(savedData.sessions) ? savedData.sessions : [];
        // 若最后一个会话未结束（服务端异常退出），补一个零时长会话，保证会话完整
        const lastSession = sessions[sessions.length - 1];
        if (lastSession && lastSession.end == null) {
          lastSession.end = lastSession.start;
          lastSession.duration = 0;
        }
        // 开启新会话（会话历史用于日志 Tab 的树状时间线）
        sessions.push({ start: Date.now(), end: null, duration: 0 });
        // 限制会话历史数量（保留最近 20 段，避免无限增长）
        if (sessions.length > 20) sessions.splice(0, sessions.length - 20);
        const player = {
          name: joinMatch[1],
          joinTime: Date.now(),
          ip: playerIp,
          totalPlayTime: savedPlayTime,
          sessions,
        };
        // 今日新增计数：savedData 无任何历史（时长/会话/事件全空）= 首次加入
        const isFirstJoin = !savedData.totalPlayTime && !savedData.sessions?.length && !savedData.events?.length;
        if (isFirstJoin) {
          const key = this._todayKey();
          if (!this._todayNewCache || this._todayNewCache.date !== key) {
            this._todayNewCache = { date: key, count: 0 };
          }
          this._todayNewCache.count++;
        }
        this.players.set(joinMatch[1], player);
        this._addPlayerEvent(joinMatch[1], 'join', '进入服务器');
        this.emit('playerJoin', player);
      }

      // 解析玩家 IP（登录日志行包含 IP 地址，可能在 join 前到达）
      const loginIpMatch = line.match(/([^\s\]<>[]+)\[\/?([\d.]+):\d+\] logged in with entity id/);
      if (loginIpMatch) {
        // 如果玩家已存在，直接设 IP；否则缓存等待 join
        const existing = this.players.get(loginIpMatch[1]);
        if (existing) {
          existing.ip = loginIpMatch[2];
        } else {
          this._pendingIps.set(loginIpMatch[1], loginIpMatch[2]);
        }
      }

      const leaveMatch = line.match(/([^\s\]<>[]+) left the game/);
      if (leaveMatch) {
        this._handlePlayerLeave(leaveMatch[1]);
      }

      // 被动离开（踢出/封禁/IP 封禁/断开连接）：服务器日志输出 "lost connection" 或 "was kicked"，
      // 不输出 "left the game"，也应视为"离开服务器"事件。仅在玩家仍在线时处理，避免重复记录。
      const passiveLeaveMatch =
        line.match(/([^\s\]<>[]+) lost connection: /) ||
        line.match(/([^\s\]<>[]+) was kicked /);
      if (passiveLeaveMatch) {
        this._handlePlayerLeave(passiveLeaveMatch[1]);
      }

      // 死亡事件 — 使用更精确的正则避免误匹配
      // MC 26.2 日志格式: "Player was slain by Zombie" / "Player fell from a high place"
      const deathMatch = line.match(/([^\s\]<>[]+) (was slain by|was killed by|was shot by|was fireballed by|was blown up by|was stung by|was pummeled by|was squashed by|was impaled on|fell from a high place|fell off|drowned|blew up|hit the ground too hard|tried to swim in lava|went up in flames|burned to death|was pricked to death|was doomed to fall|was shot off|starved to death|suffocated in a wall|withered away|froze to death|died|was lost|disconnected|experienced kinetic energy)(?:\s+(.+))?/);
      if (deathMatch) {
        const playerName = deathMatch[1];
        const cause = deathMatch[2];
        const killer = deathMatch[3] || '';
        // 简中播报文案映射表
        const deathCauseZh = {
          'was slain by': '被击杀',
          'was killed by': '被杀死',
          'was shot by': '被射杀',
          'was fireballed by': '被火球击中',
          'was blown up by': '被炸死',
          'was stung by': '被蛰死',
          'was pummeled by': '被锤死',
          'was squashed by': '被砸死',
          'was impaled on': '被刺穿',
          'fell from a high place': '从高处摔落',
          'fell off': '从高处掉落',
          'drowned': '溺水身亡',
          'blew up': '被炸飞',
          'hit the ground too hard': '重重地摔在地上',
          'tried to swim in lava': '试图在岩浆中游泳',
          'went up in flames': '被烧成灰烬',
          'burned to death': '被烧死',
          'was pricked to death': '被刺死',
          'was doomed to fall': '注定要摔死',
          'was shot off': '被射下',
          'starved to death': '饿死了',
          'suffocated in a wall': '在墙里窒息',
          'withered away': '凋零而死',
          'froze to death': '冻死了',
          'died': '死了',
          'was lost': '迷失了',
          'disconnected': '断开了连接',
          'experienced kinetic energy': '经历了动能',
        };
        const causeZh = deathCauseZh[cause] || cause;
        const message = killer ? `${causeZh}（by ${killer}）` : causeZh;
        this._addPlayerEvent(playerName, 'death', message);
        // 走聚合通道：团灭等批量场景 5s 窗口合并，多条玩家死亡只广播一条
        this._emitDeathAggregated(playerName, message, killer);
      }

      const achievementMatch = line.match(/([^\s\]<>[]+) has made the advancement \[(.+)\]/);
      if (achievementMatch) {
        this._addPlayerEvent(achievementMatch[1], 'achievement', `获得成就: ${achievementMatch[2]}`);
        this.emit('achievement', { name: achievementMatch[1], advancement: achievementMatch[2] });
      }

      const challengeMatch = line.match(/([^\s\]<>[]+) has completed the challenge \[(.+)\]/);
      if (challengeMatch) {
        this._addPlayerEvent(challengeMatch[1], 'achievement', `完成挑战: ${challengeMatch[2]}`);
        this.emit('achievement', { name: challengeMatch[1], advancement: challengeMatch[2], isChallenge: true });
      }

      const respawnMatch = line.match(/([^\s\]<>[]+) respawned/);
      if (respawnMatch) {
        this._addPlayerEvent(respawnMatch[1], 'respawn', '已重生');
        // 广播复活事件给 WebSocket 客户端
        this.emit('playerRespawn', { name: respawnMatch[1] });
      }

      // ── 聊天事件解析 ──
      // MC 日志格式: "<Player> message"
      const chatMatch = line.match(/^<([^\s\]<>[]+)>\s+(.+)/);
      if (chatMatch) {
        this.emit('playerChat', { name: chatMatch[1], message: chatMatch[2] });
      }

      // ── 存档事件日志解析 ──
      // "Saving" 是存档开始，"Saved the game" 是存档完成，仅在完成时记录真实时刻
      if (line.includes('Saved the game')) {
        this._lastSaveTime = new Date().toISOString();
        this.emit('status', { event: 'save' });
      }

      // ── 时间变化日志解析 ──
      // 旧版 MC 日志格式: "Set the time to 1000" (玩家/控制台执行 /time set 时输出)
      // MC 26.1+ 日志格式: "Set the time to 1000" 仍可能输出，但 Time Marker 设置可能无数字
      // 兜底匹配：解析包含 "Set the time to <number>" 的日志行
      const timeLogMatch = line.match(/Set the time to (\d+)/i);
      if (timeLogMatch) {
        this._worldTime = parseInt(timeLogMatch[1], 10) % 24000;
        this._emitPerformance();
      }

      if (line.includes('Done') && line.includes('For help, type')) {
        this.emit('status', { event: 'ready' });
      }

      // ── 天气变化日志解析 ──
      // MC 日志格式: "Changing to clear/rainy/thundering weather" 或 "Set the weather to clear/rain/thunder"
      // 注意：仅命令触发的天气变化会输出日志；自然天气变化无日志，依赖 _collectWorldState 轮询 level.dat
      if (line.match(/Changing to (clear|rainy|thundering) weather/i) || line.match(/Set the weather to (clear|rain|thunder)/i)) {
        const lower = line.toLowerCase();
        if (lower.includes('thunder')) {
          this._weather = 'thunder';
        } else if (lower.includes('rain')) {
          this._weather = 'rain';
        } else {
          this._weather = 'clear';
        }
        this.emit('weatherUpdate', { weather: this._weather });
      }

      // ── 玩家睡觉日志解析 ──
      // 注意：Vanilla MC 不输出 "has gone to sleep" 日志，入睡计数依赖 RCON 轮询
      // _collectPlayerStats 每 5 秒查询 SleepTimer 并更新 _sleepingPlayers，此处不再累加
      // Paper 服务器: "Player has gone to sleep" / Vanilla: 无直接日志
      // 睡觉跳过夜晚时天气会恢复晴天（已被上面的天气解析覆盖）

      // ── 玩家离开时减少入睡计数 ──
      // (在 leaveMatch 处理块中已处理)
    }
  }

  /// 处理玩家离开：保存数据、累计在线时长、关闭会话、记录"离开服务器"事件、移除在线表并广播。
  /// 主动离开（left the game）与被动离开（踢出/封禁/断开连接/服务器关闭）共用；
  /// 玩家不在在线表时直接返回，避免重复记录。
  _handlePlayerLeave(playerName) {
    const player = this.players.get(playerName);
    if (!player) return;
    player.lastSeen = Date.now();
    const now = Date.now();
    const sessionSeconds = player.joinTime ? Math.floor((now - player.joinTime) / 1000) : 0;
    if (sessionSeconds > 0) {
      player.totalPlayTime = (player.totalPlayTime || 0) + sessionSeconds;
    }
    // 关闭当前会话（记录结束时间与时长）
    if (Array.isArray(player.sessions) && player.sessions.length > 0) {
      const cur = player.sessions[player.sessions.length - 1];
      if (cur && cur.end == null) {
        cur.end = now;
        cur.duration = sessionSeconds;
      }
    }
    // 必须先记 leave 事件再落盘：_savePlayerData 序列化的是内存 playerEvents，
    // 若先保存，磁盘上永远缺 leave 事件；随后该玩家被移出在线表，
    // 60s 定时保存不会再为其补写，进程退出后 leave 事件将永久丢失。
    this._addPlayerEvent(playerName, 'leave', '离开服务器');
    this._savePlayerData(playerName, player);
    // 减少入睡计数（玩家离开时自动起床）
    if (this._sleepingPlayers > 0) {
      this._sleepingPlayers = Math.max(0, this._sleepingPlayers - 1);
    }
    this.players.delete(playerName);
    this.emit('playerLeave', { name: playerName });
  }

  _addPlayerEvent(playerName, type, message) {
    if (!this.playerEvents.has(playerName)) {
      this.playerEvents.set(playerName, []);
    }
    const events = this.playerEvents.get(playerName);
    events.unshift({
      type,
      message,
      timestamp: Date.now(),
    });
    if (events.length > 50) {
      events.pop();
    }
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

[showing lines 1-2000 of 3276; use offset=2001 with limit to continue reading]