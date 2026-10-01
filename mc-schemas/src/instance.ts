import { z } from 'zod'

export const instanceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  isRunning: z.boolean(),
  playerCount: z.number(),
})

export const instanceUpdatePayloadSchema = z.object({
  // trim 后 min(1)：实例名首尾空白在写入侧一律归一化——库里的名字是卸载/恢复等
  // 破坏性操作比对的确认值，存成带空格的形态会让用户按界面所见的名字永远确认不上
  name: z.string().trim().min(1).optional(),
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
  // GB 数值（服务端 _getWorldSize 产出；世界目录缺失回退 0，遍历失败回退旧值）
  worldSize: z.number().nullable(),
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
  diskUsage: z
    .object({
      primary: z
        .object({
          mountpoint: z.string(),
          totalGB: z.number(),
          usedGB: z.number(),
          percent: z.number(),
        })
        .nullable(),
      all: z.array(
        z.object({
          mountpoint: z.string(),
          totalGB: z.number(),
          usedGB: z.number(),
          percent: z.number(),
        }),
      ),
    })
    .optional(),
  instances: z.array(instanceSummarySchema),
})

export const logEntrySchema = z.object({
  text: z.string(),
  type: z.enum(['stdout', 'stderr']),
})

/** 实例列表（toStatus() 数组，非分页信封） */
export const instanceStatusListSchema = z.array(instanceStatusSchema)

/** 日志环形缓冲切片（logBuffer 元素含 time 键，观测仅锁定 text/type） */
export const logEntriesSchema = z.array(logEntrySchema)

/** 命令执行响应：RCON 回显文本或 null（实例未运行/空回显） */
export const commandResponseSchema = z.string().nullable()

export type InstanceSummary = z.infer<typeof instanceSummarySchema>
export type InstanceUpdatePayload = z.infer<typeof instanceUpdatePayloadSchema>
export type InstanceStatus = z.infer<typeof instanceStatusSchema>
export type OverviewData = z.infer<typeof overviewDataSchema>
export type InstanceStatusList = z.infer<typeof instanceStatusListSchema>
export type LogEntries = z.infer<typeof logEntriesSchema>
export type CommandResponse = z.infer<typeof commandResponseSchema>
export type LogEntry = z.infer<typeof logEntrySchema>

// ---------------------------------------------------------------------------
// 输入侧契约（issue 486）
//
// status.js 实例控制面五 body 端点收口（validateBody 前置校验，范式同 auth #428）：
// - 仅锁「形状与类型」；业务语义校验（javaPath 可执行性 / jvmArgs -X/-D 形态 /
//   属性值字符集）仍由路由层既有逻辑持有——schema 收口只统一 400 VALIDATION_ERROR
//   信封，不挪动任何安全校验挂靠点
// - start 端点：startCommand 禁用键（z.never）承接 find-002「启动命令不得经 API
//   传入」——任何值（含 null）在 schema 层前置 400，路由层原判断保留作纵深防御
// - properties 端点：passthrough 保留全部属性键（properties 键不可枚举，不能走
//   剥离范式）；数组/标量/null 由 schema 层拒绝（文案与原 400 一致）
// ---------------------------------------------------------------------------

/** PUT /instances/:id 请求体：实例设置整包更新（字段形状与 instanceUpdatePayloadSchema 对齐；
 *  javaPath/jarFile/description 允许 null 清除（与既有路由层语义一致，javaPath null 为
 *  isValidJavaExecutable 白名单分支）；maxMemory/minMemory/name 锁定 string——null 原行为
 *  会写入 DB 并导致响应侧 instanceStatusSchema 漂移，属本次收口治理目标） */
export const instanceSettingsRequestBodySchema = z.object({
  // 与 instanceUpdatePayloadSchema.name 同口径（写入侧归一化）；trim 后为空视为无效
  name: z.string().trim().min(1, 'name 不能为空或纯空白').optional(),
  description: z.string().nullable().optional(),
  javaPath: z.string().nullable().optional(),
  maxMemory: z.string().optional(),
  minMemory: z.string().optional(),
  jarFile: z.string().nullable().optional(),
  autoRestart: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  jvmArgs: z.array(z.string()).optional(),
  startCommand: z
    .null({
      error: () => 'startCommand 已不再支持通过 API 更新（如需清除旧配置请传 null）',
    })
    .optional(),
})

