// 玩家离线 UUID 与 stats 时长读取共享实现（全仓公共单一实现）：
// players.js 与 mc_server.js 共用本模块，避免重复副本算法分叉，
// 契约测试锁定行为。
//
// 覆盖语义：
// - offlineUuid：离线模式 UUID（MD5 v3，MC 原版算法）
// - getTotalPlayTime：候选路径读取（26.1+ players/stats 新格式 + 旧 stats 格式）
//   + offline uuid 兜底（online-mode=false 服务器）+ 路径穿越防御 + 非法 worldName 回退
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isPathContained } from './fs-utils.js';

/** 世界目录名白名单：仅字母/数字/_/-（不含路径分隔符与 ..，杜绝路径穿越） */
const LEVEL_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * 生成离线模式 UUID（online-mode=false 时使用；MC 原版 MD5 v3 算法）
 */
export function offlineUuid(playerName) {
  const data = `OfflinePlayer:${playerName}`;
  const hash = crypto.createHash('md5').update(data, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // v3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 读取玩家 stats 总游戏时长（秒；play_time tick / 20）。
 * uuid 为空串也可用：playerName 提供时自动尝试 offline uuid 候选
 * （无 usercache 玩家——Carpet 假人/26.x usercache 缺失——的兜底路径）。
 * @param {object} opts
 * @param {string} opts.serverPath 实例根目录
 * @param {string} opts.uuid 已知 UUID（可空串）
 * @param {string} [opts.playerName] 玩家名（offline uuid 兜底依据）
 * @param {string} [opts.levelName] level-name 配置（非法/缺失回退 'world'）
 */
export function getTotalPlayTime({ serverPath, uuid, playerName, levelName }) {
  // 服务层兜底：非法 worldName（含路径分隔符/..）回退 'world'
  let worldName = (typeof levelName === 'string' && levelName) || 'world';
  if (!LEVEL_NAME_REGEX.test(worldName)) {
    worldName = 'world';
  }
  const candidates = [];
  // uuid 非空才构建 uuid 候选（uuid 为空串——无 usercache 记录——时只走 offline uuid 兜底，
  // 避免 `${uuid}.json` 空名文件的无意义 stat）
  if (uuid) {
    candidates.push(
      // MC 26.1+ 新世界格式：players/stats
      path.join(serverPath, worldName, 'players', 'stats', `${uuid}.json`),
      path.join(serverPath, 'world', 'players', 'stats', `${uuid}.json`),
      // 旧格式：stats
      path.join(serverPath, worldName, 'stats', `${uuid}.json`),
      path.join(serverPath, 'world', 'stats', `${uuid}.json`),
      path.join(serverPath, 'stats', `${uuid}.json`),
    );
  }
  // 离线模式可能使用离线 UUID，也尝试一下（uuid 为空串时唯一有效候选）
  if (playerName) {
    const offline = offlineUuid(playerName);
    if (offline !== uuid) {
      candidates.push(path.join(serverPath, worldName, 'players', 'stats', `${offline}.json`));
      candidates.push(path.join(serverPath, 'world', 'players', 'stats', `${offline}.json`));
      candidates.push(path.join(serverPath, worldName, 'stats', `${offline}.json`));
      candidates.push(path.join(serverPath, 'world', 'stats', `${offline}.json`));
      candidates.push(path.join(serverPath, 'stats', `${offline}.json`));
    }
  }
  for (const statsPath of candidates) {
    // 候选路径 resolve 后必须位于 serverPath 内，越界丢弃（回退 'world' 已保证安全）
    if (!isPathContained(serverPath, statsPath)) continue;
    if (!fs.existsSync(statsPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
      const playTime =
        raw?.stats?.['minecraft:custom']?.['minecraft:play_time'] ||
        raw?.['minecraft:custom']?.['minecraft:play_time'] ||
        raw?.['minecraft:custom']?.['minecraft:total_world_time'] ||
        0;
      return Math.floor(playTime / 20);
    } catch {}
  }
  return 0;
}
