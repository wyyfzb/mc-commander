import express from 'express';
import fs from 'fs';
import path from 'path';
import { error, ErrorCodes } from '../utils/response.js';
import { BanModel } from '../db/index.js';
import { getTotalPlayTime } from '../utils/player-utils.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import {
  banRecordListSchema,
  banRequestBodySchema,
  banResponseBodySchema,
  nullDataSchema,
  playerDetailsResponseSchema,
  playerListSchema,
} from '@mc-commander/schemas';
import { validateBody, validatedSuccess } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';

// Minecraft 玩家名规范：3-16 位字母数字下划线
const PLAYER_NAME_REGEX = /^[A-Za-z0-9_]{3,16}$/;

// ban-ip 目标必须是合法 IPv4 地址
const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * 解析时长字符串为毫秒（自实现临时封禁用）。
 * 支持 s/m/h/d/w/mo 单位（如 '30m'、'1h'、'7d'、'1mo'），返回 null 表示无法解析。
 */
export function parseDuration(duration) {
  if (duration == null) return null;
  const str = String(duration).trim().toLowerCase();
  const match = str.match(/^(\d+)(s|m|h|d|w|mo)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_592_000_000 };
  return value * multipliers[match[2]];
}

// 校验玩家名参数中间件
function validatePlayerName(req, res, next) {
  const playerName = req.params.player;
  if (!playerName || !PLAYER_NAME_REGEX.test(playerName)) {
    return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, `Invalid player name: ${playerName}`));
  }
  next();
}

// 清理 reason 字符串，防止命令注入（移除换行符等特殊字符）
function sanitizeReason(reason) {
  if (!reason) return '';
  return String(reason).replace(/[\r\n;|&]/g, ' ').trim().substring(0, 200);
}

// RCON 命令守卫：实例未运行返回 400 INSTANCE_NOT_RUNNING（替代 sendCommand 抛裸 Error → 500）
function requireRunning(instance, res) {
  if (!instance.isRunning) {
    res.status(400).json(error(ErrorCodes.INSTANCE_NOT_RUNNING));
    return false;
  }
  return true;
}

