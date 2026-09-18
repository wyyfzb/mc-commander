import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { ErrorCodes, AppError } from '../utils/response.js';
import { parsePagination } from '../utils/pagination.js';
import { localDateKey } from '../utils/local-date.js';
import { BackupModel } from '../db/backup.model.js';
import { BackupService, resolveContained } from '../services/backup.service.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import config from '../config.js';
import {
  archivedSnapshotListSchema,
  backupAttachRequestSchema,
  backupAttachResponseSchema,
  backupCreateRequestSchema,
  backupItemSchema,
  backupRestoreRequestSchema,
  restoreConfirmTarget,
  nullDataSchema,
} from '@mc-commander/schemas';
import { attachArchivedSnapshots, listArchivedSnapshots } from '../services/backup-snapshot.service.js';
import { validateBody, validatedSuccess, validatedSuccessPaginated } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../utils/logger.js';

// 进行中操作互斥检查（restoring 状态机）：同实例存在 creating（备份中）
// 或 restoring（恢复中）记录时返回 true。创建/恢复/删除三入口统一口径；
// 卡死恢复先行（崩溃残留记录超时重置），确保路由 409 前卡死记录已自愈
function hasInProgressBackup(instanceId) {
  BackupModel.resetStaleInProgress({
    maxAgeMs: config.backupInProgressTimeoutMs,
    instanceId,
  });
  return (
    BackupModel.findAll({ instanceId, status: 'creating' }).total > 0 ||
    BackupModel.findAll({ instanceId, status: 'restoring' }).total > 0
  );
}

