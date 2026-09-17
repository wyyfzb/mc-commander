import fs from 'fs';
import path from 'path';
import config from '../config.js';
import { InstanceModel } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { INSTANCE_ID_PATTERN } from '../utils/instance-id.js';

/**
 * 备份快照目录的磁盘清点（backupsDir 侧的唯一读取口径）。
 *
 * 命名约定（backup.service.js getInstanceBackupDir）：快照 =
 * backupsDir/<instanceId>/<快照目录名>/——一级子目录是实例级目录，二级才是
 * 快照本身；面板库快照另占 backupsDir/panel/（panel-backup.service.js）。
 * 因此实例级目录是唯一可清扫单位，且把 backupsDir 本身排除在射程之外。
 */

// 实例 id 形态：与生成侧（utils/instance-id.js）共用同一常量——两处各写一份形态时，
// 改生成方式会让清扫静默停止（少删方向、不报错）。按形态白名单清点：panel/ 命名空间
// 与人工放置目录都不匹配，永不进入清扫射程
// （见 utils/instance-id.js 的形态说明）

/**
 * 列出实例备份目录下的快照目录名，按 mtime 倒序（最近在前）。
 * 目录不存在/不可读一律视为空清单——调用方据此走「无备份」分支。
 */
export function listInstanceSnapshotDirs(instanceId) {
  const dir = path.join(config.backupsDir, instanceId);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const snapshots = [];
  for (const entry of entries) {
    // 只认目录：备份目录内的散落文件不是快照，也不由本模块处置
    if (!entry.isDirectory()) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(dir, entry.name)).mtimeMs;
    } catch {
      // stat 失败（并发删除/权限）仍计入清单：在「有备份」方向保守
    }
    snapshots.push({ name: entry.name, mtimeMs });
  }
  return snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs).map((s) => s.name);
}

/**
 * 实例是否仍在用——判定只允许偏向「存在」：DB 有记录或实例目录仍在，任一成立
 * 即算在用；DB 不可读时同样按在用处理。清扫是延后无妨的维护动作，判错的代价
 * （误删唯一副本）远高于漏清，故所有不确定分支一律不删。
 */
function instanceStillExists(instanceId) {
  try {
    if (InstanceModel.getById(instanceId)) return true;
  } catch {
    return true;
  }
  return fs.existsSync(path.join(config.serversDir, instanceId));
}

/**
 * 清扫 backupsDir 下已无对应实例的实例级快照目录。
 * 「目录名符合实例 id 形态 + 实例已不存在 + mtime 早于保守期」三条同时成立才删；
 * 保守期用于避开「刚卸载又重建同 id」的实例（其备份目录会在保留期内被重新写入）。
 * 单目录失败不中断整轮，返回 { deleted, failed } 供日志与测试断言。
 */
export function pruneOrphanBackupDirs(retentionDays) {
  const result = { deleted: 0, failed: 0 };
  let entries;
  try {
    entries = fs.readdirSync(config.backupsDir, { withFileTypes: true });
  } catch {
    // backupsDir 尚未创建/不可读：没有可清扫对象，不算失败
    return result;
  }
  // 目录 mtime 在目录内增删条目时更新，等价「该实例最后一次备份活动」
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    const name = entry.name;
    if (!entry.isDirectory() || !INSTANCE_ID_PATTERN.test(name)) continue;
    try {
      if (instanceStillExists(name)) continue;
      if (fs.statSync(path.join(config.backupsDir, name)).mtimeMs >= cutoffMs) continue;
      // 删除前重查一次归属：判定与删除之间的窗口里同名实例被重建时，重建方可能
      // 已开始往该目录写新备份。重查把窗口从「整轮扫描时长」收窄到「一次查询」，
      // 不宣称原子——残留窗口由两条保守门覆盖：目录 mtime 未刷新（<保留期）与
      // DB 无记录，且被删对象是上一个同名实例的旧备份
      if (instanceStillExists(name)) continue;
      fs.rmSync(path.join(config.backupsDir, name), { recursive: true, force: true });
      result.deleted++;
      logger.info(`[OrphanBackup] 已清理无对应实例的备份目录: ${name}`);
    } catch (err) {
      result.failed++;
      logger.error(`[OrphanBackup] 清理备份目录失败 ${name}:`, err.message);
    }
  }
  return result;
}
