import fs from 'fs';
import path from 'path';
import config from '../config.js';
import { BackupModel, InstanceModel } from '../db/index.js';
// 归档挂载要记录快照体积：体积的唯一口径在 backup.service（快照创建时也用它），
// 不另写一份目录遍历（两处各写一份必然在排除清单/软链处理上分叉）。
// resolveContained 同理——路径包含校验只此一份实现。
// 依赖方向安全：backup.service 不反向引用本模块。
import { estimateDirSize, resolveContained } from './backup.service.js';
import { logger } from '../utils/logger.js';
import { INSTANCE_ID_PATTERN } from '../utils/instance-id.js';

/**
 * 备份快照目录的磁盘清点（backupsDir 侧的唯一读取口径）。
 *
 * 命名约定（backup.service.js getInstanceBackupDir）：快照 =
 * backupsDir/<instanceId>/<快照目录名>/——一级子目录是实例级目录，二级才是
 * 快照本身；面板库快照另占 backupsDir/panel/（panel-backup.service.js）。
 * 因此一级目录是清点的边界（backupsDir 本身排除在射程外），而**清扫单位是二级
 * 的快照目录**：一级目录里可能同时躺着「已被别的实例挂载」与「无人持有」的快照，
 * 按一级整体删除会把前者删掉（见 pruneOrphanBackupDirs）。
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
 *
 * 已索引的快照（含被别的实例**挂载**走的归档快照）一律跳过：挂载只登记索引、不复制
 * 磁盘内容，快照仍住在这个已卸载实例的目录里——整目录清扫会把别人正在用的唯一副本删掉，
 * 只留一条指向空目录的记录。故清扫粒度落到「快照子目录」而非「实例级目录」：
 * 有索引的留下，无索引的按保留期清理，实例级目录空了才随之消失。
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
  // 索引不可读时无法判断「哪份快照还有人持有」：清扫是延后无妨的维护动作，
  // 判错的代价（误删唯一副本）远高于漏清，故整轮放弃
  const indexed = indexedSnapshotPaths();
  if (indexed === null) {
    logger.warn('[OrphanBackup] 备份索引不可读，本轮跳过孤儿快照清扫');
    return result;
  }
  // 目录 mtime 在目录内增删条目时更新，等价「该实例最后一次备份活动」
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    const name = entry.name;
    if (!entry.isDirectory() || !INSTANCE_ID_PATTERN.test(name)) continue;
    const instanceDir = path.join(config.backupsDir, name);
    try {
      if (instanceStillExists(name)) continue;
      if (fs.statSync(instanceDir).mtimeMs >= cutoffMs) continue;
      // 删除前重查一次归属：判定与删除之间的窗口里同名实例被重建时，重建方可能
      // 已开始往该目录写新备份。重查把窗口从「整轮扫描时长」收窄到「一次查询」，
      // 不宣称原子——残留窗口由两条保守门覆盖：目录 mtime 未刷新（<保留期）与
      // DB 无记录，且被删对象是上一个同名实例的旧备份
      if (instanceStillExists(name)) continue;

      let snapshots = [];
      try {
        snapshots = fs.readdirSync(instanceDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        continue; // 并发删除：本轮无事可做
      }
      for (const snap of snapshots) {
        const snapDir = path.join(instanceDir, snap.name);
        // 已被索引（含挂载）：有人在用，绝不清理
        if (indexed.has(path.resolve(snapDir))) continue;
        try {
          fs.rmSync(snapDir, { recursive: true, force: true });
          result.deleted++;
          logger.info(`[OrphanBackup] 已清理无对应实例的备份快照: ${name}/${snap.name}`);
        } catch (err) {
          result.failed++;
          logger.error(`[OrphanBackup] 清理备份快照失败 ${name}/${snap.name}:`, err.message);
        }
      }
      // 目录已空才随之消失；仍有残留（已挂载快照、散落文件）时保留
      try {
        fs.rmdirSync(instanceDir);
      } catch {
        // ENOTEMPTY/ENOENT：正常工作分支
      }
    } catch (err) {
      result.failed++;
      logger.error(`[OrphanBackup] 清理备份目录失败 ${name}:`, err.message);
    }
  }
  return result;
}

// ── 归档快照：卸载实例后按设计保留下来的快照目录，备份表里已无索引 ──────
// 「卸载 → 保留快照」与「列表只读备份表」两条设计叠加出的盲区：目录还在磁盘上（会随保留期
// 孤儿清扫被删），但 UI 完全看不到、无法一键恢复。本域负责把它们**清点出来**，并提供
// 「挂载」——只把快照登记回备份表，不复制、不移动磁盘内容（恢复/下载/删除随后都走常规路径）。
// 挂载后的生命周期：不再受孤儿清扫影响（已在索引中的快照被清扫跳过），但作为该实例的普通
// 备份条目，仍受其保留策略（数量/天数上限）与手工删除约束——UI 文案按此口径写。

/**
 * 快照有效性判定（单一实现）：快照 = 实例目录镜像，世界数据位于
 * `<level-name>/level.dat` 直接层（兼容 26.1 新布局与自定义 level-name）。
 * 返回世界目录名（无效时为 null）。backup.service.js 的 `_hasLevelData` 与此同判据，
 * 两处各写一份会在「什么算有效快照」上分叉。
 */
