import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { error, ErrorCodes } from '../utils/response.js';
import { InstanceModel, BackupModel } from '../db/index.js';
import config from '../config.js';
import { atomicWriteFile } from '../services/mc_server.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import {
  commandResponseSchema,
  instanceStatusListSchema,
  instanceStatusSchema,
  logEntriesSchema,
  nullDataSchema,
  overviewDataSchema,
  serverPropertiesSchema,
  systemStatsSchema,
  updatePropertiesResponseSchema,
  worldInfoSchema,
} from '@mc-commander/schemas';
import { validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { getServerVersion } from '../utils/version.js';

// ── 磁盘使用率（feat-5 运维韧性）：fs.statfsSync 零新增依赖，10s 缓存 ──
let _diskCache = { ts: 0, result: null };
function getDiskUsage() {
  const now = Date.now();
  if (_diskCache.result && now - _diskCache.ts < 10_000) return _diskCache.result;
  // 去重：serversDir / dataDir / backupsDir 所在分区
  const dirs = [config.serversDir, config.dataDir, config.backupsDir];
  const seen = new Map(); // mountpoint → DiskInfo
  for (const dir of dirs) {
    try {
      const stat = fs.statfsSync(dir);
      const total = stat.bsize * stat.blocks;
      const free = stat.bsize * stat.bfree;
      const used = total - free;
      const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
      const entry = {
        mountpoint: stat.mounted || dir,
        totalGB: Math.round(total / (1024 * 1024 * 1024) * 10) / 10,
        usedGB: Math.round(used / (1024 * 1024 * 1024) * 10) / 10,
        percent,
      };
      if (!seen.has(entry.mountpoint) || entry.percent > seen.get(entry.mountpoint).percent) {
        seen.set(entry.mountpoint, entry);
      }
    } catch {
      // 路径不存在时静默跳过
    }
  }
  const all = Array.from(seen.values());
  // 主分区 = 使用率最高
  const primary = all.sort((a, b) => b.percent - a.percent)[0] || null;
  const result = { primary, all };
  _diskCache = { ts: now, result };
  return result;
}

// 同步实例目录下的 instance.json，保持其与 DB/内存中的最新配置一致。
// instance.json 在创建实例时写入一次，用于 DB 记录丢失时的迁移兜底；
// 若不同步更新，兜底恢复出的配置将过期（不含 startCommand、内存为旧值）。
function _syncInstanceJson(instance) {
  try {
    const configPath = path.join(instance.serverPath, 'instance.json');
    if (!fs.existsSync(configPath)) return;
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const updated = {
      ...existing,
      name: instance.name ?? existing.name,
      jarFile: instance.jarFile ?? existing.jarFile,
      maxMemory: instance.maxMemory ?? existing.maxMemory,
      minMemory: instance.minMemory ?? existing.minMemory,
      javaPath: instance.javaPath ?? existing.javaPath,
      startCommand: instance.startCommand ?? null,
      jvmArgs: instance.jvmArgs ?? null,
    };
    // 原子写（tmp + rename）：直接 writeFileSync 覆盖（默认 flag 'w' 先 truncate 后写）
    // 在进程中途崩溃/断电时残留半写 JSON，下次启动 loadInstances 的 JSON.parse
    // 抛 SyntaxError → 迁移兜底跳过该目录；DB 记录也已丢失时实例永久无法恢复。
    // 复用 services/mc_server.js atomicWriteFile 正例，崩溃只影响 .tmp 中间文件。
    atomicWriteFile(configPath, JSON.stringify(updated, null, 2));
  } catch (e) {
    logger.warn('Failed to sync instance.json:', e.message);
  }
}

// 计算云服务器系统级 CPU 使用率（Linux: /proc/stat；其他平台回退到 os.loadavg）
// 返回 0-100 的百分比。维护上一次的采样状态以做差分。
let _lastCpuSample = null;
function getSystemCpuUsage() {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync('/proc/stat', 'utf-8');
      const cpuLine = stat.match(/^cpu\s+([\d\s]+)$/m);
      if (cpuLine) {
        const parts = cpuLine[1].trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
        // user, nice, system, idle, iowait, irq, softirq, steal, ...
        const idle = parts[3] || 0;
        const iowait = parts[4] || 0;
        const total = parts.reduce((a, b) => a + b, 0);
        const now = Date.now();
        if (_lastCpuSample) {
          const totalDiff = total - _lastCpuSample.total;
          const idleDiff = (idle + iowait) - (_lastCpuSample.idle + _lastCpuSample.iowait);
          if (totalDiff > 0) {
            const usage = Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
            _lastCpuSample = { total, idle, iowait, time: now };
            return Math.round(usage * 10) / 10;
          }
        }
        _lastCpuSample = { total, idle, iowait, time: now };
        return 0;
      }
    }
    // 非 Linux：用 1 分钟 loadavg / 核心数 近似估算（粗略）
    const cores = os.cpus().length || 1;
    const load = os.loadavg()[0] || 0;
    return Math.min(100, Math.round((load / cores) * 100 * 10) / 10);
  } catch {
    return 0;
  }
}

