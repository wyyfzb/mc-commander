import { z } from 'zod'

export const auditLogItemSchema = z.object({
  id: z.number(),
  instanceId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  detail: z.unknown().optional(),
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

// ── 请求侧契约（issue 391：路由层 zod 契约统一）──

/**
 * GET /audit-logs 查询契约。
 * - order：仅 asc/desc；缺省/非法回落 desc（issue 383 明确的向后兼容语义，
 *   catch 表达，不升级为 400）。
 * - page/pageSize：分页参数，按 issue 391 边界保持 #392 parsePagination
 *   既有解析不动，schema 仅作字符串透传避免归一化剥离。
 */
export const auditLogsQuerySchema = z.object({
  instanceId: z.string().optional(),
  action: z.string().optional(),
  targetType: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  source: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc').catch('desc'),
  page: z.string().optional(),
  pageSize: z.string().optional(),
})

/** GET /command-history 查询契约（page/pageSize 同上透传） */
export const commandHistoryQuerySchema = z.object({
  instanceId: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  source: z.string().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
})
