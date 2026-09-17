import { z } from 'zod'

export const backupItemSchema = z.object({
  id: z.number(),
  instanceId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  type: z.literal('manual'),
  size: z.number(),
  status: z.enum(['completed', 'failed', 'creating', 'restoring']),
  worldName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** 创建备份请求体（服务端缺省 name/description，故均可选） */
export const backupCreateRequestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
})

/**
 * POST /backups/:id/restore 请求契约。
 * confirmName 必须是该备份所属实例的名称（服务端 trim 后全等比对）：恢复会用快照整体
 * 覆盖实例目录，前端弹窗的实例名输入此前是唯一闸门，直连 API 的调用方可无确认覆盖。
 */
export const backupRestoreRequestSchema = z.object({
  confirmName: z.string({ required_error: 'confirmName 必填' }),
})

/**
 * 恢复确认的目标串（服务端校验与前端输入提示的唯一派生口径）。
 * 优先实例名；实例没有名称时退到备份名，备份名也为空再退到备份 id——确认串必须
 * 始终非空：空串天然匹配会让这道闸门空转（与卸载侧空名实例的加固同源问题），
 * 两处各写一份回退链则必然分叉，故放在契约层共用。
 */
export function restoreConfirmTarget(input: {
  instanceName?: string | null
  backupName?: string | null
  backupId: number | string
}): string {
  const instanceName = (input.instanceName ?? '').trim()
  if (instanceName !== '') return instanceName
  const backupName = (input.backupName ?? '').trim()
  if (backupName !== '') return backupName
  return String(input.backupId)
}

export type BackupItem = z.infer<typeof backupItemSchema>
export type BackupCreateRequest = z.infer<typeof backupCreateRequestSchema>
export type BackupRestoreRequest = z.infer<typeof backupRestoreRequestSchema>
