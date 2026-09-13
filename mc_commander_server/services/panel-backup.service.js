/**
 * 面板自身数据备份（SQLite 在线快照 + .env 伴生副本）
 *
 * 面板库（管理员账号/实例配置/审计日志/定时任务/webhook 等）与实例数据
 * 同为灾备对象：实例备份可恢复而面板配置丢失即永久丢失。
 *
 * 快照使用 better-sqlite3 backup API（SQLite online backup，逐页拷贝，
 * 源库可继续读写，WAL 模式安全）；禁止直接复制 db 文件（锁/半写风险）。
 *
 * .env（API_KEY_HASH/SETUP_TOKEN 等）不入面板库、实例备份也不覆盖它，
 * 单独随每个快照作伴生副本（同名 .env 后缀）落 backups/panel/——恢复点
 * = db + .env 对，缺 .env 则管理员无法重新接入面板。.env 不存在（纯
 * 环境变量部署）时跳过副本，属合法形态。副本随快照同生命周期清理
 * （数量/天数上限联动），孤儿副本（快照已被手工删除）一并清扫。
 * 注意：恢复到含历史 SETUP_TOKEN 的旧副本时（token 现行已被作废移除），
 * 配对 db 处于未设密态会重新进入 setup 待认领态——恢复后应完成设密或
 * 手工移除该行；token 仅存本机磁盘，知情面为管理员本人。
 *
 * 快照为独立 .db 文件落 backups/panel/，与实例备份（backups/{instanceId}/）
 * 命名空间区分；不入 backups 表（instance_id NOT NULL 外键，面板快照无
 * 实例归属），保留策略直接按文件管理，语义与实例备份一致（数量 + 天数双上限）。
 */
import fs from 'fs';
import path from 'path';
import config from '../config.js';
import { getDb } from '../db/index.js';
import { logger } from '../utils/logger.js';

// 快照文件名：panel-<ISO 时间戳（:/. → -）>.db；仅识别该命名，
// 清理不会误伤目录内可能存在的人工放置文件
const SNAPSHOT_NAME_REGEX = /^panel-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;
// .env 伴生副本与快照同名（.db → .env），命名空间同样收归本服务管理
const SIDECAR_NAME_REGEX = /^panel-\d{4}-\d{2}-\d{2}T[\d-]+Z\.env$/;

