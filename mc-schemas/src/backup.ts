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
  format: z.enum(['snapshot', 'zip']),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** 创建备份请求体（服务端缺省 name/description，故均可选） */
export const backupCreateRequestSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
})

export type BackupItem = z.infer<typeof backupItemSchema>
export type BackupCreateRequest = z.infer<typeof backupCreateRequestSchema>
