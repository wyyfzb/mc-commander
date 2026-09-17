import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { error, ErrorCodes } from '../utils/response.js';
import { InstanceModel, BackupModel } from '../db/index.js';
import config from '../config.js';
import { atomicWriteFile, isEulaAccepted } from '../services/mc_server.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import {
  commandResponseSchema,
  instanceStatusListSchema,
  instanceStatusSchema,
  instanceCommandRequestBodySchema,
  instanceDeleteRequestBodySchema,
  instanceDeleteResponseSchema,
  instanceEulaRequestBodySchema,
  instancePropertiesRequestBodySchema,
  instanceSettingsRequestBodySchema,
  instanceStartRequestBodySchema,
  logEntriesSchema,
  nullDataSchema,
  overviewDataSchema,
  serverPropertiesSchema,
  systemStatsSchema,
  updatePropertiesResponseSchema,
  worldInfoSchema,
} from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';
import { getServerVersion } from '../utils/version.js';
import { getPropertiesView, applyPropertyUpdates } from '../services/instance-properties.service.js';
import { listInstanceSnapshotDirs } from '../services/backup-snapshot.service.js';

// 卸载响应回报的快照目录名条数上限：清单可能很长，数量永远是全量，名字只列最近的
const RETAINED_BACKUP_REPORT_LIMIT = 10;

/**
 * 只读角色视图：从同一契约源派生（只删字段、不新增），避免与全量 schema 漂移。
 * 剔除的都是「主机配置 / 凭据可能驻留处」：jvmArgs、startCommand（自由文本，运维常把
 * 口令写进 JVM 参数）、javaPath（主机目录布局）、seed（世界种子）。监控所需字段全部保留。
 *
 * 导出这两个成员是给「敏感字段 × 裁剪清单」哨兵用例（readonly-instance-redaction.test.js）
 * 用的：契约新增字段会自动流进只读视图（黑名单裁剪），哨兵断言只读视图键集合与
 * 显式清单逐一相等，新增字段不改清单就必红——必须做一次「是否敏感」的分类。
 */
export const READONLY_REDACTED_FIELDS = ['jvmArgs', 'startCommand', 'javaPath', 'seed'];
export const readonlyInstanceStatusSchema = instanceStatusSchema.omit({
  jvmArgs: true,
  startCommand: true,
  javaPath: true,
  seed: true,
});
const readonlyInstanceStatusListSchema = z.array(readonlyInstanceStatusSchema);

/**
 * 实例状态按调用者角色出参：readonly 走裁剪视图，其余（admin/公开）原样。
 * 入参是 toStatus() 的产物——getAllInstances() 返回的已是状态对象而非实例。
 * 只在这里做一次裁剪并由两条 /instances 端点共用，不在角色门里改写响应体
 * （守卫只做裁决，改响应体会让「拒了哪些」与「给了什么」混在一处，难以复核）。
 */
function statusForRole(req, status) {
  if (req.auth?.role !== 'readonly') return status;
  const redacted = { ...status };
  for (const field of READONLY_REDACTED_FIELDS) delete redacted[field];
  return redacted;
}