export function createBackupRoutes(serverManager) {
  const router = Router({ mergeParams: true });
  const backupService = new BackupService(serverManager);

  // 列表响应数据来自模型层显式列查询（不含 file_path 本地路径）
  router.get('/instances/:instanceId/backups', asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    const { page, pageSize } = parsePagination(req.query, { maxPageSize: 100 });
    const type = req.query.type;
    const status = req.query.status;

    const result = BackupModel.findAll({
      instanceId,
      page,
      pageSize,
      type,
      status
    });

    res.json(validatedSuccessPaginated(backupItemSchema, result.backups, result.total, page, pageSize));
  }));

  // GET /backups/archived —— 归档快照清点
  //
  // 卸载实例会删掉备份表记录、但快照目录按设计留在 backupsDir/<原实例 id>/：
  // 此后它们既不出现在任何实例的备份列表里，又会随保留期孤儿清扫被删。本端点把
  // 「磁盘上有、索引里没有」的那部分清点出来，供设置页展示与挂载。
  // 只读快照目录名与计数，不下发磁盘路径（与列表/详情口径一致，不暴露 file_path）。
  router.get('/backups/archived', asyncHandler(async (req, res) => {
    res.json(validatedSuccess(archivedSnapshotListSchema, listArchivedSnapshots()));
  }));

  // POST /instances/:instanceId/backups/attach —— 把归档快照挂载到目标实例
  //
  // 只登记索引、不复制不移动磁盘内容：挂载后这些快照走常规路径（列表/恢复/下载/删除）。
  // 幂等：已在索引中的快照计 skipped，重复点击不会插重复行。
  router.post('/instances/:instanceId/backups/attach', validateBody(backupAttachRequestSchema), asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    const { archiveId } = req.body;

    const instance = serverManager.getInstance(instanceId);
    if (!instance) {
      throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
    }

    let result;
    try {
      result = await attachArchivedSnapshots(instanceId, archiveId);
    } catch (err) {
      if (err.message === 'Archive directory not found') {
        throw new AppError(ErrorCodes.BACKUP_NOT_FOUND, '归档目录不存在（可能已被清理）');
      }
      if (err.message === 'Invalid archive id' || err.message === 'Archive directory escapes backups dir') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '归档标识不合法');
      }
      // 索引不可读＝服务端依赖故障，不是客户端请求问题：503 而非 500 泛化
      if (err.message === 'Backup index unavailable') {
        throw new AppError(ErrorCodes.BACKUP_INDEX_UNAVAILABLE);
      }
      throw err;
    }

    if (result.attached > 0) {
      recordAudit({
        instanceId,
        action: AuditActions.BACKUP_CREATE,
        targetType: 'backup_archive',
        targetId: archiveId,
        detail: { attached: result.attached, skipped: result.skipped },
      });
    }

    const message = result.attached > 0
      ? `已挂载 ${result.attached} 份归档快照${result.skipped > 0 ? `（跳过 ${result.skipped} 份：已挂载过或无法识别）` : ''}`
      : '没有可挂载的快照：它们已挂载过，或目录里没有可识别的世界数据';
    res.json(validatedSuccess(backupAttachResponseSchema, result, message));
  }));

  // 详情响应不含 file_path（模型层显式列查询）
  router.get('/backups/:id', asyncHandler(async (req, res) => {
    const backup = BackupModel.findById(req.params.id);

    if (!backup) {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }

    res.json(validatedSuccess(backupItemSchema, backup));
  }));

  router.post('/instances/:instanceId/backups', validateBody(backupCreateRequestSchema), asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    const { name, description } = req.body;

    const instance = serverManager.getInstance(instanceId);
    if (!instance) {
      throw new AppError(ErrorCodes.INSTANCE_NOT_FOUND);
    }

    // 互斥（restoring 状态机）：备份中/恢复中都拒绝新备份
    if (hasInProgressBackup(instanceId)) {
      throw new AppError(ErrorCodes.BACKUP_IN_PROGRESS);
    }

    const backup = await backupService.createBackup(instanceId, {
      // 默认名用服务器本地日期（与列表按本地时区渲染 createdAt 同口径，见 utils/local-date.js）
      name: name || `Backup_${localDateKey()}`,
      description: description || '',
      type: 'manual',
    });

    recordAudit({ instanceId, action: AuditActions.BACKUP_CREATE, targetType: 'backup', targetId: String(backup.id) });
    res.status(201).json(validatedSuccess(backupItemSchema, backup, 'Backup created successfully'));
  }));

  router.post('/backups/:id/restore', validateBody(backupRestoreRequestSchema), asyncHandler(async (req, res) => {
    const backup = BackupModel.findById(req.params.id);

    if (!backup) {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }

    // 确认串校验（服务端强制）：UI 的输入框只存在于客户端，直连 API 的调用方此前可
    // 跳过确认直接覆盖实例目录。确认目标是「实例名」，实例无名称时退到备份名/id
    // （restoreConfirmTarget 单一派生）——空名实例下实例名确认会空转（空串天然匹配），
    // 与卸载侧空名实例的加固同源。两侧 trim 后全等比对，文案不回显确认目标
    const instance = serverManager.getInstance(backup.instanceId);
    const expectedConfirm = restoreConfirmTarget({
      instanceName: instance?.name,
      backupName: backup.name,
      backupId: backup.id,
    });
    if (req.body.confirmName.trim() !== expectedConfirm) {
      throw new AppError(ErrorCodes.BACKUP_RESTORE_CONFIRM_REQUIRED);
    }

    if (backup.status !== 'completed') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Only completed backups can be restored');
    }

    // 互斥（restoring 状态机）：同实例备份中/恢复中拒绝新的恢复
    // （服务层 restoreBackup 亦有同款兜底检查，此处快速失败）
    if (hasInProgressBackup(backup.instanceId)) {
      throw new AppError(ErrorCodes.RESTORE_IN_PROGRESS);
    }

    // 运行中恢复会把正在被 MC 写入的世界目录 rename/覆盖（Windows 上
    // 还会因文件占用 EPERM 失败），导致世界数据损坏——入口拦截提示先停止
    if (instance?.isRunning) {
      throw new AppError(ErrorCodes.INSTANCE_RUNNING, '实例正在运行，请先停止服务器再恢复备份');
    }

    // restoreBackup 同步段完成校验与 status='restoring' 互斥锁置位后
    // 快速返回（恢复实际在后台执行，进度经 restoreStart/restoreComplete/
    // restoreFailed 事件推送）——大世界解压不再受客户端 10s 超时误杀
    recordAudit({ instanceId: backup.instanceId, action: AuditActions.BACKUP_RESTORE, targetType: 'backup', targetId: req.params.id });
    await backupService.restoreBackup(req.params.id);

    res.status(202).json(validatedSuccess(nullDataSchema, null, 'Restore started'));
  }));

  router.delete('/backups/:id', asyncHandler(async (req, res) => {
    const backup = BackupModel.findById(req.params.id);

    if (!backup) {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }

    // 互斥（restoring 状态机）：备份中/恢复中的备份不可删除
    // （删除会与恢复并发竞争备份文件）
    if (backup.status === 'creating' || backup.status === 'restoring') {
      throw new AppError(ErrorCodes.BACKUP_IN_PROGRESS);
    }

    recordAudit({ instanceId: backup.instanceId, action: AuditActions.BACKUP_DELETE, targetType: 'backup', targetId: req.params.id });
    await backupService.deleteBackup(req.params.id);
    res.json(validatedSuccess(nullDataSchema, null, 'Backup deleted successfully'));
  }));

  // feat-1: 备份下载（流式 tar.gz）
  // 安全链：findByIdWithPath（不泄露 file_path）→ resolveContained（目录包含 + symlink 复检）→
  // spawn 数组参数（无 shell 注入）→ 仅 completed 可下载
  router.get('/backups/:id/download', asyncHandler(async (req, res) => {
    const backup = BackupModel.findByIdWithPath(req.params.id);
    if (!backup) {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }
    if (backup.status !== 'completed') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR);
    }
    // 路径安全：resolveContained 会 realpath 复检 symlink 逃逸。
    // 记录必须带非空字符串路径——file_path 为 null 时 path.resolve 会抛
    // ERR_INVALID_ARG_TYPE（500），空串则被解析成 cwd 绕过包含校验
    const rawPath = backup.file_path;
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }
    const resolvedDir = resolveContained(config.backupsDir, rawPath);
    // 下载链路的 tar 以「目录」为目标（tar -C <dir>）：必须先确认是目录。
    // 目标为文件时 tar 退出码非 0 且 stdout 为空，但响应头已发 ⇒ 客户端拿到
    // 200 + 0 字节空档，无法与有效备份区分
    let snapshotStat;
    try {
      snapshotStat = fs.statSync(resolvedDir);
    } catch {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }
    if (!snapshotStat.isDirectory()) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR);
    }
    const dirName = path.basename(resolvedDir);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', contentDisposition(dirName));
    const tar = spawn('tar', ['-czf', '-', '-C', resolvedDir, '.']);
    tar.stdout.pipe(res);
    tar.stderr.on('data', (d) => logger.warn('[backup-download] tar stderr:', d.toString()));
    tar.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ status: 'error', code: 50000, message: err.message });
      else res.destroy();
    });
  }));

  return router;
}

/** RFC 5987 Content-Disposition：中文文件名 URL 编码 + ASCII 回退 */
function contentDisposition(filename) {
  const encoded = encodeURIComponent(filename).replace(/'/g, "'%27");
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export default createBackupRoutes;
