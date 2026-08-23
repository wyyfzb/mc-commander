import { Router } from 'express';
import { success, successPaginated, ErrorCodes, AppError } from '../utils/response.js';
import { BackupModel } from '../db/backup.model.js';
import { BackupService } from '../services/backup.service.js';
import config from '../config.js';

// async 路由包装：Express 4 不捕获中间件/路由返回的 Promise rejection。
// 未包装的 async handler 抛错时请求永久挂起 + unhandledRejection
// （Node 默认 throw 使进程崩溃），包装后将错误传递给全局 errorHandler 统一处理。
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

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

  // find-021：列表响应数据来自模型层显式列查询（不含 file_path 本地路径）
  router.get('/instances/:instanceId/backups', asyncHandler(async (req, res) => {
    const { instanceId } = req.params;
    let page = parseInt(req.query.page) || 1;
    let pageSize = parseInt(req.query.pageSize) || 20;
    page = Math.max(1, Math.min(page, 1000));
    pageSize = Math.max(1, Math.min(pageSize, 100));
    const type = req.query.type;
    const status = req.query.status;

    const result = BackupModel.findAll({
      instanceId,
      page,
      pageSize,
      type,
      status
    });

    res.json(successPaginated(result.backups, result.total, page, pageSize));
  }));

  // find-021：详情响应不含 file_path（模型层显式列查询）
  router.get('/backups/:id', asyncHandler(async (req, res) => {
    const backup = BackupModel.findById(req.params.id);

    if (!backup) {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
    }

    res.json(success(backup));
  }));

  router.post('/instances/:instanceId/backups', asyncHandler(async (req, res) => {
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
      name: name || `Backup_${new Date().toISOString().slice(0, 10)}`,
      description: description || '',
      type: 'manual',
    });

    res.status(201).json(success(backup, 'Backup created successfully'));
  }));

  router.post('/backups/:id/restore', asyncHandler(async (req, res) => {
    const backup = BackupModel.findById(req.params.id);

    if (!backup) {
      throw new AppError(ErrorCodes.BACKUP_NOT_FOUND);
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
    const instance = serverManager.getInstance(backup.instanceId);
    if (instance?.isRunning) {
      throw new AppError(ErrorCodes.INSTANCE_RUNNING, '实例正在运行，请先停止服务器再恢复备份');
    }

    // restoreBackup 同步段完成校验与 status='restoring' 互斥锁置位后
    // 快速返回（恢复实际在后台执行，进度经 restoreStart/restoreComplete/
    // restoreFailed 事件推送）——大世界解压不再受客户端 10s 超时误杀
    await backupService.restoreBackup(req.params.id);

    res.status(202).json(success(null, 'Restore started'));
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

    await backupService.deleteBackup(req.params.id);
    res.json(success(null, 'Backup deleted successfully'));
  }));

  return router;
}

export default createBackupRoutes;
