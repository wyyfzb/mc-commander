import { z } from 'zod'

export const instanceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  isRunning: z.boolean(),
  playerCount: z.number(),
})

export const instanceUpdatePayloadSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  javaPath: z.string().optional(),
  maxMemory: z.string().optional(),
  minMemory: z.string().optional(),
  jarFile: z.string().optional(),
  autoRestart: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  jvmArgs: z.array(z.string()).optional(),
  startCommand: z.string().nullable().optional(),
})

export const instanceStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  isRunning: z.boolean(),
  isRconConnected: z.boolean(),
  autoRestart: z.boolean(),
  autoStart: z.boolean(),
  circuitBreakerTripped: z.boolean(),
  consecutiveCrashes: z.number(),
  uptime: z.number(),
  address: z.string(),
  players: z.array(z.unknown()),
  playerCount: z.number(),
  maxPlayers: z.number(),
  mcVersion: z.string(),
  modLoader: z.string(),
  tps: z.number(),
  mspt: z.number(),
  cpuUsage: z.number(),
  memoryUsage: z.number(),
  totalMemory: z.number(),
  worldSize: z.string().nullable(),
  seed: z.string().nullable(),
  lastSave: z.string().nullable(),
  lastOutput: z.string().nullable(),
  gameMode: z.string(),
  difficulty: z.string(),
  whitelisted: z.boolean(),
  onlineMode: z.boolean(),
  viewDistance: z.number(),
  spawnProtection: z.number(),
  worldDay: z.number().nullable(),
  worldTime: z.number().nullable(),
  weather: z.enum(['clear', 'rain', 'thunder']).nullable(),
  opCount: z.number(),
  opNames: z.array(z.string()),
  todayNewPlayers: z.number(),
  sleepingPlayers: z.number(),
  sleepingPlayerNames: z.array(z.string()),
  awakePlayerNames: z.array(z.string()),
  totalUptime: z.number(),
  startTime: z.string().nullable(),
  startCommand: z.string().nullable(),
  jvmArgs: z.array(z.string()).nullable(),
  javaPath: z.string(),
  maxMemory: z.union([z.string(), z.number()]),
  minMemory: z.union([z.string(), z.number()]),
  jarFile: z.string(),
})

export const overviewDataSchema = z.object({
  version: z.string(),
  instanceCount: z.number(),
  runningCount: z.number(),
  totalPlayers: z.number(),
  systemCpuUsage: z.number(),
  systemMemoryUsage: z.number(),
  systemMemoryTotal: z.number(),
  systemMemoryPercent: z.number(),
  totalMemory: z.number(),
  freeMemory: z.number(),
  diskUsage: z.object({
    primary: z.object({
      mountpoint: z.string(),
      totalGB: z.number(),
      usedGB: z.number(),
      percent: z.number(),
    }).nullable(),
    all: z.array(z.object({
      mountpoint: z.string(),
      totalGB: z.number(),
      usedGB: z.number(),
      percent: z.number(),
    })),
  }).optional(),
  instances: z.array(instanceSummarySchema),
})

export const logEntrySchema = z.object({
  text: z.string(),
  type: z.enum(['stdout', 'stderr']),
})

export type InstanceSummary = z.infer<typeof instanceSummarySchema>
export type InstanceUpdatePayload = z.infer<typeof instanceUpdatePayloadSchema>
export type InstanceStatus = z.infer<typeof instanceStatusSchema>
export type OverviewData = z.infer<typeof overviewDataSchema>
export type LogEntry = z.infer<typeof logEntrySchema>