function statusSchemaForRole(req, list) {
  const readonly = req.auth?.role === 'readonly';
  if (list) return readonly ? readonlyInstanceStatusListSchema : instanceStatusListSchema;
  return readonly ? readonlyInstanceStatusSchema : instanceStatusSchema;
}

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

  // GET /api/instances - 实例列表（只读凭据按角色裁剪，见 statusForRole）
  router.get('/instances', (req, res) => {
    const instances = serverManager.getAllInstances();
    res.json(validatedSuccess(
      statusSchemaForRole(req, true),
      instances.map((status) => statusForRole(req, status)),
    ));
  });

  // GET /api/instances/:id - 单个实例详情（与列表同一套裁剪）
  router.get('/instances/:id', (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    res.json(validatedSuccess(statusSchemaForRole(req, false), statusForRole(req, instance.toStatus())));
  });

  // PUT /api/instances/:id - 更新实例配置（启动命令/JVM 参数等）
  // 同步更新数据库持久化记录与内存中运行实例的字段，下次 start() 生效
  // 输入侧契约（issue 486）：形状/类型 schema 前置，业务语义（javaPath 可执行性等）仍由下方路由层持有
  router.put('/instances/:id', validateBody(instanceSettingsRequestBodySchema), asyncHandler(async (req, res) => {
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
  // 输入侧契约（issue 486）：startCommand 禁用键 schema 前置 400（find-002）；
  // 下方路由层原判断保留作纵深防御（中间件被移除时仍封堵 RCE）
  router.post('/instances/:id/start', validateBody(instanceStartRequestBodySchema), asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    // find-002：拒绝通过请求体传入任意启动命令字符串（远程代码执行入口）。
    // 启动方式仅由实例配置的 javaPath/jarFile/jvmArgs（服务层）控制。
    if (req.body && typeof req.body === 'object' && 'startCommand' in req.body) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'startCommand 已不再支持通过 API 传入'));
    }

    // EULA 检查：首次启动需要用户同意 EULA 协议（判定实现与服务层启动前置共用
    // isEulaAccepted：两侧口径分叉过——路由用严格行首匹配、服务层用行内匹配）
    if (!isEulaAccepted(instance.serverPath)) {
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
  // 输入侧契约（issue 486）：非空字符串 + 长度上限 schema 前置（仅拒收类型/长度非法，行为零变化）
  router.post('/instances/:id/command', validateBody(instanceCommandRequestBodySchema), asyncHandler(async (req, res) => {
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
  // 展示视图（重读文件 → 运行状态型属性覆盖 → 敏感键掩码）见
  // services/instance-properties.service.js getPropertiesView（issue 514 分层治理）。
  router.get('/instances/:id/properties', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    const props = await getPropertiesView(instance);
    res.json(validatedSuccess(serverPropertiesSchema, props));
  }));

  // PUT /api/instances/:id/properties - 更新 server.properties
  // 输入侧契约（issue 486）：对象形状 schema 前置（passthrough 保留全部属性键，
  // 数组/标量/null 在 schema 层拒绝），下游属性值语义校验不变。
  // 键白名单/敏感键占位符短路/单键值校验/写盘与重启联动编排见
  // services/instance-properties.service.js（issue 514 分层治理），路由层降为
  // 薄编排：参数解析 → service 调用 → 响应包装。
  router.put('/instances/:id/properties', validateBody(instancePropertiesRequestBodySchema), asyncHandler(async (req, res) => {
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

    const outcome = await applyPropertyUpdates(instance, newProps);
    if (!outcome.ok) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, `存在不允许写入或校验失败的属性: ${outcome.rejectedKeys.join(', ')}`));
    }
    // 全部为占位符/空提交：无实际变更，直接返回
    if (!outcome.applied) {
      return res.json(validatedSuccess(updatePropertiesResponseSchema, { restartRequired: [] }, 'Properties updated'));
    }

    logger.info(`[PUT properties] Saved successfully, instance.properties now has ${Object.keys(instance.properties).length} keys`);
    recordAudit({ instanceId: req.params.id, action: 'CONFIG_CHANGE', targetType: 'instance', targetId: req.params.id, detail: { field: 'properties' } });
    res.json(validatedSuccess(updatePropertiesResponseSchema, { restartRequired: outcome.restartRequired }, outcome.restartRequired.length > 0
      ? `Properties updated, ${outcome.restartRequired.length} 项需重启服务器生效`
      : 'Properties updated'));
  }));

  // DELETE /api/instances/:id - 卸载（删除）实例
  router.delete('/instances/:id', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

      // 0. 破坏性前置校验：确认与备份清单校验全部在停机与首个 rmSync 之前完成，
      //    拒绝路径零副作用（不停机、不删文件、不改 DB）。确认值取自请求体并由
      //    服务端比对实例名——前端输入框只存在于客户端，直连 API 的调用方此前
      //    可无确认删除。两侧 trim 后全等：写入侧已归一化新数据，但升级前库里
      //    可能存着带首尾空白的旧值乃至空名旧值，按原样或按「非空」比对都会让
      //    这类实例永远卸载不掉。缺失/类型不对/不匹配归同一错误码，文案不回显实例名。
      const parsedBody = instanceDeleteRequestBodySchema.safeParse(req.body ?? {});
      const trimmedInstanceName = (instance.name ?? '').trim();
      const confirmNameMatches =
        parsedBody.success && parsedBody.data.confirmName.trim() === trimmedInstanceName;
      if (!confirmNameMatches) {
        return res.status(400).json(error(ErrorCodes.INSTANCE_DELETE_CONFIRM_REQUIRED));
      }
      const acknowledgeIrreversible = parsedBody.data.acknowledgeIrreversible === true;
      // 空名实例的「输入实例名」闸门是空转的（空串天然匹配），不构成任何确认：
      // 这类实例必须显式声明已接受不可恢复
      if (trimmedInstanceName === '' && !acknowledgeIrreversible) {
        return res.status(ErrorCodes.INSTANCE_DELETE_UNNAMED.status).json(error(ErrorCodes.INSTANCE_DELETE_UNNAMED));
      }

      // 0.1 前置备份清单校验：实例备份目录按设计保留（见第 5 步），清单为空即这份
      //     数据没有任何灾备副本，仅凭实例名确认不足以放行，需调用方显式声明接受
      //     不可恢复。清单在此读一次供放行判定与意图审计；实际保留内容由删除后再
      //     读一次回报（两次差异只可能来自停机期间新增的快照）。
      const snapshotsBeforeDelete = listInstanceSnapshotDirs(req.params.id);
      if (snapshotsBeforeDelete.length === 0 && !acknowledgeIrreversible) {
        return res.status(409).json(error(ErrorCodes.INSTANCE_DELETE_NO_BACKUP));
      }

      // 1. 无条件取消崩溃重启/延迟重启定时器：已崩溃实例（isRunning=false）
      //    不满足下方 stopGracefully 分支（其内部才调用 cancelRestart），卸载时
      //    定时器不取消会保持存活；若 rmSync 因 Windows 文件占用句柄抛 EPERM
      //    导致目录与 server.jar 残留，5s 定时器回调的 jar 存在性检查通过，
      //    会对已从 manager 移除的实例 start() → 孤儿服务器进程自动启动
      //    （实例已 404，无人能再停止）。运行中实例此处先取消无副作用
      //    （cancelRestart 幂等），stopGracefully 内重复取消同样安全。
      instance.cancelRestart();

      // 2. 停止运行中的实例：用 stopGracefully 等待 MC 正常退出后再删除目录
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

      // 2.5 备份互斥前置检查：实例存在 creating/restoring 备份记录时拒绝卸载。
      //    恢复是 fire-and-forget 后台任务（耗时随世界规模可达分钟级），删除与其
      //    并发的两条竞争终态均为数据事故：删除落在恢复 rename 之后 → 失败回滚
      //    把已删实例目录整体还原（已删实例"复活"）；落在 rsync 复制中 → 源消失
      //    以 exit 24 退出被 okCodes 容忍（半复制当成功，pre_restore 被永久清除，
      //    原始世界不可逆丢失）。复用 backup.service.js 同款互斥语义（卡死恢复 +
      //    busyCount）；置于停机等待之后、首个 rmSync 之前——停机期间新启动的
      //    备份/恢复同样被拦下，且检查到删除间无 await（better-sqlite3 同步）无
      //    TOCTOU 窗口；被拒请求不触碰实例目录、快照目录与任何 DB 记录。
      BackupModel.resetStaleInProgress({ maxAgeMs: config.backupInProgressTimeoutMs, instanceId: req.params.id });
      const busyCount =
        BackupModel.findAll({ instanceId: req.params.id, status: 'creating' }).total +
        BackupModel.findAll({ instanceId: req.params.id, status: 'restoring' }).total;
      if (busyCount > 0) {
        return res.status(409).json(error(ErrorCodes.BACKUP_IN_PROGRESS, '备份进行中，请等待完成后再删除实例'));
      }

      const instancePath = instance.serverPath;

      // 3. 审计先于文件操作：rmSync 不可逆，先落一条「意图」记录，删除完成后再落
      //    「结果」记录——崩溃落在两者之间时审计里留有未闭环的意图，可与磁盘现状
      //    对照。detail 只含清理范围与保留计数，不含任何凭据。
      recordAudit({
        instanceId: req.params.id,
        action: AuditActions.INSTANCE_DELETE,
        targetType: 'instance',
        targetId: req.params.id,
        detail: { phase: 'intent', retainedBackupCount: snapshotsBeforeDelete.length, acknowledgeIrreversible },
      });

      // 4. 删除实例文件夹（含 instance.json）。文件删除必须前置：若先删内存/DB
      //    再 rmSync，Windows 句柄占用（杀软扫描 server.jar、资源管理器打开目录、
      //    日志文件被编辑器占用等）导致 rmSync 抛 EPERM（force:true 只吞 ENOENT
      //    不吞 EPERM）时删除已不可逆完成一半——实例已 404 客户端无法重试补偿，
      //    实例目录残留，重启 loadInstances（mc_server.js）还会从残留的
      //    instance.json 迁移"复活"已卸载实例。文件删除失败直接抛错经 asyncHandler
      //    进入全局 errorHandler，此时内存与 DB 记录均未动 → 实例保留可重试。
      // 不做事前存在性判定：rmSync 的 force 已容忍 ENOENT，而「预检 + 删除」之间的
      // 窗口里目录被重建时会把新目录删掉。删除失败（EPERM 等）照旧上抛
      if (instancePath) {
        fs.rmSync(instancePath, { recursive: true, force: true });
      }

      // 5. 清理该实例的 backups 表记录（InstanceModel.delete 只删 instances 表，
      //    记录否则成孤儿）。快照目录 backupsDir/<instanceId> 本身**不删**：它是
      //    实例数据的事实副本，卸载后仍需随磁盘留存供人工取回，磁盘回收由保留期
      //    孤儿清扫承接（services/backup-snapshot.service.js）；备份目录与实例
      //    目录分离，删不删它都不影响实例是否被 loadInstances 复活。
      BackupModel.deleteByInstance(req.params.id);

      // 6. 文件与备份记录全部清理成功后才从内存中移除
      serverManager.instances.delete(req.params.id);

      // 7. 最后从数据库删除记录。DB 删除失败仅警告不阻塞（实例目录已删、
      //    实例已 404，重试不可行；DB 记录残留重启会尝试加载该实例——
      //    属 SQLite 本地写失败的极端情况，且实例目录已删 createInstance 会
      //    重建空目录，风险远小于本路由历史 bug 的不可补偿半删除）
      try { InstanceModel.delete(req.params.id); } catch (e) { logger.warn('Failed to delete instance from DB:', e.message); }

      // 8. 结果审计 + 回报实际保留内容：删除后再读一次快照清单取磁盘现状
      //    （第 0.1 步那次只用于放行判定）
      const retainedBackups = listInstanceSnapshotDirs(req.params.id);
      recordAudit({
        instanceId: req.params.id,
        action: AuditActions.INSTANCE_DELETE,
        targetType: 'instance',
        targetId: req.params.id,
        detail: { phase: 'completed', retainedBackupCount: retainedBackups.length },
      });
      res.json(validatedSuccess(instanceDeleteResponseSchema, {
        retainedBackupCount: retainedBackups.length,
        retainedBackupNames: retainedBackups.slice(0, RETAINED_BACKUP_REPORT_LIMIT),
      }, 'Instance deleted'));
  }));

  // POST /api/instances/:id/eula - 写入 EULA 协议确认
  router.post('/instances/:id/eula', validateBody(instanceEulaRequestBodySchema), asyncHandler(async (req, res) => {
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
    // 原子写：MC 启动前会读该文件，半截内容会被解析成「未同意」并让服务器退出
    atomicWriteFile(eulaPath, content);

    res.json(validatedSuccess(nullDataSchema, null, agreed ? 'EULA accepted' : 'EULA declined'));
  }));

  // GET /api/instances/:id/world - 获取世界信息
  router.get('/instances/:id/world', asyncHandler(async (req, res) => {
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
        // 「下界」为 MC 官方中文译名（“地狱”系旧俗称，服务端展示文案对齐）
        { name: '下界', icon: '🔥', playerCount: dimCounts.nether },
        { name: '末地', icon: '🟣', playerCount: dimCounts.end }
      ]
    };

    res.json(validatedSuccess(worldInfoSchema, worldInfo));
  }));

  return router;
}
