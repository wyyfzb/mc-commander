/**
 * 面板自身数据备份（SQLite 在线快照）
 *
 * 面板库（管理员账号/实例配置/审计日志/定时任务/webhook 等）与实例数据
 * 同为灾备对象：实例备份可恢复而面板配置丢失即永久丢失。
 *
 * 快照使用 better-sqlite3 backup API（SQLite online backup，逐页拷贝，
 * 源库可继续读写，WAL 模式安全）；禁止直接复制 db 文件（锁/半写风险）。
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

export function getPanelBackupDir() {
  const dir = path.join(config.backupsDir, 'panel');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 创建面板库快照，返回 { filePath, sizeBytes } */
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
  return { filePath: dest, sizeBytes: fs.statSync(dest).size };
}

/**
 * 面板快照保留清理：数量上限（最旧先删）+ 天数上限。
 * 时间判定用文件 mtime——快照为本机生成文件，无跨机迁移语义，
 * mtime 即创建时刻；优于解析文件名（避免时间格式演化时的兼容负担）。
 * 返回删除数。
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

  let deletedCount = 0;
  for (const f of [...excess, ...expired]) {
    try {
      fs.unlinkSync(path.join(dir, f));
      deletedCount++;
    } catch (e) {
      logger.error(`[PanelBackup] Failed to delete snapshot ${f}:`, e.message);
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
