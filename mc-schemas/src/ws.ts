import { z } from 'zod'

export const WS_EVENT_TYPES = [
  'log',
  'status',
  'tpsUpdate',
  'performanceUpdate',
  'weatherUpdate',
  'playerStatsUpdate',
  'playerJoin',
  'playerLeave',
  'playerDeath',
  'playerRespawn',
  'playerChat',
  'playerSleep',
  'achievement',
  'backupStart',
  'backupProgress',
  'backupComplete',
  'backupFailed',
  'backupSkipped',
  'backupCancelled',
  'restoreStart',
  'restoreProgress',
  'restoreComplete',
  'restoreFailed',
  'restoreCancelled',
  'taskExecute',
  'taskFailed',
  'webhookDeliveryFailed',
  'deployProgress',
  'deployComplete',
  'deployFailed',
  'deployCancelled',
  'circuit_breaker',
  'upgradeProgress',
  'upgradeComplete',
  'upgradeFailed',
  'upgradeCancelled',
  'systemStatsUpdate',
  'error',
] as const

export const wsEventTypeSchema = z.enum(WS_EVENT_TYPES)

export const wsMessageSchema = z.object({
  // 'auth'：首帧鉴权回执（服务端 → 客户端 {type:'auth', ok:true}），H2-4b
  type: z.union([wsEventTypeSchema, z.literal('pong'), z.literal('auth')]),
  ok: z.boolean().optional(),
  eventId: z.number().optional(),
  instanceId: z.string().optional(),
  data: z.unknown().optional(),
  timestamp: z.number().optional(),
})

export const wsStatusSnapshotSchema = z.object({
  status: z.string(),
  isRunning: z.boolean(),
  players: z.array(z.unknown()),
  tps: z.number().nullable(),
})

export const wsPerformancePayloadSchema = z.object({
  cpu: z.number(),
  memory: z.number(),
  tps: z.number(),
  mspt: z.number(),
  worldTime: z.number().nullable(),
  worldDay: z.number().nullable(),
  sleepingPlayers: z.number(),
  sleepingPlayerNames: z.array(z.string()),
  awakePlayerNames: z.array(z.string()),
})

export const wsLogPayloadSchema = z.object({
  text: z.string(),
  type: z.enum(['stdout', 'stderr', 'command']),
})

export const wsStatusEventPayloadSchema = z.object({
  event: z.enum(['started', 'stopped', 'ready', 'crash', 'save', 'circuit_breaker']),
  code: z.number().nullable().optional(),
  autoRestart: z.boolean().optional(),
  consecutiveCrashes: z.number().optional(),
  windowMs: z.number().optional(),
})

export const wsPlayerEventPayloadSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  cause: z.string().optional(),
  advancement: z.string().optional(),
  isChallenge: z.boolean().optional(),
  sleeping: z.boolean().optional(),
})

export const wsWeatherPayloadSchema = z.object({
  weather: z.enum(['clear', 'rain', 'thunder']),
})

export const wsBackupPayloadSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
  })
  .passthrough()

/** 备份/恢复进度（rsync --info=progress2 解析，服务端 1s 节流；robocopy/ditto 降级路径无进度） */
export const wsBackupProgressPayloadSchema = z.object({
  backupId: z.number(),
  percent: z.number().min(0).max(100),
})

/** 通知类事件集合（服务端落库，断线补齐用） */
export const NOTIFICATION_EVENT_TYPES: ReadonlySet<WsEventType> = new Set([
  'playerJoin',
  'playerLeave',
  'playerDeath',
  'playerRespawn',
  'playerChat',
  'playerSleep',
  'achievement',
  'backupStart',
  'backupComplete',
  'backupFailed',
  'backupSkipped',
  'backupCancelled',
  'restoreStart',
  'restoreComplete',
  'restoreFailed',
  'restoreCancelled',
  'taskFailed',
  'webhookDeliveryFailed',
])

export type WsEventType = (typeof WS_EVENT_TYPES)[number]
export type WsMessage = z.infer<typeof wsMessageSchema>
export type WsStatusSnapshot = z.infer<typeof wsStatusSnapshotSchema>
export type WsPerformancePayload = z.infer<typeof wsPerformancePayloadSchema>
export type WsLogPayload = z.infer<typeof wsLogPayloadSchema>
export type WsStatusEventPayload = z.infer<typeof wsStatusEventPayloadSchema>
export type WsPlayerEventPayload = z.infer<typeof wsPlayerEventPayloadSchema>
export type WsWeatherPayload = z.infer<typeof wsWeatherPayloadSchema>
export type WsBackupPayload = z.infer<typeof wsBackupPayloadSchema>
export type WsBackupProgressPayload = z.infer<typeof wsBackupProgressPayloadSchema>
