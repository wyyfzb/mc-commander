import fs from 'fs';
import path from 'path';
import { BanModel } from '../db/ban.model.js';
import { atomicWriteFile } from './fs-utils.js';

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
  // expiresAt 远未来值表示永久：findExpiredActive 使用 <= now 比较，
  // Number.MAX_SAFE_INTEGER（约 285,000 年）永远不会到期
  const PERMANENT_EXPIRES = Number.MAX_SAFE_INTEGER;
  for (const entry of fileBans) {
    if (!entry.name || activePlayerTargets.has(entry.name)) continue;
    BanModel.create({
      instanceId,
      targetType: 'player',
      target: entry.name,
      reason: entry.reason || null,
      expiresAt: PERMANENT_EXPIRES,
    });
  }

  // 方向 2 清理了文件条目 → 原子写回
  if (fileDirty) {
    atomicWriteFile(bannedPath, JSON.stringify(fileBans, null, 2));
  }
}
