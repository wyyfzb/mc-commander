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

export const upgradeRequestSchema = z.object({
  mcVersion: z.string(),
  type: z.enum(['vanilla', 'paper', 'purpur']).optional(),
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