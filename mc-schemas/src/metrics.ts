import { z } from 'zod'

/**
 * 分钟级主机指标（GET /api/v1/metrics；metrics 采样器每 60s 落一行）。
 * captured_at 为 SQLite CURRENT_TIMESTAMP 口径的 UTC「YYYY-MM-DD HH:MM:SS」串
 * （与 audit/command-history 时间口径一致，消费方经 db-time 归一化）。
 */
export const systemMetricSampleSchema = z.object({
  capturedAt: z.string(),
  cpuUsage: z.number().nullable(),
  memoryUsedGb: z.number().nullable(),
  memoryTotalGb: z.number().nullable(),
  memoryPercent: z.number().nullable(),
  playersOnline: z.number(),
})

export const systemMetricsSeriesSchema = z.array(systemMetricSampleSchema)

export type SystemMetricSample = z.infer<typeof systemMetricSampleSchema>
export type SystemMetricsSeries = z.infer<typeof systemMetricsSeriesSchema>
