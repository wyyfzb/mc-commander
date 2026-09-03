import { z } from 'zod'

export const versionsResponseSchema = z.object({
  type: z.string(),
  versions: z.array(z.string()),
  loaders: z.array(z.string()).optional(),
})

export const deployRequestSchema = z.object({
  type: z.enum(['vanilla', 'paper', 'fabric', 'forge', 'purpur']),
  mcVersion: z.string(),
  instanceName: z.string(),
  maxMemory: z.string().optional(),
  loaderVersion: z.string().optional(),
})

export const deployResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  mcVersion: z.string(),
  javaVersion: z.string(),
  path: z.string(),
  maxMemory: z.string(),
})

export const deployProgressSchema = z.object({
  stage: z.string(),
  percent: z.number(),
  transferred: z.number(),
  total: z.number(),
  error: z.string().optional(),
  // 实例归属（WS 连接补发恢复显示与通知文案所需）：部署实例完成前未入库，
  // 事件走全局广播，归属由 payload 携带而非信封 instanceId
  instanceId: z.string().optional(),
  instanceName: z.string().optional(),
  type: z.string().optional(),
  mcVersion: z.string().optional(),
})

export const upgradeStageSchema = z.enum([
  'backup', 'download', 'replace', 'verify', 'completed', 'failed', 'rolled_back',
])

export const upgradeProgressSchema = z.object({
  instanceId: z.string(),
  stage: upgradeStageSchema,
  percent: z.number(),
  detail: z.string(),
  timestamp: z.number(),
})

/**
 * POST /instances/:id/upgrade 请求体契约（issue 391 接入路由层）。
 * - mcVersion 缺省消息保留原路由文案；点分版本白名单（MC_VERSION_REGEX）
 *   属服务层纵深防御口径，保持在路由/服务层校验，schema 只做类型与必填。
 * - type 枚举错误消息保留原路由 'Invalid type' 文案（errorMap 保留既有
 *   断言与前端提示兼容），缺省归一为 vanilla（与原解构默认值一致）。
 */
export const upgradeRequestSchema = z.object({
  mcVersion: z.string({ required_error: 'mcVersion is required' }),
  type: z
    .enum(['vanilla', 'paper', 'purpur'], {
      errorMap: () => ({
        message: 'Invalid type. Must be one of: vanilla, paper, purpur',
      }),
    })
    .default('vanilla'),
})

export const upgradeStartResponseSchema = z.object({
  message: z.string(),
  instanceId: z.string(),
  mcVersion: z.string(),
  type: z.string(),
})

export type VersionsResponse = z.infer<typeof versionsResponseSchema>
export type DeployRequest = z.infer<typeof deployRequestSchema>
export type DeployResult = z.infer<typeof deployResultSchema>
export type DeployProgress = z.infer<typeof deployProgressSchema>
export type UpgradeStage = z.infer<typeof upgradeStageSchema>
export type UpgradeProgress = z.infer<typeof upgradeProgressSchema>
export type UpgradeRequest = z.infer<typeof upgradeRequestSchema>
export type UpgradeStartResponse = z.infer<typeof upgradeStartResponseSchema>