export function findSnapshotWorldName(snapshotDir) {
  let entries;
  try {
    entries = fs.readdirSync(snapshotDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if (fs.statSync(path.join(snapshotDir, entry.name, 'level.dat')).isFile()) {
        return entry.name;
      }
    } catch {
      // 该子目录没有 level.dat：继续找
    }
  }
  return null;
}

/**
 * 备份表已索引的快照目录绝对路径集合（用于「磁盘有、索引无」的差集）。
 * DB 不可读时返回 null（调用方各自决定保守方向：清单侧不显示，清扫侧整轮放弃）。
 */
function indexedSnapshotPaths() {
  let rows = [];
  try {
    rows = BackupModel.listFilePaths();
  } catch (err) {
    logger.warn('[Archive] 备份索引不可读，本次按空清单处理:', err.message);
    return null;
  }
  return new Set(rows.map((p) => path.resolve(p)));
}

/**
 * 列出磁盘上未被备份索引的实例级快照组（按最近快照时间倒序）。
 *
 * 判据方向是「可见性」而非「实例是否还在」：既覆盖已卸载实例的遗留归档，
 * 也覆盖现存实例目录里未被索引的快照（备份表记录被清过、目录是人工放回的等）。
 * 只认形态合法的目录名（`<type>-<8 位 hex>`）——`panel/` 命名空间与人工放置目录
 * 不进射程（与孤儿清扫同一白名单，共用 utils/instance-id.js 的形态常量）。
 * 软链/联结点同样不进射程（Dirent 判定不跟随链接，与挂载侧的拒绝口径一致）。
 */
export function listArchivedSnapshots() {
  const indexed = indexedSnapshotPaths();
  if (indexed === null) return [];

  let entries;
  try {
    entries = fs.readdirSync(config.backupsDir, { withFileTypes: true });
  } catch {
    return []; // backupsDir 尚未创建：没有可归档对象
  }

  const groups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !INSTANCE_ID_PATTERN.test(entry.name)) continue;
    const archiveDir = path.join(config.backupsDir, entry.name);

    let snapshots;
    try {
      snapshots = fs.readdirSync(archiveDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue; // 并发删除/无权限：跳过该组（下一次清点会重新出现）
    }

    let snapshotCount = 0;
    let usableCount = 0;
    let latestMtimeMs = 0;
    for (const snap of snapshots) {
      const full = path.join(archiveDir, snap.name);
      if (indexed.has(path.resolve(full))) continue; // 已索引：它不是「看不到」的那部分
      snapshotCount += 1;
      if (findSnapshotWorldName(full)) usableCount += 1;
      try {
        latestMtimeMs = Math.max(latestMtimeMs, fs.statSync(full).mtimeMs);
      } catch {
        // stat 失败（并发删除）：只影响时间展示
      }
    }
    if (snapshotCount === 0) continue;

    let instanceExists = false;
    try {
      instanceExists = Boolean(InstanceModel.getById(entry.name));
    } catch {
      instanceExists = false;
    }

    groups.push({
      archiveId: entry.name,
      instanceExists,
      snapshotCount,
      usableCount,
      latestMtime: new Date(latestMtimeMs || Date.now()).toISOString(),
    });
  }

  return groups.sort((a, b) => b.latestMtime.localeCompare(a.latestMtime));
}

