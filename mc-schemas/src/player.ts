import { z } from 'zod'

export const playerDimensionSchema = z.enum(['overworld', 'nether', 'end'])
export const playerGameModeSchema = z.enum(['survival', 'creative', 'adventure', 'spectator'])
export const weatherTypeSchema = z.enum(['clear', 'rain', 'thunder'])

export const spawnPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  dimension: z.string().optional(),
})

export const playerPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
})

export const playerEventSchema = z.object({
  type: z.string(),
  message: z.string(),
  timestamp: z.string(),
})

export const playerSessionSchema = z.object({
  joinTime: z.string(),
  leaveTime: z.string().nullable(),
  duration: z.number(),
})

export const playerStatsSchema = z.object({
  totalOnline: z.number(),
  loginCount: z.number(),
  offlineSince: z.number(),
  deathCount: z.number(),
  achievementCount: z.number(),
  sleepCount: z.number(),
})

export const playerPotionEffectSchema = z.object({
  id: z.string(),
  name: z.string(),
  level: z.number(),
  durationSeconds: z.number(),
  isBeneficial: z.boolean(),
})

export const ipHistoryEntrySchema = z.object({
  ip: z.string(),
  lastSeen: z.string(),
  count: z.number(),
})

export const inventoryItemSchema = z.object({
  id: z.string(),
  count: z.number(),
  slot: z.number(),
  durability: z.number().nullable(),
  enchanted: z.boolean(),
  customName: z.string().nullable(),
})

const equipmentSchema = z.object({
  helmet: inventoryItemSchema.nullable(),
  chestplate: inventoryItemSchema.nullable(),
  leggings: inventoryItemSchema.nullable(),
  boots: inventoryItemSchema.nullable(),
  offhand: inventoryItemSchema.nullable(),
})

export const playerInventorySchema = z.object({
  quickbar: z.array(inventoryItemSchema.nullable()),
  main: z.array(inventoryItemSchema.nullable()),
  equipment: equipmentSchema,
  enderChest: z.array(inventoryItemSchema.nullable()),
  source: z.enum(['snapshot', 'realtime']),
  partial: z.boolean(),
})

/** 玩家列表项（在线/离线超集） */
export const playerSchema = z.object({
  name: z.string(),
  uuid: z.string(),
  isOnline: z.boolean(),
  ip: z.string(),
  joinTime: z.number().nullable(),
  onlineTime: z.number(),
  totalPlayTime: z.number(),
  isOp: z.boolean(),
  isWhitelisted: z.boolean(),
  isBanned: z.boolean(),
  banExpiresAt: z.number().nullable(),
  isIpBanned: z.boolean(),
  ipBanExpiresAt: z.number().nullable(),
  isFakePlayer: z.boolean(),
  lastSeen: z.string().nullable(),
  health: z.number().nullable(),
  maxHealth: z.number().nullable(),
  hunger: z.number().nullable(),
  xpLevel: z.number().nullable(),
  spawnPoint: spawnPointSchema.nullable(),
  respawnPoint: spawnPointSchema.nullable(),
  position: playerPositionSchema.nullable(),
  gameMode: playerGameModeSchema.nullable(),
  dimension: playerDimensionSchema.nullable(),
  armor: z.number().nullable(),
  xpProgress: z.number().nullable(),
  ping: z.number().nullable(),
  isSleeping: z.boolean(),
  isAfk: z.boolean(),
  isFlying: z.boolean(),
  isSneaking: z.boolean(),
  isSprinting: z.boolean(),
  isBurning: z.boolean(),
  isFrozen: z.boolean(),
  potionEffects: z.array(playerPotionEffectSchema).optional(),
  ipHistory: z.array(ipHistoryEntrySchema).optional(),
  inventory: playerInventorySchema.nullable(),
  events: z.array(playerEventSchema),
  sessions: z.array(playerSessionSchema),
  stats: playerStatsSchema,
})

/** 封禁记录 */
export const banRecordSchema = z.object({
  targetType: z.enum(['player', 'ip']),
  target: z.string(),
  reason: z.string(),
  isActive: z.boolean(),
  isPermanent: z.boolean(),
  expiresAt: z.number().nullable(),
  createdAt: z.string(),
})

/** 封禁请求体 */
export const banRequestBodySchema = z.object({
  reason: z.string().optional(),
  duration: z.string().nullable().optional(),
  ip: z.string().optional(),
})

// 类型导出
export type SpawnPoint = z.infer<typeof spawnPointSchema>
export type PlayerPosition = z.infer<typeof playerPositionSchema>
export type PlayerDimension = z.infer<typeof playerDimensionSchema>
export type PlayerGameMode = z.infer<typeof playerGameModeSchema>
export type WeatherType = z.infer<typeof weatherTypeSchema>
export type PlayerEvent = z.infer<typeof playerEventSchema>
export type PlayerSession = z.infer<typeof playerSessionSchema>
export type PlayerStats = z.infer<typeof playerStatsSchema>
export type PlayerPotionEffect = z.infer<typeof playerPotionEffectSchema>
export type IpHistoryEntry = z.infer<typeof ipHistoryEntrySchema>
export type InventoryItem = z.infer<typeof inventoryItemSchema>
export type PlayerInventory = z.infer<typeof playerInventorySchema>
export type Player = z.infer<typeof playerSchema>
export type BanRecord = z.infer<typeof banRecordSchema>
export type BanRequestBody = z.infer<typeof banRequestBodySchema>
