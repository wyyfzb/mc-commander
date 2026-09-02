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

export type ScheduledTaskType = z.infer<typeof scheduledTaskTypeSchema>
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>
export type TaskCreatePayload = z.infer<typeof taskCreatePayloadSchema>
export type TaskUpdatePayload = z.infer<typeof taskUpdatePayloadSchema>