export function createStatusRoutes(serverManager) {
  const router = express.Router();

  // find-002：校验 javaPath 是否为已存在的 java/javaw 可执行文件。
  // 启动器路径会被 start() spawn 执行，若允许指向 bash/python/sh 等任意
  // 可执行文件即远程代码执行入口。null/'' 视为清除配置（回退服务端默认 java）。
  function isValidJavaExecutable(javaPath) {
    if (javaPath === null || javaPath === '') return true;
    if (typeof javaPath !== 'string') return false;
    const resolved = path.resolve(javaPath);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return false; // 路径不存在
    }
    if (!stat.isFile()) return false;
    // 文件名特征：java/javaw（含 Windows .exe 后缀），其余一律拒绝
    const base = path.basename(resolved).toLowerCase().replace(/\.exe$/, '');
    return base === 'java' || base === 'javaw';
  }

  // GET /api/overview - 面板概览（含云服务器系统级 CPU/内存，无需 MC 实例运行）
  router.get('/overview', (req, res) => {
    const instances = serverManager.getAllInstances();
    const totalPlayers = instances.reduce((sum, i) => sum + i.playerCount, 0);

    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = totalMemBytes - freeMemBytes;
    const totalMemGB = Math.round(totalMemBytes / (1024 * 1024 * 1024) * 10) / 10;
    const usedMemGB = Math.round(usedMemBytes / (1024 * 1024 * 1024) * 10) / 10;
    const memUsagePercent = totalMemBytes > 0
      ? Math.round((usedMemBytes / totalMemBytes) * 1000) / 10
      : 0;
    const cpuUsagePercent = getSystemCpuUsage();

    res.json(validatedSuccess(overviewDataSchema, {
      version: getServerVersion(),
      instanceCount: instances.length,
      runningCount: instances.filter(i => i.isRunning).length,
      totalPlayers,
      // 云服务器系统级资源占用（无需 MC 实例运行即可获取）
      systemCpuUsage: cpuUsagePercent,
      systemMemoryUsage: usedMemGB,
      systemMemoryTotal: totalMemGB,
      systemMemoryPercent: memUsagePercent,
      // 兼容旧字段
      totalMemory: totalMemGB,
      freeMemory: Math.round(freeMemBytes / (1024 * 1024 * 1024) * 10) / 10,
      // 磁盘使用率（feat-5）
      diskUsage: getDiskUsage(),
      instances: instances.map(i => ({
        id: i.id,
        name: i.name,
        isRunning: i.isRunning,
        playerCount: i.playerCount
      }))
    }));
  });

  // GET /api/system-stats - 云服务器系统级资源占用（独立端点，供仪表盘轮询）
  router.get('/system-stats', (req, res) => {
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = totalMemBytes - freeMemBytes;
    const totalMemGB = Math.round(totalMemBytes / (1024 * 1024 * 1024) * 10) / 10;
    const usedMemGB = Math.round(usedMemBytes / (1024 * 1024 * 1024) * 10) / 10;
    const memUsagePercent = totalMemBytes > 0
      ? Math.round((usedMemBytes / totalMemBytes) * 1000) / 10
      : 0;
    const cpuUsagePercent = getSystemCpuUsage();

    res.json(validatedSuccess(systemStatsSchema, {
      cpuUsage: cpuUsagePercent,
      memoryUsage: usedMemGB,
      totalMemory: totalMemGB,
      memoryPercent: memUsagePercent,
      // CPU 核心数与负载均值（供参考）
      cpuCores: os.cpus().length,
      loadAvg: os.loadavg(),
      uptime: os.uptime(),
      // 磁盘使用率（feat-5）
      diskUsage: getDiskUsage(),
    }));
  });

  // GET /api/instances - 实例列表
  router.get('/instances', (req, res) => {
    const instances = serverManager.getAllInstances();
    res.json(validatedSuccess(instanceStatusListSchema, instances));
  });

  // GET /api/instances/:id - 单个实例详情
  router.get('/instances/:id', (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    res.json(validatedSuccess(instanceStatusSchema, instance.toStatus()));
  });

  // PUT /api/instances/:id - 更新实例配置（启动命令/JVM 参数等）
  // 同步更新数据库持久化记录与内存中运行实例的字段，下次 start() 生效
  router.put('/instances/:id', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    const body = req.body || {};
    const updates = {};
    // startCommand 自由字符串会经 start() 拼接 spawn 执行，属
    // 远程代码执行入口，已从可写字段中移除（结构化启动参数由实例级 jvmArgs
    // 承载，见下）。客户端仍提交该字段时：显式传入 null 视为清除遗留旧命令
    //（旧实例迁移到结构化参数的途径），其他值一律 400 拒绝，避免"以为已
    // 修改"的误导。旧实例 instance.json 中的 startCommand 字段仍兼容读取
    //（服务层负责），此处仅封堵 API 写入侧。
    if ('startCommand' in body) {
      if (body.startCommand === null) {
        // 允许清除：仅当实例当前确实有遗留 startCommand 时才需要更新
        if (instance.startCommand) {
          updates.startCommand = null;
          instance.startCommand = null;
        }
      } else {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'startCommand 已不再支持通过 API 更新（如需清除旧配置请传 null）'));
      }
    }
    // javaPath 必须是已存在的 java/javaw 可执行文件路径，
    // 拒绝 bash/python/sh 等任意可执行文件（RCE 入口）
    if (body.javaPath !== undefined && !isValidJavaExecutable(body.javaPath)) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'javaPath 必须是已存在的 java/javaw 可执行文件路径'));
    }
    // find-002：jvmArgs 结构化启动参数——仅允许字符串数组，每项为
    // -X/-D 前缀参数、-jar 或 nogui；-jar 后路径必须位于实例目录内。
    // 与服务层 _validateJvmArgs 同规则（路由层先做类型/形态校验，
    // 服务层 start() 兜底终检），任一非法整体 400 拒绝（原子性不落盘）
    if (body.jvmArgs !== undefined) {
      const jvmArgs = body.jvmArgs;
      if (!Array.isArray(jvmArgs) || jvmArgs.some((a) => typeof a !== 'string')) {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'jvmArgs 必须是字符串数组（每行一个参数，如 -Xmx4G）'));
      }
      const serverRoot = path.resolve(instance.serverPath);
      for (let i = 0; i < jvmArgs.length; i++) {
        const arg = jvmArgs[i];
        const validShape = arg.startsWith('-X') || arg.startsWith('-D') || arg === 'nogui';
        if (arg === '-jar') {
          const jarArg = jvmArgs[i + 1];
          if (typeof jarArg !== 'string') {
            return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'jvmArgs 中 -jar 后必须跟 JAR 路径'));
          }
          const jarResolved = path.resolve(serverRoot, jarArg);
          if (jarResolved !== serverRoot && !jarResolved.startsWith(serverRoot + path.sep)) {
            return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'jvmArgs 中 -jar 路径必须位于实例目录内'));
          }
          i++; // 消费路径参数
        } else if (!validShape) {
          return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, `不支持的启动参数: ${arg}（仅允许 -X/-D 前缀、-jar 与 nogui）`));
        }
      }
      updates.jvmArgs = jvmArgs;
    }
    // 允许更新的字段（驼峰命名，与 InstanceModel.FIELD_TO_COLUMN 对应）
    const allowedFields = ['javaPath', 'maxMemory', 'minMemory', 'name', 'description', 'jarFile', 'autoRestart', 'autoStart'];
    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updates[key] = body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, '没有可更新的字段'));
    }

    // 1. 持久化到数据库
    InstanceModel.update(req.params.id, updates);

    // 2. 同步更新内存中运行实例的字段（下次 start() 生效）
    if (updates.javaPath !== undefined) instance.javaPath = updates.javaPath;
    if (updates.maxMemory !== undefined) instance.maxMemory = updates.maxMemory;
    if (updates.minMemory !== undefined) instance.minMemory = updates.minMemory;
    if (updates.name !== undefined) instance.name = updates.name;
    if (updates.jarFile !== undefined) instance.jarFile = updates.jarFile;
    if (updates.autoRestart !== undefined) instance.autoRestart = Boolean(updates.autoRestart);
    if (updates.autoStart !== undefined) instance.autoStart = Boolean(updates.autoStart);
    if (updates.jvmArgs !== undefined) instance.jvmArgs = updates.jvmArgs;
    // 重新开启 autoRestart 时重置熔断器（用户已确认手动介入）
    if (updates.autoRestart === true && instance._circuitBreakerTripped) {
      instance._consecutiveCrashes = 0;
      instance._crashWindowStart = null;
      instance._circuitBreakerTripped = false;
    }

    // 3. 同步 instance.json 保持最新（含 startCommand/jvmArgs），供 DB 丢失时兜底恢复
    _syncInstanceJson(instance);

    // 审计新增 INSTANCE_UPDATE 枚举（命名对齐 INSTANCE_* 生命周期组）：本端点是实例核心
    // 配置（内存/JVM/javaPath/自启自恢复开关）的唯一写入口，与 properties 外围属性更新
    //（CONFIG_CHANGE）分属不同资源层级，复用会让同一动作跨语义；detail.fields 记录本次
    // 实际生效的字段集合（含 startCommand 显式清除），供回查「谁改了内存/谁关了自恢复」。
    // 400 路径（无可更新字段/校验拒绝）不记审计——审计语义 = 实际生效的变更。
    recordAudit({ instanceId: req.params.id, action: AuditActions.INSTANCE_UPDATE, targetType: 'instance', targetId: req.params.id, detail: { fields: Object.keys(updates) } });
    res.json(validatedSuccess(instanceStatusSchema, instance.toStatus(), 'Instance updated'));
  }));

  // POST /api/instances/:id/start
  router.post('/instances/:id/start', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    // find-002：拒绝通过请求体传入任意启动命令字符串（远程代码执行入口）。
    // 启动方式仅由实例配置的 javaPath/jarFile/jvmArgs（服务层）控制。
    if (req.body && typeof req.body === 'object' && 'startCommand' in req.body) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'startCommand 已不再支持通过 API 传入'));
    }

    // EULA 检查：首次启动需要用户同意 EULA 协议
    const eulaPath = path.join(instance.serverPath, 'eula.txt');
    let eulaAccepted = false;
    if (fs.existsSync(eulaPath)) {
      const eulaContent = fs.readFileSync(eulaPath, 'utf-8');
      eulaAccepted = /^eula\s*=\s*true\s*$/im.test(eulaContent);
    }
    if (!eulaAccepted) {
      return res.status(403).json(error(ErrorCodes.VALIDATION_ERROR, 'EULA_NOT_ACCEPTED'));
    }

    instance.start();
    try { InstanceModel.update(req.params.id, { status: 'running' }); } catch (e) { logger.warn('Failed to sync instance status to DB:', e.message); }
    recordAudit({ instanceId: req.params.id, action: AuditActions.INSTANCE_START, targetType: 'instance', targetId: req.params.id });
    res.json(validatedSuccess(nullDataSchema, null, 'Server starting'));
  }));

  // POST /api/instances/:id/stop
  router.post('/instances/:id/stop', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    instance.stop();
    try { InstanceModel.update(req.params.id, { status: 'stopped' }); } catch (e) { logger.warn('Failed to sync instance status to DB:', e.message); }
    recordAudit({ instanceId: req.params.id, action: AuditActions.INSTANCE_STOP, targetType: 'instance', targetId: req.params.id });
    res.json(validatedSuccess(nullDataSchema, null, 'Server stopping'));
  }));

  // POST /api/instances/:id/restart
  router.post('/instances/:id/restart', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    // 统一走 instance.restart()：内部处理停止命令 + 可取消的延迟启动
    instance.restart();
    recordAudit({ instanceId: req.params.id, action: AuditActions.INSTANCE_RESTART, targetType: 'instance', targetId: req.params.id });
    res.json(validatedSuccess(nullDataSchema, null, 'Server restarting'));
  }));

  // POST /api/instances/:id/command
  router.post('/instances/:id/command', asyncHandler(async (req, res) => {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'Command is required'));
    }

    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    // 实例未运行：sendCommand 抛裸 Error 会变 500，此处显式返回语义化错误
    if (!instance.isRunning) {
      return res.status(400).json(error(ErrorCodes.INSTANCE_NOT_RUNNING));
    }

    try {
      const response = await instance.sendCommand(command);
      res.json(validatedSuccess(commandResponseSchema, response, 'Command sent'));
    } catch (err) {
      // RCON 连接断开/超时：返回专用错误码，前端可区分引导用户启用 RCON
      if (!instance.isRconConnected) {
        return res.status(503).json(error(ErrorCodes.RCON_UNAVAILABLE));
      }
      throw err;
    }
  }));

  // GET /api/instances/:id/logs
  router.get('/instances/:id/logs', (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    let lines = parseInt(req.query.lines, 10) || 100;
    lines = Math.max(1, Math.min(lines, 1000));
    res.json(validatedSuccess(logEntriesSchema, instance.getLogs(lines)));
  });

  // GET /api/instances/:id/properties - 获取 server.properties
  router.get('/instances/:id/properties', async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    // 每次重新读取文件而非直接返回内存缓存：游戏内命令（如 /whitelist on）
    // 会写回 server.properties，内存缓存不会自动更新，重读文件才能同步。
    try {
      const fresh = instance._loadProperties();
      if (fresh && Object.keys(fresh).length > 0) {
        instance.properties = fresh;
      }
    } catch {}
    const props = { ...instance.properties };

    // 运行状态型属性：游戏内 /difficulty、/defaultgamemode 只改 level.dat，
    // 不写回 server.properties，读取运行中真实值覆盖，否则客户端读到旧值（多端同步）。
    // difficulty 优先 RCON 实时查询、level.dat 兜底；gamemode 读 level.dat。
    // readDifficulty 服务层已捕获 RCON/level.dat 预期失败并回退文件值，此处再兜底
    // 意外异常：难度缺失不影响 properties 主体响应（Express 4 下未捕获 rejection
    // 会挂起请求并可能终止进程，见上方 asyncHandler 注释）。
    try {
      const difficulty = await instance.readDifficulty();
      if (difficulty) props['difficulty'] = difficulty;
    } catch {}
    const gameMode = instance._readGameTypeFromLevelDat();
    if (gameMode) props['gamemode'] = gameMode;

    // find-015：敏感属性（rcon.password 等）以占位符掩码返回，防止密码与
    // 网络配置泄露给 API 调用方；客户端原样回传占位符时 PUT 视为未修改。
    for (const key of Object.keys(props)) {
      if (SENSITIVE_PROPERTIES.has(key)) {
        props[key] = SENSITIVE_PLACEHOLDER;
      }
    }

    res.json(validatedSuccess(serverPropertiesSchema, props));
  });

  // 支持运行中通过斜杠命令修改的 server.properties 属性 → 命令构造。
  // MC 服务器运行时不重新加载 server.properties 文件（启动时读取），
  // 仅以下属性可通过命令运行中生效；其余属性（pvp、max-players、online-mode 等）
  // 修改后需重启服务器。
  const RUNTIME_COMMAND_MAP = {
    'white-list': (v) =>
      String(v).toLowerCase() === 'true' ? 'whitelist on' : 'whitelist off',
    'enforce-whitelist': (v) =>
      String(v).toLowerCase() === 'true'
        ? 'whitelist enforce on'
        : 'whitelist enforce off',
    'difficulty': (v) => `difficulty ${v}`,
    'gamemode': (v) => `defaultgamemode ${v}`,
  };

  // ── find-018 / find-015：PUT /properties 键白名单与值校验 ──
  // 普通可写属性键白名单（前端世界属性页暴露 + MC 26.x 常用键，保持新旧版本
  // 兼容的宽松策略：对已知属性尽量放行，未知键才拒绝）。
  const WRITABLE_PROPERTIES = new Set([
    // 世界
    'level-name', 'level-type', 'level-seed', 'generator-settings',
    'difficulty', 'gamemode', 'force-gamemode', 'hardcore', 'pvp',
    'allow-flight', 'allow-nether', 'spawn-monsters', 'spawn-npcs',
    'spawn-animals', 'spawn-protection', 'max-world-size', 'generate-structures',
    // 玩家/性能
    'max-players', 'view-distance', 'simulation-distance',
    'player-idle-timeout', 'max-tick-time', 'network-compression-threshold',
    'rate-limit', 'entity-broadcast-range-percentage', 'function-permission-level',
    'op-permission-level', 'sync-chunk-writes', 'use-native-transport',
    'enable-jmx-monitoring',
    // 展示/交互
    'motd', 'hide-online-players', 'enforce-secure-profile',
    'prevent-proxy-connections', 'log-ips', 'broadcast-console-to-ops',
    'broadcast-rcon-to-ops', 'snooper-enabled',
    // 资源包/内容过滤
    'require-resource-pack', 'resource-pack', 'resource-pack-sha1',
    'resource-pack-prompt', 'initial-enabled-packs', 'initial-disabled-packs',
    'text-filtering-config',
  ]);

  // 布尔型属性：仅接受 true/false
  const BOOLEAN_PROPERTIES = new Set([
    'white-list', 'enforce-whitelist', 'force-gamemode', 'hardcore', 'pvp',
    'allow-flight', 'allow-nether', 'spawn-monsters', 'spawn-npcs',
    'spawn-animals', 'generate-structures', 'hide-online-players',
    'enforce-secure-profile', 'prevent-proxy-connections', 'log-ips',
    'sync-chunk-writes', 'use-native-transport', 'broadcast-console-to-ops',
    'broadcast-rcon-to-ops', 'snooper-enabled', 'enable-jmx-monitoring',
    'require-resource-pack',
  ]);

  // 数值型属性：仅接受整数（max-tick-time / network-compression-threshold
  // 允许 -1 表示禁用/不限制）
  const NUMERIC_PROPERTIES = new Set([
    'max-players', 'view-distance', 'simulation-distance',
    'player-idle-timeout', 'max-tick-time', 'network-compression-threshold',
    'rate-limit', 'entity-broadcast-range-percentage', 'function-permission-level',
    'op-permission-level', 'spawn-protection', 'max-world-size',
  ]);

  // 敏感属性禁止 API 写入：enable-rcon/rcon.password/rcon.port 为 RCON
  // 远程控制通道，enable-query/enable-status 暴露服务器信息，enable-command-block
  // 绕过命令权限分级，online-mode 为正版验证，server-port/server-ip 控制
  // 网络暴露面。GET 时以占位符掩码返回，PUT 提交占位符视为未修改
  // （沿用磁盘现值），提交其余值一律 400 拒绝。
  const SENSITIVE_PROPERTIES = new Set([
    'enable-rcon', 'rcon.password', 'rcon.port',
    'enable-query', 'enable-status', 'enable-command-block',
    'online-mode', 'server-port', 'server-ip',
  ]);
  const SENSITIVE_PLACEHOLDER = '********';

  // 可写键 = 普通可写键 + 运行期命令键（并集，保证 RUNTIME_COMMAND_MAP
  // 四键即使未出现在普通键集中也允许写入）
  const ALLOWED_PROPERTY_KEYS = new Set([
    ...WRITABLE_PROPERTIES,
    ...Object.keys(RUNTIME_COMMAND_MAP),
  ]);

  // find-018：单键值校验。返回 { ok: true, value } 或 { ok: false, reason }
  function validatePropertyValue(key, rawValue) {
    if (rawValue === null || rawValue === undefined || typeof rawValue === 'object') {
      return { ok: false, reason: '值必须是标量' };
    }
    const value = String(rawValue);
    if (BOOLEAN_PROPERTIES.has(key)) {
      const lowered = value.toLowerCase();
      if (lowered !== 'true' && lowered !== 'false') {
        return { ok: false, reason: '布尔属性仅接受 true/false' };
      }
      return { ok: true, value };
    }
    if (NUMERIC_PROPERTIES.has(key)) {
      if (!/^-?\d+$/.test(value)) {
        return { ok: false, reason: '数值属性仅接受整数' };
      }
      return { ok: true, value };
    }
    if (key === 'level-name') {
      // 根治路径穿越入口：level-name 会拼入世界目录路径
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        return { ok: false, reason: 'level-name 仅接受字母数字、下划线与连字符' };
      }
      return { ok: true, value };
    }
    // 字符串属性拒绝真实换行（防 server.properties 行注入；
    // motd 的字面 \n 转义序列不包含真实换行，不受影响）
    if (/[\n\r]/.test(value)) {
      return { ok: false, reason: '字符串属性不允许包含换行符' };
    }
    // 运行期命令键的值会拼入下发给 MC 控制台的命令，限制字符集防命令注入
    // （white-list/enforce-whitelist 已在布尔分支处理；difficulty/gamemode 走这里）
    if (RUNTIME_COMMAND_MAP[key] && !/^[a-zA-Z0-9_:-]+$/.test(value)) {
      return { ok: false, reason: '值包含非法字符' };
    }
    return { ok: true, value };
  }

  // PUT /api/instances/:id/properties - 更新 server.properties
  router.put('/instances/:id/properties', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      logger.warn(`[PUT properties] Instance not found: ${req.params.id}`);
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    const newProps = req.body;
    logger.info(`[PUT properties] Instance=${req.params.id}, keys=${Object.keys(newProps || {}).length}, body type=${typeof newProps}`);

    if (!newProps || typeof newProps !== 'object' || Array.isArray(newProps)) {
      logger.error(`[PUT properties] Invalid body: type=${typeof newProps}, isArray=${Array.isArray(newProps)}`);
      return res.status(400).json(error(ErrorCodes.SERVER_ERROR, '请求体必须是 JSON 对象'));
    }

    if (typeof instance.saveProperties !== 'function') {
      logger.error(`[PUT properties] instance.saveProperties is not a function! Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter(n => typeof instance[n] === 'function').join(', ')}`);
      return res.status(500).json(error(ErrorCodes.SERVER_ERROR, '服务端版本过旧，请重启服务端以加载最新代码'));
    }

    // 重读磁盘并刷新缓存（与 GET /properties 同款模式）：游戏内命令（如
    // /whitelist on）或 files 路由编辑会写回 server.properties，内存缓存不会
    // 自动更新。以陈旧缓存为 diff 基线会把磁盘真实变更掩盖：漏发运行中命令、
    // 漏报 restartRequired，且 saveProperties 的写入合并基线是磁盘内容，
    // 两份不一致的快照会导致游戏内改动被静默回滚。
    try {
      const fresh = instance._loadProperties();
      if (fresh && Object.keys(fresh).length > 0) {
        instance.properties = fresh;
      }
    } catch {}
    const oldProps = { ...instance.properties };

    // find-018/find-015：键白名单 + 敏感键占位符 + 值校验。
    // 任一非法键/非法值整体 400 拒绝（原子性，不落盘部分修改）。
    const validated = {};
    const rejectedKeys = [];
    for (const [key, rawValue] of Object.entries(newProps)) {
      // 敏感键：提交占位符视为未修改（沿用磁盘现值），其余值一律拒绝写入
      if (SENSITIVE_PROPERTIES.has(key)) {
        if (rawValue === SENSITIVE_PLACEHOLDER) continue;
        rejectedKeys.push(key);
        logger.warn(`[PUT properties] 拒绝写入敏感属性: ${key}`);
        continue;
      }
      // 键白名单：仅允许世界属性页暴露的键 + 运行期命令键
      if (!ALLOWED_PROPERTY_KEYS.has(key)) {
        rejectedKeys.push(key);
        logger.warn(`[PUT properties] 拒绝未知属性键: ${key}`);
        continue;
      }
      const result = validatePropertyValue(key, rawValue);
      if (!result.ok) {
        rejectedKeys.push(key);
        logger.warn(`[PUT properties] 属性值校验失败 ${key}: ${result.reason}`);
        continue;
      }
      validated[key] = result.value;
    }
    if (rejectedKeys.length > 0) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, `存在不允许写入或校验失败的属性: ${rejectedKeys.join(', ')}`));
    }
    // 全部为占位符/空提交：无实际变更，直接返回
    if (Object.keys(validated).length === 0) {
      return res.json(validatedSuccess(updatePropertiesResponseSchema, { restartRequired: [] }, 'Properties updated'));
    }

    instance.saveProperties(validated);

    // 对比新旧属性，区分「可运行中生效（下发命令）」与「需重启服务器」
    const changedKeys = Object.keys(validated).filter(
      (k) => oldProps[k] !== validated[k],
    );
    const runtimeChanged = changedKeys.filter((k) => RUNTIME_COMMAND_MAP[k]);
    // 仅在服务器运行时才提示需重启（未运行时下次启动自然生效）
    const restartRequired = instance.isRunning
      ? changedKeys.filter((k) => !RUNTIME_COMMAND_MAP[k])
      : [];

    // 服务器运行时，对支持运行中修改的属性下发斜杠命令，保证客户端修改立即生效
    if (instance.isRunning && runtimeChanged.length > 0) {
      for (const key of runtimeChanged) {
        const cmd = RUNTIME_COMMAND_MAP[key](validated[key]);
        try {
          await instance.sendCommand(cmd);
          logger.info(`[PUT properties] 下发运行中命令: ${cmd}`);
        } catch (e) {
          logger.warn(`[PUT properties] 命令 ${cmd} 下发失败: ${e.message}`);
        }
      }
    }

    logger.info(`[PUT properties] Saved successfully, instance.properties now has ${Object.keys(instance.properties).length} keys`);
    recordAudit({ instanceId: req.params.id, action: 'CONFIG_CHANGE', targetType: 'instance', targetId: req.params.id, detail: { field: 'properties' } });
    res.json(validatedSuccess(updatePropertiesResponseSchema, { restartRequired }, restartRequired.length > 0
      ? `Properties updated, ${restartRequired.length} 项需重启服务器生效`
      : 'Properties updated'));
  }));

  // DELETE /api/instances/:id - 卸载（删除）实例
  router.delete('/instances/:id', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

      // 0. 无条件取消崩溃重启/延迟重启定时器：已崩溃实例（isRunning=false）
      //    不满足下方 stopGracefully 分支（其内部才调用 cancelRestart），卸载时
      //    定时器不取消会保持存活；若 rmSync 因 Windows 文件占用句柄抛 EPERM
      //    导致目录与 server.jar 残留，5s 定时器回调的 jar 存在性检查通过，
      //    会对已从 manager 移除的实例 start() → 孤儿服务器进程自动启动
      //    （实例已 404，无人能再停止）。运行中实例此处先取消无副作用
      //    （cancelRestart 幂等），stopGracefully 内重复取消同样安全。
      instance.cancelRestart();

      // 1. 停止运行中的实例：用 stopGracefully 等待 MC 正常退出后再删除目录
      //    （await stop 命令 → 等 exit 事件 → 超时强杀兜底），避免与仍存活的
      //    MC 进程竞争（Windows EPERM 半删除 / Linux 向已删 inode 写数据）
      if (instance.isRunning) {
        try { await instance.stopGracefully(); } catch {}
        // stopGracefully 超时强杀后进程退出是异步的，rmSync 前再等进程真正退出，
        // 避免 Windows 上 TerminateProcess 与句柄释放之间的竞态导致仍 EPERM
        const proc = instance.process;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 3000);
            proc.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        }
      }

      const instancePath = instance.serverPath;

      // 2. 先删除实例文件夹（含 instance.json）。文件删除必须前置：若先删内存/DB
      //    再 rmSync，Windows 句柄占用（杀软扫描 server.jar、资源管理器打开目录、
      //    日志文件被编辑器占用等）导致 rmSync 抛 EPERM（force:true 只吞 ENOENT
      //    不吞 EPERM）时删除已不可逆完成一半——实例已 404 客户端无法重试补偿，
      //    目录与备份残留，重启 loadInstances（mc_server.js）还会从残留的
      //    instance.json 迁移"复活"已卸载实例。文件删除失败直接抛错经 asyncHandler
      //    进入全局 errorHandler，此时内存与 DB 记录均未动 → 实例保留可重试。
      if (instancePath && fs.existsSync(instancePath)) {
        fs.rmSync(instancePath, { recursive: true, force: true });
      }

      // 3. 清理备份：快照目录按约定存放于 backupsDir/<instanceId>/（backup.service.js
      //    getInstanceBackupDir），与实例目录 serversDir/<id> 分离，需显式清理，否则
      //    磁盘残留孤儿快照；同时删除 backups 表该实例的全部 DB 记录
      //    （InstanceModel.delete 只删 instances 表，记录同样成孤儿）。不吞错：
      //    备份清理失败同样抛错保留实例，重试可补偿（重试时实例目录已删 existsSync
      //    跳过，只重试备份清理）。
      const backupDirPath = path.join(config.backupsDir, req.params.id);
      if (fs.existsSync(backupDirPath)) {
        fs.rmSync(backupDirPath, { recursive: true, force: true });
      }
      BackupModel.deleteByInstance(req.params.id);

      // 4. 文件与备份全部清理成功后才从内存中移除
      serverManager.instances.delete(req.params.id);

      // 5. 最后从数据库删除记录。DB 删除失败仅警告不阻塞（实例目录已删、
      //    实例已 404，重试不可行；DB 记录残留重启会尝试加载该实例——
      //    属 SQLite 本地写失败的极端情况，且实例目录已删 createInstance 会
      //    重建空目录，风险远小于本路由历史 bug 的不可补偿半删除）
      try { InstanceModel.delete(req.params.id); } catch (e) { logger.warn('Failed to delete instance from DB:', e.message); }
      recordAudit({ instanceId: req.params.id, action: AuditActions.INSTANCE_DELETE, targetType: 'instance', targetId: req.params.id });
      res.json(validatedSuccess(nullDataSchema, null, 'Instance deleted'));
  }));

  // POST /api/instances/:id/eula - 写入 EULA 协议确认
  router.post('/instances/:id/eula', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    const { agreed } = req.body;
    if (typeof agreed !== 'boolean') {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'agreed must be a boolean'));
    }

    const eulaPath = path.join(instance.serverPath, 'eula.txt');
    const content = agreed
      ? '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\neula=true\n'
      : '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\neula=false\n';
    fs.writeFileSync(eulaPath, content, 'utf-8');

    res.json(validatedSuccess(nullDataSchema, null, agreed ? 'EULA accepted' : 'EULA declined'));
  }));

  // GET /api/instances/:id/world - 获取世界信息
  router.get('/instances/:id/world', async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    const props = instance.properties;

    // 通过 RCON 查询游戏天数（time query gametime 返回总 tick，24000 tick = 1 天）
    // 查询失败时返回 null 而非静默 0，前端可据此展示「不可用」而非误导数据
    let gameDays = null;
    if (instance.isRunning && instance.isRconConnected) {
      try {
        const result = await instance.sendCommandWithResponse('time query gametime', { timeout: 3000 });
        // 兼容多种 MC 版本的输出格式：
        // - MC 26.x: "The game time is 324576 tick(s)"
        // - MC 26.1 早期: "Timeline minecraft:gametime is at 123456 tick(s)"
        // - 旧版: "The time is 123456"
        const gameMatch = result.match(/game time is\s+(\d+)/i);
        const timelineMatch = result.match(/at\s+(\d+)\s+tick/);
        const oldMatch = result.match(/is\s+(\d+)/);
        const match = gameMatch || timelineMatch || oldMatch;
        if (match) {
          gameDays = Math.floor(parseInt(match[1], 10) / 24000);
        }
      } catch {
        // RCON 查询失败（超时/断连/解析失败）：保持 null，不回退 0
      }
    }

    // 统计各维度在线玩家数（从缓存的玩家详情中读取维度）
    const dimCounts = { overworld: 0, nether: 0, end: 0 };
    for (const [name] of instance.players) {
      const cached = name && instance.players.get(name)?._cachedDetails;
      const dim = cached?.dimension || 'overworld';
      if (dim === 'nether') dimCounts.nether++;
      else if (dim === 'end') dimCounts.end++;
      else dimCounts.overworld++;
    }

    // 运行时难度优先；readDifficulty 意外异常时保留文件值/默认值，不影响
    // world 信息主体响应（与 properties 路由同一兜底策略）。
    let difficulty = props['difficulty'] || 'normal';
    try {
      difficulty = (await instance.readDifficulty()) || difficulty;
    } catch {}

    const worldInfo = {
      name: props['level-name'] || 'world',
      type: props['level-type'] || 'minecraft:normal',
      // server.properties 的 level-seed 在世界创建后通常为空，
      // 从 level.dat NBT 读取真实种子（兼容 1.16+ 与旧版结构）
      seed: instance._readSeedFromLevelDat() ?? props['level-seed'] ?? '',
      sizeGB: instance._getWorldSize(),
      difficulty,
      gameMode:
        instance._readGameTypeFromLevelDat() || props['gamemode'] || 'survival',
      viewDistance: parseInt(props['view-distance'] || '10', 10),
      simulationDistance: parseInt(props['simulation-distance'] || '10', 10),
      onlinePlayers: instance.players.size,
      maxPlayers: parseInt(props['max-players'] || '20', 10),
      spawnProtection: parseInt(props['spawn-protection'] || '16', 10),
      maxWorldSize: parseInt(props['max-world-size'] || '29999984', 10),
      allowFlight: props['allow-flight'] === 'true',
      hardcore: props['hardcore'] === 'true',
      pvp: props['pvp'] !== 'false',
      commandBlock: props['enable-command-block'] === 'true',
      generateStructures: props['generate-structures'] !== 'false',
      whiteList: props['white-list'] === 'true',
      onlineMode: props['online-mode'] !== 'false',
      lastSave: instance._getLastSaveTime(),
      gameDays,
      dimensions: [
        { name: '主世界', icon: '🌍', playerCount: dimCounts.overworld },
        { name: '地狱', icon: '🔥', playerCount: dimCounts.nether },
        { name: '末地', icon: '🟣', playerCount: dimCounts.end }
      ]
    };

    res.json(validatedSuccess(worldInfoSchema, worldInfo));
  });

  return router;
}
