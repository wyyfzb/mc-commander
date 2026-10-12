import fs from 'fs';
import path from 'path';
import { BanModel } from '../db/ban.model.js';
import { atomicWriteFile } from './fs-utils.js';
import { PERMANENT_EXPIRES, isBanExpired, parseBanExpires } from './ban-expires.js';

/**
 * 实例启动前 tempban 对账：同步 banned-players.json 与 DB temp_bans 表。
 *
 * 停机期间用户可能直接编辑 banned-players.json 添加/删除封禁，
 * 导致面板 DB 与文件不一致：
 *   方向 1（文件→DB）：文件有但 DB 无活跃记录 → 补入 DB（永久，
 *     expiresAt 设为远未来值，findExpiredActive 永远不会匹配）
 *   方向 2（DB→文件）：DB 中已过期但文件仍存在 → 停机期间到期
 *     未 pardon，从文件删除对应条目 + 停用 DB 记录
 *
 * @param {string} instanceId - 实例 ID
 * @param {string} serverPath - 实例服务器目录
 */
export function reconcileTempBans(instanceId, serverPath) {
  const bannedPath = path.join(serverPath, 'banned-players.json');
  if (!fs.existsSync(bannedPath)) return;

  let fileBans;
  try {
    fileBans = JSON.parse(fs.readFileSync(bannedPath, 'utf-8'));
  } catch {
    return; // 文件损坏时不阻塞启动
  }
  if (!Array.isArray(fileBans)) return;

  const now = Date.now();
  const activeBans = BanModel.findActiveByInstance(instanceId);
  const activePlayerTargets = new Set(
    activeBans.filter((b) => b.targetType === 'player').map((b) => b.target),
  );

  // 方向 2 先行：清理已过期但文件仍残留的条目
  const expiredBans = BanModel.findExpiredActive(now);
  const expiredTargets = new Set(
    expiredBans
      .filter((b) => b.instanceId === instanceId && b.targetType === 'player')
      .map((b) => b.target),
  );
  let fileDirty = false;
  if (expiredTargets.size > 0) {
    const cleaned = fileBans.filter((entry) => !expiredTargets.has(entry.name));
    if (cleaned.length !== fileBans.length) {
      fileBans = cleaned;
      fileDirty = true;
      for (const ban of expiredBans) {
        if (ban.instanceId === instanceId && ban.targetType === 'player') {
          BanModel.deactivate(ban.id);
        }
      }
    }
  }

  // 方向 1：文件中存在但 DB 无活跃记录的封禁 → 补入 DB
  // 官条目带 expires 时按它镜像，否则方向 2 永远等不到这条记录到期；
  // 永久（哨兵/缺失）与解析不出都落到 PERMANENT_EXPIRES（远未来值，findExpiredActive
  // 的 <= now 比较永不匹配）——解析不出时宁可不动它，也不擅自替用户解封
  for (const entry of fileBans) {
    if (!entry.name || activePlayerTargets.has(entry.name)) continue;
    const { expiresAt } = parseBanExpires(entry.expires);
    BanModel.create({
      instanceId,
      targetType: 'player',
      target: entry.name,
      reason: entry.reason || null,
      expiresAt: expiresAt ?? PERMANENT_EXPIRES,
    });
  }

  // 方向 2 清理了文件条目 → 原子写回
  if (fileDirty) {
    atomicWriteFile(bannedPath, JSON.stringify(fileBans, null, 2));
  }
}

/** 官方封禁文件与其中的目标字段 */
const BAN_FILES = [
  { file: 'banned-players.json', targetType: 'player', key: 'name' },
  { file: 'banned-ips.json', targetType: 'ip', key: 'ip' },
];

/**
 * 扫出实例官方封禁文件里**已过到期时间**的条目。
 *
 * 为什么不看 DB：临时封禁可以由面板之外的东西建立（别的工具经 MSMP 写 `expires`、手工编辑
 * 文件），那些条目在 DB 里没有记录；而实测 26.3 不会因为 `expires` 过期就放行
 * （`UserBanList.isBanned` 只判 `contains`，`BanList` 也不清理过期条目），到点必须有人
 * 移除条目，否则玩家被永久挡在门外。
 *
 * @returns {{targetType: 'player'|'ip', target: string}[]} 待解封目标（文件缺失/损坏时为空）
 */
export function findExpiredOfficialBans(serverPath, now = Date.now()) {
  const result = [];
  for (const { file, targetType, key } of BAN_FILES) {
    const filePath = path.join(serverPath, file);
    if (!fs.existsSync(filePath)) continue;
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      continue; // 文件损坏时不猜，交给用户处理
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && isBanExpired(entry.expires, now)) {
        result.push({ targetType, target: entry[key] || '' });
      }
    }
  }
  return result.filter((e) => e.target);
}