/**
 * 把某个归档目录下未被索引的快照登记到目标实例的备份表（**只建索引，不动磁盘**）。
 * - `archiveId` 必须是形态合法的目录名（拒绝任意路径：这里会用它拼路径）
 * - 归档目录必须是真实目录（软链/联结点一律按「不存在」拒绝：清点侧用
 *   readdirSync 的 Dirent 判定，链接本就不会出现在列表里，跟着链接登记会造出
 *   一条指向别处、随时失效的记录），且 realpath 后仍在 backupsDir 内
 * - 认不出世界数据的快照跳过（挂上去也恢复不了，只会污染列表）
 * - 已在索引中的快照跳过（幂等：重复点挂载不会插重复行；并发下由
 *   UNIQUE(file_path) 兜底，冲突同样计 skipped）
 * 返回 `{ attached, skipped }`；目标实例不存在时抛错（由路由层映射 404）。
 */
export async function attachArchivedSnapshots(instanceId, archiveId) {
  if (!INSTANCE_ID_PATTERN.test(String(archiveId ?? ''))) {
    throw new Error('Invalid archive id');
  }
  const archiveDir = path.resolve(config.backupsDir, archiveId);
  // 形态白名单已排除分隔符，这里再核一次父目录归属（防形态演化后拼接越界）
  if (path.dirname(archiveDir) !== path.resolve(config.backupsDir)) {
    throw new Error('Archive directory escapes backups dir');
  }
  // lstat 而非 stat：statSync 会跟随链接，把「指向别处的软链/联结点」当成合法归档
  let archiveStat;
  try {
    archiveStat = fs.lstatSync(archiveDir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new Error('Archive directory not found');
    }
    throw err;
  }
  if (!archiveStat.isDirectory()) throw new Error('Archive directory not found');
  resolveContained(config.backupsDir, archiveDir);

  const indexed = indexedSnapshotPaths();
  if (indexed === null) throw new Error('Backup index unavailable');

  let snapshots = [];
  try {
    snapshots = fs.readdirSync(archiveDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new Error('Archive directory not found');
    throw err;
  }

  let attached = 0;
  let skipped = 0;
  for (const snap of snapshots) {
    const full = path.join(archiveDir, snap.name);
    if (indexed.has(path.resolve(full))) {
      skipped += 1;
      continue;
    }
    const worldName = findSnapshotWorldName(full);
    if (!worldName) {
      skipped += 1;
      continue;
    }
    // 体积走与「创建备份」同一口径（目录树累加）。挂载是管理员显式动作、
    // 每次至多几份快照，遍历成本可接受；statSync(dir).size 只是目录项大小（几 KB），
    // 用它会在列表里显示成「5GB 的备份占 4KB」这种错数据
    let sizeBytes = 0;
    try {
      sizeBytes = await estimateDirSize(full);
    } catch {
      sizeBytes = 0; // 遍历失败（并发删除/权限）：按 0 记账，不阻塞挂载
    }
    try {
      BackupModel.create({
        instanceId,
        name: snap.name,
        description: `挂载自归档 ${archiveId}`,
        type: 'manual',
        size: sizeBytes,
        status: 'completed',
        filePath: full,
        worldName,
        sourceArchiveId: archiveId,
      });
    } catch (err) {
      // 并发下的重复登记被 UNIQUE(file_path) 拦下：另一路已经建好索引，本次按跳过计
      if (!String(err.message).includes('UNIQUE constraint failed')) throw err;
      skipped += 1;
      indexed.add(path.resolve(full));
      continue;
    }
    indexed.add(path.resolve(full));
    attached += 1;
  }

  if (attached > 0) {
    logger.info(`[Archive] 已挂载 ${attached} 份归档快照到实例 ${instanceId}（来源 ${archiveId}）`);
  }
  return { attached, skipped };
}
