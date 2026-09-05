import { z } from 'zod'

export const diskInfoSchema = z.object({
  mountpoint: z.string(),
  totalGB: z.number(),
  usedGB: z.number(),
  percent: z.number(),
})

export const diskUsageSchema = z.object({
  primary: diskInfoSchema.nullable(),
  all: z.array(diskInfoSchema),
})

export const systemStatsSchema = z.object({
  cpuUsage: z.number(),
  memoryUsage: z.number(),
  totalMemory: z.number(),
  memoryPercent: z.number(),
  cpuCores: z.number(),
  loadAvg: z.array(z.number()),
  uptime: z.number(),
  diskUsage: diskUsageSchema.optional(),
})

export const updateCheckResultSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  hasUpdate: z.boolean(),
  offline: z.boolean().optional(),
  url: z.string().optional(),
})

export type DiskInfo = z.infer<typeof diskInfoSchema>
export type DiskUsage = z.infer<typeof diskUsageSchema>
export type SystemStats = z.infer<typeof systemStatsSchema>
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>