export function getPanelBackupDir() {
  const dir = path.join(config.backupsDir, 'panel');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 最新快照的创建时刻（mtime，毫秒）；目录无快照返回 null。
 * 调度器停机补跑用它作基线：cron 触发不留记录，mtime 即那次触发产出
 * 文件的时刻——与用户任务 last_run_at 的「已消费时刻」语义一致。
 */
export function getLatestSnapshotTime() {
  const dir = getPanelBackupDir();
  const mtimes = fs.readdirSync(dir)
    .filter((f) => SNAPSHOT_NAME_REGEX.test(f))
    .map((f) => fs.statSync(path.join(dir, f)).mtimeMs);
  return mtimes.length ? Math.max(...mtimes) : null;
}

/** 快照文件路径 → .env 伴生副本路径（同生命周期的配对约定） */
function envSidecarPath(snapshotPath) {
  return snapshotPath.replace(/\.db$/, '.env');
}

/** 创建面板库快照（含 .env 伴生副本），返回 { filePath, sizeBytes, envFilePath } */
export async function createPanelSnapshot() {
  const dest = path.join(
    getPanelBackupDir(),
    `panel-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
  );
  try {
    await getDb().backup(dest);
  } catch (e) {
    // backup 中途失败可能遗留半写目标文件，不留存（否则被保留清理
    // 误认为有效快照）；目标不存在时 unlink 报错可忽略
    try { fs.unlinkSync(dest); } catch { /* 目标未创建 */ }
    throw e;
  }

  // .env 伴生副本：存在即必须复制成功（副本缺失 = 恢复点不完整），失败则
  // 连同快照一并回滚，避免留下「有 db 无 env」的残缺恢复点；.env 不存在
  // （纯环境变量部署）为合法形态，跳过即可。envFilePath 缺省（测试 mock
  // 的最小 config 形态）视同不存在
  let envFilePath = null;
  if (config.envFilePath && fs.existsSync(config.envFilePath)) {
    envFilePath = envSidecarPath(dest);
    try {
      fs.copyFileSync(config.envFilePath, envFilePath);
      // 权限镜像源 .env（部署脚本/写回流程均维持 0600）：copyFileSync 落盘默认
      // 权限（Linux 0644）会让副本对组/其他可读，低于源文件的凭据纪律
      fs.chmodSync(envFilePath, fs.statSync(config.envFilePath).mode & 0o777);
    } catch (e) {
      // 快照清理失败会让残缺「有 db 无 env」快照以有效身份存活至保留期，
      // 静默不可接受，记 error 与 cleanup 删除失败同口径
      try { fs.unlinkSync(dest); } catch (cleanupErr) {
        logger.error(`[PanelBackup] Failed to roll back snapshot after env copy failure: ${dest}`, cleanupErr.message);
      }
      try { fs.unlinkSync(envFilePath); } catch { /* 半写副本清理失败不掩盖原错误；残件由孤儿清扫兜住 */ }
      throw e;
    }
  }
  return { filePath: dest, sizeBytes: fs.statSync(dest).size, envFilePath };
}

/**
 * 面板快照保留清理：数量上限（最旧先删）+ 天数上限。
 * 时间判定用文件 mtime——快照为本机生成文件，无跨机迁移语义，
 * mtime 即创建时刻；优于解析文件名（避免时间格式演化时的兼容负担）。
 * .env 伴生副本随其快照同生命周期删除；快照已被手工删除的孤儿副本一并清扫。
 * 返回删除的快照数（副本不计入）。
 */
export function cleanupPanelSnapshots(options = {}) {
  const maxBackups = options.maxBackups ?? config.panelBackup.retention.maxBackups;
  const maxAgeDays = options.maxAgeDays ?? config.panelBackup.retention.maxAgeDays;

  const dir = getPanelBackupDir();
  const files = fs.readdirSync(dir)
    .filter((f) => SNAPSHOT_NAME_REGEX.test(f))
    .sort(); // 文件名内嵌定长 ISO 时间戳，字典序即时间序

  const cutoffMs = Date.now() - maxAgeDays * 86_400_000;
  const excess = files.length > maxBackups
    ? files.slice(0, files.length - maxBackups)
    : [];
  const kept = files.slice(excess.length);
  const expired = kept.filter(
    (f) => fs.statSync(path.join(dir, f)).mtimeMs < cutoffMs,
  );

  const removedSnapshots = new Set([...excess, ...expired]);
  let deletedCount = 0;
  for (const f of removedSnapshots) {
    try {
      fs.unlinkSync(path.join(dir, f));
      deletedCount++;
    } catch (e) {
      logger.error(`[PanelBackup] Failed to delete snapshot ${f}:`, e.message);
    }
    // 副本与快照必须同去留：快照已删则副本不留（成为无人认领的孤儿）
    try { fs.unlinkSync(envSidecarPath(path.join(dir, f))); } catch { /* 无副本 */ }
  }

  // 孤儿副本清扫：快照已被手工删除（不误会伤人工放置的非命名空间文件）
  for (const f of fs.readdirSync(dir)) {
    if (SIDECAR_NAME_REGEX.test(f)) {
      const snapshot = path.join(dir, f.replace(/\.env$/, '.db'));
      if (!fs.existsSync(snapshot)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) {
          logger.error(`[PanelBackup] Failed to delete orphan env sidecar ${f}:`, e.message);
        }
      }
    }
  }
  return deletedCount;
}

/** 一次完整快照周期（快照 + 保留清理）；错误向上抛，由调用方兜底 */
export async function runPanelBackupCycle() {
  const snapshot = await createPanelSnapshot();
  const deletedCount = cleanupPanelSnapshots();
  return { ...snapshot, deletedCount };
}
