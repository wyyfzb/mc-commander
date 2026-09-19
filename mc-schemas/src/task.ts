import { z } from 'zod'

export const scheduledTaskTypeSchema = z.enum(['restart', 'backup', 'command', 'stop', 'start'])

export const scheduledTaskSchema = z.object({
  id: z.number(),
  instanceId: z.string().nullable(),
  name: z.string(),
  type: scheduledTaskTypeSchema,
  cronExpression: z.string(),
  command: z.string().nullable(),
  isEnabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(['never', 'success', 'failed', 'skipped']),
  lastRunError: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const taskCreatePayloadSchema = z.object({
  name: z.string(),
  type: scheduledTaskTypeSchema,
  cronExpression: z.string(),
  command: z.string().nullable().optional(),
  isEnabled: z.boolean().optional(),
})

export const taskUpdatePayloadSchema = taskCreatePayloadSchema.partial()

/** 单次执行历史状态（不含 never：历史表只落真实执行结果） */
export const taskRunStatusSchema = z.enum(['success', 'failed', 'skipped'])

/** 定时任务执行历史行（task_run_history 表，append-only + 每任务保留上限） */
export const taskRunHistorySchema = z.object({
  id: z.number(),
  taskId: z.number(),
  runAt: z.string(),
  status: taskRunStatusSchema,
  error: z.string().nullable(),
  durationMs: z.number().nullable(),
})

export type ScheduledTaskType = z.infer<typeof scheduledTaskTypeSchema>
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>
export type TaskCreatePayload = z.infer<typeof taskCreatePayloadSchema>
export type TaskUpdatePayload = z.infer<typeof taskUpdatePayloadSchema>
export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>
export type TaskRunHistory = z.infer<typeof taskRunHistorySchema>

/** 执行历史列表（GET /tasks/:id/history：服务端限量的最近记录，非分页信封） */
export const taskRunHistoryListSchema = z.array(taskRunHistorySchema)
export type TaskRunHistoryList = z.infer<typeof taskRunHistoryListSchema>
