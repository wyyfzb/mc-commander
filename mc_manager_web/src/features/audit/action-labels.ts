/**
 * 审计操作类型标签表 —— audit-page 与 audit-export 共用
 * （独立模块避免页面 ↔ 导出工具循环依赖）
 */
export const ACTION_LABELS: Record<string, string> = {
  INSTANCE_CREATE: '创建实例',
  INSTANCE_UPDATE: '更新实例配置',
  INSTANCE_START: '启动实例',
  INSTANCE_STOP: '停止实例',
  INSTANCE_RESTART: '重启实例',
  INSTANCE_DELETE: '删除实例',
  CONFIG_CHANGE: '配置修改',
  BACKUP_CREATE: '创建备份',
  BACKUP_RESTORE: '恢复备份',
  BACKUP_DELETE: '删除备份',
  PLAYER_OP: '授权管理员',
  PLAYER_DEOP: '撤销管理员',
  PLAYER_KICK: '踢出玩家',
  PLAYER_BAN: '封禁玩家',
  PLAYER_PARDON: '解封玩家',
  PLAYER_WHITELIST: '白名单操作',
  TASK_CREATE: '创建任务',
  TASK_UPDATE: '更新任务',
  TASK_DELETE: '删除任务',
  TASK_EXECUTE: '执行任务',
  KEY_ROTATE: '密钥轮换',
}

export function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}
