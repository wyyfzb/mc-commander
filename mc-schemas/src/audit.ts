import { z } from 'zod'

export const auditLogItemSchema = z.object({
  id: z.number(),
  instanceId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  detail: z.unknown(),
  source: z.string(),
  createdAt: z.string(),
})

export const commandHistoryItemSchema = z.object({
  id: z.number(),
  instanceId: z.string().nullable(),
  command: z.string(),
  source: z.string(),
  success: z.boolean(),
  response: z.string().nullable(),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
})

export type AuditLogItem = z.infer<typeof auditLogItemSchema>
export type CommandHistoryItem = z.infer<typeof commandHistoryItemSchema>