/**
 * 审计操作类型标签表 —— audit-page 与 audit-export 共用
 * （独立模块避免页面 ↔ 导出工具循环依赖）
 */

/** 操作域分组（筛选下拉按域聚簇，组序=数组序） */
export const ACTION_GROUPS = [
  { group: '实例', actions: ['INSTANCE_CREATE', 'INSTANCE_UPDATE', 'INSTANCE_START', 'INSTANCE_STOP', 'INSTANCE_RESTART', 'INSTANCE_DELETE'] },
  { group: '配置', actions: ['CONFIG_CHANGE'] },
  { group: '备份', actions: ['BACKUP_CREATE', 'BACKUP_RESTORE', 'BACKUP_DELETE', 'BACKUP_CANCEL'] },
  { group: '玩家', actions: ['PLAYER_OP', 'PLAYER_DEOP', 'PLAYER_KICK', 'PLAYER_BAN', 'PLAYER_PARDON', 'PLAYER_WHITELIST'] },
  { group: '任务', actions: ['TASK_CREATE', 'TASK_UPDATE', 'TASK_DELETE', 'TASK_EXECUTE'] },
  { group: '密钥', actions: ['KEY_ROTATE'] },
] as const

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
  BACKUP_CANCEL: '取消备份/恢复',
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

/** 平铺分组选项（FilterSelect 消费：value/label/group；label 缺省回退 action 原文） */
export function actionFilterOptions(): { value: string; label: string; group: string }[] {
  return ACTION_GROUPS.flatMap(({ group, actions }) =>
    actions.map((action) => ({ value: action, label: ACTION_LABELS[action] ?? action, group })),
  )
}

export function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}
