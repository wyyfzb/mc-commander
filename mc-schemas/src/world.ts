import { z } from 'zod'

export const worldDimensionSchema = z.object({
  name: z.string(),
  icon: z.string(),
  playerCount: z.number(),
})

export const worldInfoSchema = z.object({
  name: z.string(),
  type: z.string(),
  seed: z.string(),
  sizeGB: z.number(),
  difficulty: z.string(),
  gameMode: z.string(),
  viewDistance: z.number(),
  simulationDistance: z.number(),
  onlinePlayers: z.number(),
  maxPlayers: z.number(),
  spawnProtection: z.number(),
  maxWorldSize: z.number(),
  allowFlight: z.boolean(),
  hardcore: z.boolean(),
  pvp: z.boolean(),
  commandBlock: z.boolean(),
  generateStructures: z.boolean(),
  whiteList: z.boolean(),
  onlineMode: z.boolean(),
  lastSave: z.string().nullable(),
  gameDays: z.number().nullable(),
  dimensions: z.array(worldDimensionSchema),
})

/** server.properties 键值对（GET /properties 全量响应，值均为 properties 文件文本） */
export const serverPropertiesSchema = z.record(z.string(), z.string())

export type WorldDimension = z.infer<typeof worldDimensionSchema>
export type WorldInfo = z.infer<typeof worldInfoSchema>

/** server.properties 键值对 */
export type ServerProperties = Record<string, string>

export const updatePropertiesResponseSchema = z.object({
  restartRequired: z.array(z.string()),
})

export type UpdatePropertiesResponse = z.infer<typeof updatePropertiesResponseSchema>
export type ServerPropertiesMap = z.infer<typeof serverPropertiesSchema>
