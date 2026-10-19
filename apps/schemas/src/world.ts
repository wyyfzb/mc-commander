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

/**
 * 游戏规则快照：**名单由服务器自述**，面板不按版本猜。
 *
 * 三态必须分开：`missing`（该版本没有这条规则）与 `unreadable`（读失败）都不能在界面上
 * 显示成"默认值"——那会把"没读到"伪装成事实。只有 `current` 带得出值。
 * `name` 已剥掉 `minecraft:` 命名空间，可直接作为 `/gamerule` 的命令实参
 * （实测 1.21.11 与 26.3 都接受裸名）。
 */
export const gameruleEntrySchema = z.object({
  name: z.string(),
  status: z.enum(['current', 'missing', 'unreadable']),
  type: z.enum(['boolean', 'integer']).nullable(),
  value: z.string().nullable(),
})

/**
 * `source` 交代这份快照来自哪条通道：`msmp` 结构化一次取全、`rcon` 名单 + 逐条读值、
 * `none` 两通道都不可用（此时 `rules` 为空，前端保持"未读取"而不是"全是默认值"）。
 *
 * `rosterFailed` 把「通道不通」与「通道通、但这一问没答上来」分开，两种情况都是空 `rules`，
 * 但结论完全不同：前者该去查连接，后者该重试。只看 `rules` 为空会让界面把名单超时
 * 报成"两通道都不可用"——那是假结论。此时 `source` 仍是实际用到的通道（`rcon`）。
 */
export const gamerulesResponseSchema = z.object({
  source: z.enum(['msmp', 'rcon', 'none']),
  rules: z.array(gameruleEntrySchema),
  rosterFailed: z.boolean().optional(),
})

export type GameruleEntry = z.infer<typeof gameruleEntrySchema>
export type GamerulesResponse = z.infer<typeof gamerulesResponseSchema>