/** POST /instances/:id/start 请求体：禁用键契约——startCommand 出现即 400（find-002 RCE 封堵） */
export const instanceStartRequestBodySchema = z.object({
  startCommand: z
    .never({
      error: () => 'startCommand 已不再支持通过 API 传入',
    })
    .optional(),
})

/** POST /instances/:id/command 请求体：非空字符串 + 长度上限（上限宽松覆盖长 tellraw/NBT 命令，仅拒收超长滥用） */
export const instanceCommandRequestBodySchema = z.object({
  command: z
    .string({
      error: (iss) =>
        iss.input === undefined ? 'Command is required' : 'Command must be a string',
    })
    .min(1, 'Command is required')
    .max(2000),
  /**
   * 命令来源标记（落 `command_history.source`）。
   * **取值是白名单枚举，不是自由字符串**：source 是审计字段，若放开成自由值，
   * 调用方可把命令标成 `scheduler`/`rcon` 从而冒充别的来源，审计可回溯性即失效。
   * 省略时为 `api`（既有行为不变）。
   */
  source: z.enum(['api', 'replay']).optional(),
})

/** PUT /instances/:id/properties 请求体：属性键值对（passthrough 保留全部键；数组/标量/null 拒绝） */
export const instancePropertiesRequestBodySchema = z
  .object({}, { error: (iss) => (iss.input === undefined ? 'Required' : '请求体必须是 JSON 对象') })
  .passthrough()

/** POST /instances/:id/eula 请求体：EULA 确认布尔（文案与原 400 一致） */
export const instanceEulaRequestBodySchema = z.object({
  agreed: z.boolean({
    error: () => 'agreed must be a boolean',
  }),
})

export type InstanceSettingsRequestBody = z.infer<typeof instanceSettingsRequestBodySchema>
export type InstanceStartRequestBody = z.infer<typeof instanceStartRequestBodySchema>
export type InstanceCommandRequestBody = z.infer<typeof instanceCommandRequestBodySchema>
export type InstancePropertiesRequestBody = z.infer<typeof instancePropertiesRequestBodySchema>
export type InstanceEulaRequestBody = z.infer<typeof instanceEulaRequestBodySchema>

// ---------------------------------------------------------------------------
// 卸载实例（issue 486 收口的同一范式，见上）
// 破坏性端点：实例名确认由服务端强制（前端弹窗的输入只存在于客户端，直连 API
// 的调用方此前可无确认删除），备份目录按设计保留，故成功响应回报保留内容。
// ---------------------------------------------------------------------------

/** DELETE /instances/:id 请求体：confirmName 为实例名。本 schema 只锁类型（必须是字符串），
 *  **不设最小长度**：升级前库里既可能存着带首尾空白的旧值、也可能存着空名旧值，两者都只能靠
 *  空/空白入参确认，故归一化与相等判定全部由路由层承担（两侧 trim 后全等）。
 *  acknowledgeIrreversible 仅在实例没有任何备份时才被要求为 true */
export const instanceDeleteRequestBodySchema = z.object({
  confirmName: z.string({
    error: (iss) =>
      iss.input === undefined ? 'confirmName is required' : 'confirmName must be a string',
  }),
  acknowledgeIrreversible: z.boolean().optional(),
})

/** DELETE /instances/:id 成功响应：删除后仍保留在磁盘上的备份快照信息 */
export const instanceDeleteResponseSchema = z.object({
  /** 保留的备份（快照目录）总份数 */
  retainedBackupCount: z.number(),
  /** 最近若干条快照目录名（按修改时间倒序，超出上限的只计数量不列名） */
  retainedBackupNames: z.array(z.string()),
})

export type InstanceDeleteRequestBody = z.infer<typeof instanceDeleteRequestBodySchema>
export type InstanceDeleteResponse = z.infer<typeof instanceDeleteResponseSchema>