export function createPlayerRoutes(serverManager) {
  const router = express.Router();

  // GET /api/instances/:id/players - 所有玩家列表（在线 + 离线）
  router.get('/instances/:id/players', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    const knownPlayers = instance.getAllKnownPlayers();

    // 临时封禁到期时间映射（服务端自实现 tempban 记录，供前端展示剩余时长）
    const activeBans = BanModel.findActiveByInstance(req.params.id);
    const banExpiresByTarget = new Map(
      activeBans.filter((b) => b.targetType === 'player').map((b) => [b.target, b.expiresAt]),
    );

    // IP 封禁状态：banned-ips.json（原版永久）+ temp_bans ip 型记录（临时）
    const bannedIps = new Set();
    const bannedIpsPath = path.join(instance.serverPath, 'banned-ips.json');
    if (fs.existsSync(bannedIpsPath)) {
      try {
        for (const entry of JSON.parse(fs.readFileSync(bannedIpsPath, 'utf-8'))) {
          if (entry.ip) bannedIps.add(entry.ip);
        }
      } catch {}
    }
    const activeIpBans = activeBans.filter((b) => b.targetType === 'ip');

    // 世界出生点是世界级数据（从 level.dat 读取）：在线/离线循环外统一读取
    // 一次供所有玩家复用，避免循环内每名玩家访问 _worldSpawn（truthy 检查 +
    // spread 各访问一次 getter）导致按玩家数 N 倍重复完整读盘 level.dat
    const worldSpawn = instance._worldSpawn ? { ...instance._worldSpawn } : null;

    const onlinePlayers = [];

    for (const [name, onlineInfo] of instance.players) {
      const known = knownPlayers.get(name) || {};
      let totalPlayTime = 0;

      // 无 usercache 记录（Carpet 假人/26.x usercache 缺失）时 uuid 为空串，
      // getTotalPlayTime 内部走 offline uuid 候选兜底
      totalPlayTime = getTotalPlayTime({
        serverPath: instance.serverPath,
        uuid: known.uuid || '',
        playerName: name,
        levelName: instance.properties?.['level-name'],
      });

      // 优先使用自行追踪的游戏时长
      const savedData = loadPlayerData(instance.serverPath, name) || {};
      if (savedData.totalPlayTime && savedData.totalPlayTime > totalPlayTime) {
        totalPlayTime = savedData.totalPlayTime;
      }
      // 在线玩家加上本次会话时长
      if (onlineInfo.joinTime) {
        totalPlayTime += Math.floor((Date.now() - onlineInfo.joinTime) / 1000);
      }

      const playerIp = onlineInfo.ip || '';
      const ipBan = activeIpBans.find((b) => b.target === playerIp);

      onlinePlayers.push({
        name,
        uuid: known.uuid || '',
        isOnline: true,
        ip: playerIp,
        joinTime: onlineInfo.joinTime,
        onlineTime: Math.floor((Date.now() - onlineInfo.joinTime) / 1000),
        totalPlayTime: totalPlayTime,
        isOp: known.isOp || false,
        isWhitelisted: known.isWhitelisted || false,
        isBanned: known.isBanned || false,
        // 临时封禁到期时间（null=永久封禁或未封禁）
        banExpiresAt: banExpiresByTarget.get(name) || null,
        // IP 封禁状态（原版永久 banned-ips + 自实现临时 IP 封禁）
        isIpBanned: playerIp ? bannedIps.has(playerIp) : false,
        ipBanExpiresAt: ipBan?.expiresAt || null,
        isFakePlayer: name.startsWith('[Bot]') || name.startsWith('bot_'),
        lastSeen: new Date().toISOString(),
        health: null,
        maxHealth: null,
        hunger: null,
        xpLevel: null,
        // 世界出生点是世界级数据（从 level.dat 读取），对所有玩家统一返回
        spawnPoint: worldSpawn,
        respawnPoint: null,
        // 合并持久化 playerdata 与内存事件：服务端重启后内存清空，
        // 若只读内存则在线玩家成就历史丢失（与离线分支 240 行行为不一致）
        events: instance._mergePlayerEvents(savedData.events || [], instance.playerEvents?.get(name) || []),
        // 会话历史与日志统计（日志 Tab 树状时间线用）
        sessions: Array.isArray(onlineInfo.sessions) ? onlineInfo.sessions : [],
        stats: instance._computePlayerStats(
          Array.isArray(onlineInfo.sessions) ? onlineInfo.sessions : [],
          instance._mergePlayerEvents(savedData.events || [], instance.playerEvents?.get(name) || []),
          onlineInfo,
          name,
        ),
      });
      knownPlayers.delete(name);
    }

    // RCON 可用时，并行获取所有在线玩家的详情
    if (instance.isRunning && instance.isRconConnected && onlinePlayers.length > 0) {
      try {
        const detailPromises = onlinePlayers.map(p =>
          instance.getPlayerDetails(p.name).catch(() => null)
        );
        const details = await Promise.all(detailPromises);
        for (let i = 0; i < onlinePlayers.length; i++) {
          if (details[i]) {
            Object.assign(onlinePlayers[i], details[i]);
          }
        }
      } catch (e) {
        logger.warn('Failed to fetch player details:', e.message);
      }
    } else if (onlinePlayers.length > 0) {
      // RCON 不可用时，从 .dat 文件加载物品栏快照作为回退
      // _loadInventoryFromDat 内部有 offline uuid 兜底：
      // 无 usercache 记录时物品栏快照也能读取
      for (const p of onlinePlayers) {
        try {
          const inv = instance._loadInventoryFromDat(p.uuid, p.name);
          if (inv) p.inventory = inv;
        } catch {}
      }
    }

    // 合并在线和离线玩家
    const offlinePlayers = [];
    for (const [name, knownInfo] of knownPlayers) {
      if (instance.players.has(name)) continue;

      let totalPlayTime = 0;
      // 无 usercache 记录时走 offline uuid 兜底
      totalPlayTime = getTotalPlayTime({
        serverPath: instance.serverPath,
        uuid: knownInfo.uuid || '',
        playerName: name,
        levelName: instance.properties?.['level-name'],
      });

      // 从持久化文件加载离线数据（优先使用自行追踪的游戏时长）
      const savedData = loadPlayerData(instance.serverPath, name) || {};
      if (savedData.totalPlayTime && savedData.totalPlayTime > totalPlayTime) {
        totalPlayTime = savedData.totalPlayTime;
      }

      // 从 .dat 文件加载离线玩家物品栏快照
      // _loadInventoryFromDat 内部有 offline uuid 兜底：
      // 无 usercache 记录（Carpet 假人/26.x）时快照也能读取
      let inventory = null;
      try { inventory = instance._loadInventoryFromDat(knownInfo.uuid || '', name); } catch {}

      offlinePlayers.push({
        name,
        uuid: knownInfo.uuid || '',
        isOnline: false,
        gameMode: savedData.gameMode || null,
        dimension: savedData.dimension || null,
        position: savedData.position || null,
        joinTime: null,
        onlineTime: null,
        totalPlayTime: totalPlayTime,
        isOp: knownInfo.isOp || false,
        isWhitelisted: knownInfo.isWhitelisted || false,
        isBanned: knownInfo.isBanned || false,
        // 临时封禁到期时间（null=永久封禁或未封禁）
        banExpiresAt: banExpiresByTarget.get(name) || null,
        // IP 封禁状态（用持久化记录的历史 IP 匹配）
        isIpBanned: savedData.ip ? bannedIps.has(savedData.ip) : false,
        ipBanExpiresAt: savedData.ip
          ? (activeIpBans.find((b) => b.target === savedData.ip)?.expiresAt || null)
          : null,
        isFakePlayer: name.startsWith('[Bot]') || name.startsWith('bot_'),
        lastSeen: savedData.lastSeen ? new Date(savedData.lastSeen).toISOString() : (knownInfo.lastSeen || null),
        health: savedData.health ?? null,
        maxHealth: savedData.maxHealth ?? null,
        hunger: savedData.hunger ?? null,
        xpLevel: savedData.xpLevel ?? null,
        ip: savedData.ip || '',
        // 世界出生点是世界级数据，统一用当前 level.dat 的出生点（离线玩家不查详情）
        spawnPoint: worldSpawn || (savedData.spawnPoint || null),
        respawnPoint: savedData.respawnPoint || null,
        // 事件合并内存与持久化（服务端重启后不丢失）
        events: instance._mergePlayerEvents(savedData.events || [], instance.playerEvents?.get(name) || []),
        // 会话历史与日志统计（日志 Tab 树状时间线用）
        sessions: Array.isArray(savedData.sessions) ? savedData.sessions : [],
        stats: instance._computePlayerStats(
          Array.isArray(savedData.sessions) ? savedData.sessions : [],
          instance._mergePlayerEvents(savedData.events || [], instance.playerEvents?.get(name) || []),
          null,
          name,
        ),
        inventory,
      });
    }

    const players = [...onlinePlayers, ...offlinePlayers];
    res.json(validatedSuccess(playerListSchema, players));
  }));

  // GET /api/instances/:id/players/bans - 封禁记录（生效中 + 历史）
  // 合并：自实现临时封禁记录（temp_bans，含已解封/到期历史）+
  //      原版永久封禁文件（banned-players.json / banned-ips.json）
  router.get('/instances/:id/players/bans', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    const bans = [];

    // 1. 自实现临时封禁记录（含历史）
    for (const b of BanModel.findAllByInstance(req.params.id)) {
      bans.push({
        targetType: b.targetType,
        target: b.target,
        reason: b.reason || '',
        isActive: b.isActive,
        isPermanent: false,
        expiresAt: b.expiresAt,
        createdAt: b.createdAt,
      });
    }

    // 生效中的临时封禁目标：其原版 ban/ban-ip 条目是临时封禁的实现载体，
    // 与 temp_bans 记录重复，跳过以免同一封禁在记录中显示两条。
    const activeTempKeys = new Set(
      BanModel.findActiveByInstance(req.params.id).map(
        (b) => `${b.targetType}:${b.target}`,
      ),
    );

    // 2. 原版永久封禁文件（当前生效）
    const bannedFiles = [
      { path: path.join(instance.serverPath, 'banned-players.json'), targetType: 'player', key: 'name' },
      { path: path.join(instance.serverPath, 'banned-ips.json'), targetType: 'ip', key: 'ip' },
    ];
    for (const file of bannedFiles) {
      if (!fs.existsSync(file.path)) continue;
      try {
        for (const entry of JSON.parse(fs.readFileSync(file.path, 'utf-8'))) {
          const target = entry[file.key] || '';
          if (activeTempKeys.has(`${file.targetType}:${target}`)) continue;
          bans.push({
            targetType: file.targetType,
            target,
            reason: entry.reason || '',
            isActive: true,
            isPermanent: true,
            expiresAt: null,
            createdAt: entry.created || null,
          });
        }
      } catch {}
    }

    // 生效中在前：临时到期时间升序 → 永久；历史按创建时间倒序
    bans.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.isActive) {
        if (a.isPermanent !== b.isPermanent) return a.isPermanent ? 1 : -1;
        return (a.expiresAt || 0) - (b.expiresAt || 0);
      }
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });

    res.json(validatedSuccess(banRecordListSchema, bans));
  }));

  router.get('/instances/:id/players/:player/details', validatePlayerName, asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }

    const playerName = req.params.player;
    const knownPlayers = instance.getAllKnownPlayers();
    const known = knownPlayers.get(playerName) || {};

    let totalPlayTime = 0;
    // 无 usercache 记录时走 offline uuid 兜底
    totalPlayTime = getTotalPlayTime({
      serverPath: instance.serverPath,
      uuid: known.uuid || '',
      playerName,
      levelName: instance.properties?.['level-name'],
    });

    const baseInfo = {
      name: playerName,
      uuid: known.uuid || '',
      isOnline: instance.players.has(playerName),
      isOp: known.isOp || false,
      isWhitelisted: known.isWhitelisted || false,
      isBanned: known.isBanned || false,
      totalPlayTime: totalPlayTime,
      lastSeen: known.lastSeen || null,
    };

    try {
      const details = await instance.getPlayerDetails(playerName);
      res.json(validatedSuccess(playerDetailsResponseSchema, { ...baseInfo, ...details }));
    } catch (e) {
      logger.error(`Failed to get player details for ${playerName}:`, e);
      const fallbackSaved = loadPlayerData(instance.serverPath, playerName) || {};
      // 与成功路径字段集对齐：缺 sessions/stats/inventory/armor/xpProgress
      // 会让前端把 undefined 当数组访问崩溃——detail-log-tab 对 sessions 展开
      const mergedEvents = instance._mergePlayerEvents(
        fallbackSaved.events || [],
        instance.playerEvents?.get(playerName) || [],
      );
      res.json(validatedSuccess(playerDetailsResponseSchema, {
        ...baseInfo,
        health: null,
        maxHealth: null,
        hunger: null,
        xpLevel: null,
        armor: null,
        xpProgress: null,
        gameMode: null,
        dimension: null,
        position: null,
        spawnPoint: null,
        respawnPoint: null,
        // 与成功路径一致：合并持久化 playerdata，RCON 失败时不丢历史
        events: mergedEvents,
        sessions: Array.isArray(fallbackSaved.sessions) ? fallbackSaved.sessions : [],
        stats: instance._computePlayerStats(
          Array.isArray(fallbackSaved.sessions) ? fallbackSaved.sessions : [],
          mergedEvents,
          null,
          playerName,
        ),
        inventory: null,
      }));
    }
  }));

  function loadPlayerData(serverPath, playerName) {
    try {
      const filePath = path.join(serverPath, 'playerdata', `${playerName}.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  // POST /api/instances/:id/players/:player/op
  router.post('/instances/:id/players/:player/op', validatePlayerName, asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    if (!requireRunning(instance, res)) return;
    await instance.sendCommand(`op ${req.params.player}`);
    recordAudit({ instanceId: req.params.id, action: AuditActions.PLAYER_OP, targetType: 'player', targetId: req.params.player });
    res.json(validatedSuccess(nullDataSchema, null, `Opped ${req.params.player}`));
  }));

  // DELETE /api/instances/:id/players/:player/op
  router.delete('/instances/:id/players/:player/op', validatePlayerName, asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    if (!requireRunning(instance, res)) return;
    await instance.sendCommand(`deop ${req.params.player}`);
    recordAudit({ instanceId: req.params.id, action: AuditActions.PLAYER_DEOP, targetType: 'player', targetId: req.params.player });
    res.json(validatedSuccess(nullDataSchema, null, `Deopped ${req.params.player}`));
  }));

  // POST /api/instances/:id/players/:player/kick
  router.post('/instances/:id/players/:player/kick', validatePlayerName, asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    if (!requireRunning(instance, res)) return;
    // express 5：无 JSON body 的请求 req.body 为 undefined（v4 是 {}）
    const reason = sanitizeReason(req.body?.reason) || 'Kicked by operator';
    await instance.sendCommand(`kick ${req.params.player} ${reason}`);
    recordAudit({ instanceId: req.params.id, action: AuditActions.PLAYER_KICK, targetType: 'player', targetId: req.params.player, detail: { reason } });
    res.json(validatedSuccess(nullDataSchema, null, `Kicked ${req.params.player}`));
  }));

  // POST /api/instances/:id/players/:player/ban
  // schema 校验请求结构，后续业务逻辑（IP 正则、时长解析、原子写入）不变
  router.post('/instances/:id/players/:player/ban',
    validatePlayerName,
    validateBody(banRequestBodySchema),
    asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    if (!requireRunning(instance, res)) return;
    const reason = sanitizeReason(req.body.reason) || 'Banned by operator';
    const duration = req.body.duration;
    const ip = typeof req.body.ip === 'string' ? req.body.ip.trim() : null;

    if (ip) {
      if (!IP_REGEX.test(ip)) {
        return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid IP address'));
      }
    }

    let expiresAt = null;
    const expiresMs = parseDuration(duration);
    let tempBan = null;
    if (expiresMs) {
      expiresAt = Date.now() + expiresMs;
      // 先写记录：写入失败（同步抛错）时命令尚未执行，
      // 不会出现「原版封禁已生效但记录缺失」的中间态
      tempBan = BanModel.create({
        instanceId: req.params.id,
        targetType: ip ? 'ip' : 'player',
        target: ip || req.params.player,
        reason,
        expiresAt,
      });
    }

    try {
      if (ip) {
        await instance.sendCommand(`ban-ip ${ip} ${reason}`);
      } else {
        await instance.sendCommand(`ban ${req.params.player} ${reason}`);
      }
    } catch (err) {
      // 命令执行失败：回滚已写入的临时记录，保持「记录 ⇔ 封禁」一致，
      // 避免残留「已封禁」记录误导前端展示/到期轮询
      if (tempBan && tempBan.id != null) {
        try {
          BanModel.deactivate(tempBan.id);
        } catch (rollbackErr) {
          logger.error(`Failed to rollback temp ban record ${tempBan.id}:`, rollbackErr);
        }
      }
      throw err;
    }

    recordAudit({ instanceId: req.params.id, action: AuditActions.PLAYER_BAN, targetType: ip ? 'ip' : 'player', targetId: ip || req.params.player, detail: { reason, duration: duration || null } });
    res.json(validatedSuccess(banResponseBodySchema, { expiresAt }, `Banned ${req.params.player}`));
  }));

  // POST /api/instances/:id/players/:player/pardon
  // 手动解封：先清理 temp_bans 记录、再执行原版 pardon（与 ban 接口
  // 「先写记录、命令失败回滚」对称），维持「记录存在 ⇔ 原版封禁生效」不变量：
  //   - 记录清理失败（SQLITE_BUSY/磁盘满，同步抛错）→ 命令不执行，无中间态
  //     （避免「原版已解封但记录残留」导致前端误判解封失败 + 到期重复 pardon）；
  //   - 命令执行失败 → 用 create 恢复已清理的记录作补偿，避免「原版未解封但
  //     记录缺失」→ 到期轮询失去记录 → 临时封禁退化为永久封禁。
  router.post('/instances/:id/players/:player/pardon', validatePlayerName, asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    if (!requireRunning(instance, res)) return;
    // 备份该玩家的生效记录，供命令失败时补偿恢复
    const tempBans = BanModel.findActiveByInstance(req.params.id)
      .filter((b) => b.targetType === 'player' && b.target === req.params.player);
    // 先清理记录：清理失败（同步抛错）时命令尚未执行，无中间态
    BanModel.deactivateByPlayer(req.params.id, req.params.player);
    try {
      await instance.sendCommand(`pardon ${req.params.player}`);
    } catch (err) {
      // 命令执行失败：恢复已清理的记录，保持「记录 ⇔ 封禁」一致
      for (const b of tempBans) {
        try {
          BanModel.create({
            instanceId: b.instanceId,
            targetType: b.targetType,
            target: b.target,
            reason: b.reason,
            expiresAt: b.expiresAt,
          });
        } catch (restoreErr) {
          logger.error(`Failed to restore temp ban record for ${b.target}:`, restoreErr);
        }
      }
      throw err;
    }
    recordAudit({ instanceId: req.params.id, action: AuditActions.PLAYER_PARDON, targetType: 'player', targetId: req.params.player });
    res.json(validatedSuccess(nullDataSchema, null, `Pardoned ${req.params.player}`));
  }));

  // POST /api/instances/:id/players/bans/pardon - 通用手动解封（玩家或 IP）
  // body: { targetType: 'player'|'ip', target: 'xxx' }
  // 按 targetType 执行原版 pardon/pardon-ip，并同步清理 temp_bans 对应记录。
  // 修复：手动解封 IP 时若仅执行 pardon-ip 而不清记录，temp_bans 会残留生效 IP
  // 记录，导致前端玩家列表/封禁记录错误显示（ipBanExpiresAt）。
  // 顺序与 ban 接口对称：先清理记录（失败则命令不执行，无中间态），命令失败时
  // 用 create 恢复记录作补偿，维持「记录存在 ⇔ 原版封禁生效」不变量。
  router.post('/instances/:id/players/bans/:target/pardon', asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    if (!requireRunning(instance, res)) return;
    const targetType = req.body?.targetType;
    const target = req.params.target;
    if (targetType !== 'player' && targetType !== 'ip') {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'targetType 仅支持 player/ip'));
    }
    if (!target) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'target 必填'));
    }
    if (targetType === 'ip' && !IP_REGEX.test(target)) {
      return res.status(400).json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid IP address'));
    }

    // 备份该目标的生效记录，供命令失败时补偿恢复
    const tempBans = BanModel.findActiveByInstance(req.params.id)
      .filter((b) => b.targetType === targetType && b.target === target);
    // 先清理记录：清理失败（同步抛错）时命令尚未执行，无中间态
    if (targetType === 'ip') {
      BanModel.deactivateByIp(req.params.id, target);
    } else {
      BanModel.deactivateByPlayer(req.params.id, target);
    }
    try {
      if (targetType === 'ip') {
        await instance.sendCommand(`pardon-ip ${target}`);
      } else {
        await instance.sendCommand(`pardon ${target}`);
      }
    } catch (err) {
      // 命令执行失败：恢复已清理的记录，保持「记录 ⇔ 封禁」一致
      for (const b of tempBans) {
        try {
          BanModel.create({
            instanceId: b.instanceId,
            targetType: b.targetType,
            target: b.target,
            reason: b.reason,
            expiresAt: b.expiresAt,
          });
        } catch (restoreErr) {
          logger.error(`Failed to restore temp ban record for ${b.target}:`, restoreErr);
        }
      }
      throw err;
    }
    // 审计复用 PLAYER_PARDON（与玩家名 pardon 端点同一「解封」语义）：操作过滤下拉由该
    // 枚举覆盖全部解封操作，拆新枚举会让同一动作出现两个标签；targetType 对齐 PLAYER_BAN
    // 的 ip/player 双型；detail.entry 标注来自封禁记录端点，与玩家卡解封行可区分。
    recordAudit({ instanceId: req.params.id, action: AuditActions.PLAYER_PARDON, targetType, targetId: target, detail: { entry: 'ban-record' } });
    res.json(validatedSuccess(nullDataSchema, null, `Pardoned ${targetType}: ${target}`));
  }));

  // POST /api/instances/:id/players/:player/whitelist/add
  router.post('/instances/:id/players/:player/whitelist/add', validatePlayerName, asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    if (!requireRunning(instance, res)) return;
    await instance.sendCommand(`whitelist add ${req.params.player}`);
    // detail.op 与 remove 端点成对标注：add/remove 共用 PLAYER_WHITELIST，靠 detail 区分方向
    recordAudit({ instanceId: req.params.id, action: AuditActions.PLAYER_WHITELIST, targetType: 'player', targetId: req.params.player, detail: { op: 'add' } });
    res.json(validatedSuccess(nullDataSchema, null, `Added ${req.params.player} to whitelist`));
  }));

  // DELETE /api/instances/:id/players/:player/whitelist
  router.delete('/instances/:id/players/:player/whitelist', validatePlayerName, asyncHandler(async (req, res) => {
    const instance = serverManager.getInstance(req.params.id);
    if (!instance) {
      return res.status(404).json(error(ErrorCodes.INSTANCE_NOT_FOUND));
    }
    if (!requireRunning(instance, res)) return;
    await instance.sendCommand(`whitelist remove ${req.params.player}`);
    // 审计复用 PLAYER_WHITELIST：前端映射「白名单操作」本就方向中性（add/remove 共用），
    // 拆新枚举会让过滤下拉出现两个半语义项；detail.op 区分加入/移除，与 add 端点成对标注。
    recordAudit({ instanceId: req.params.id, action: AuditActions.PLAYER_WHITELIST, targetType: 'player', targetId: req.params.player, detail: { op: 'remove' } });
    res.json(validatedSuccess(nullDataSchema, null, `Removed ${req.params.player} from whitelist`));
  }));

  return router;
}
