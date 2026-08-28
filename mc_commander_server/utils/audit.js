import { AuditLogModel } from '../db/index.js';

export const AuditActions = {
  INSTANCE_START: 'INSTANCE_START',
  INSTANCE_STOP: 'INSTANCE_STOP',
  INSTANCE_RESTART: 'INSTANCE_RESTART',
  INSTANCE_DELETE: 'INSTANCE_DELETE',
  BACKUP_CREATE: 'BACKUP_CREATE',
  BACKUP_RESTORE: 'BACKUP_RESTORE',
  BACKUP_DELETE: 'BACKUP_DELETE',
  PLAYER_OP: 'PLAYER_OP',
  PLAYER_DEOP: 'PLAYER_DEOP',
  PLAYER_KICK: 'PLAYER_KICK',
  PLAYER_BAN: 'PLAYER_BAN',
  PLAYER_PARDON: 'PLAYER_PARDON',
  PLAYER_WHITELIST: 'PLAYER_WHITELIST',
  TASK_CREATE: 'TASK_CREATE',
  TASK_UPDATE: 'TASK_UPDATE',
  TASK_DELETE: 'TASK_DELETE',
  TASK_EXECUTE: 'TASK_EXECUTE',
  KEY_ROTATE: 'KEY_ROTATE',
  WEBHOOK_CREATE: 'WEBHOOK_CREATE',
  WEBHOOK_UPDATE: 'WEBHOOK_UPDATE',
  WEBHOOK_DELETE: 'WEBHOOK_DELETE',
  WEBHOOK_TEST: 'WEBHOOK_TEST',
};

/**
 * 记录审计日志。异常仅 warn 不抛出，绝不阻塞业务流程。
 */
export function recordAudit({ instanceId, action, targetType, targetId, detail, source } = {}) {
  try {
    AuditLogModel.create({
      instanceId,
      action,
      targetType: targetType || null,
      targetId: targetId || null,
      detail: detail || null,
      source: source || 'api',
    });
  } catch (err) {
    console.warn(`[Audit] Failed to record audit log (${action}):`, err.message);
  }
}
