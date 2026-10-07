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

/**
 * 实例可用通道。分两个布尔而非一个「管理通道」：两者的能力面不同，
 * 差异会被读成故障——RCON 能执行控制台命令，MSMP 不能（无 run_command 方法），
 * 但 MSMP 能给出结构化事实。UI 据各自的可用来决定「哪些操作可行」。
 */
export const instanceCapabilitiesSchema = z.object({
  // RCON：命令面唯一出口。判据是配置齐全且实例在运行（RCON 无握手概念）
  rcon: z.boolean(),
  // MSMP：结构化查询面（1.21.9+）。判据是最近一次查询实测成功——端口默认可随机、
  // 链路可被反代，配置推不出可用性
  msmp: z.boolean(),
})

export const instanceStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  isRunning: z.boolean(),
  capabilities: instanceCapabilitiesSchema,
  autoRestart: z.boolean(),
  autoStart: z.boolean(),
  circuitBreakerTripped: z.boolean(),
  consecutiveCrashes: z.number(),
  uptime: z.number(),
  address: z.string(),
  // 地址可达范围：'public' 为公网（可直接发给玩家），'private' 为内网/环回
  // （仅同一网络内可连）。前端据此标注，避免把「玩家连不上的地址」当对外地址展示；
  // 判据在服务端由 isPrivateIp 派生，不在前端重算（双端各算一次必然漂移）
  addressType: z.enum(['public', 'private']),
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
      // 必须按 code 限定：schema 级 error 回调会接管该 schema 上**所有** check 的默认
      // 文案，不限定就会把 .max() 的 too_big 也报成「Command must be a string」（误导性
      // 文案，且与 v3 的「String must contain at most 2000 character(s)」不一致）
      error: (iss) =>
        iss.code === 'invalid_type'
          ? iss.input === undefined
            ? 'Command is required'
            : 'Command must be a string'
          : undefined,
    })
    .min(1, 'Command is required')
    .max(2000, 'String must contain at most 2000 character(s)'),
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

/**
 * 推送通道（MSMP）状态与开关。
 *
 * 为什么要有这个专用端点而不是把 `management-server-*` 加进 properties 白名单：
 * 这三项**必须一起写**——只写 `enabled=true` 而 TLS 保持默认 true（keystore 默认为空）
 * 会让服务器**再也起不来**（实测 `TLS is enabled but keystore is not configured`）。
 * 通用 PUT 是「逐键提交」的语义，天然表达不了这个原子约束。
 */
export const pushChannelStateSchema = z.object({
  /** 当前是否已开启（读磁盘的 management-server-enabled） */
  enabled: z.boolean(),
  /** 是否启用了 TLS（读磁盘；面板开启时会确保它与 keystore 的组合不会让服务器起不来） */
  tlsEnabled: z.boolean(),
  /** 当前绑定的主机（MC 默认 localhost＝仅本机；非本机时界面应提示暴露面） */
  host: z.string(),
  /** 当前端口（0＝由服务端随机分配，实际端口见启动播报行） */
  port: z.number(),
  /** secret 是否已配置且合法（40 位字母数字）；不返回内容——它是凭据 */
  secretConfigured: z.boolean(),
})

/** POST /instances/:id/push-channel 请求体 */
export const pushChannelRequestBodySchema = z.object({
  enabled: z.boolean({
    error: () => 'enabled must be a boolean',
  }),
})

export const pushChannelToggleResponseSchema = z.object({
  enabled: z.boolean(),
  /** 服务器正在运行时需重启才生效（MSMP 只在启动时读取） */
  restartRequired: z.boolean(),
  /** 本次是否新生成了 secret（仅用于给用户一句如实说明，不回传内容） */
  secretGenerated: z.boolean(),
})

export type PushChannelState = z.infer<typeof pushChannelStateSchema>
export type PushChannelRequestBody = z.infer<typeof pushChannelRequestBodySchema>
export type PushChannelToggleResponse = z.infer<typeof pushChannelToggleResponseSchema>

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

/**
 * GET /instances/:id/crash-report 成功响应。
 *
 * 崩溃诊断产物有**两类**（MC 崩溃报告与 JVM 崩溃日志），且解析出的字段随产物类型与
 * 崩溃时点而异（如 `-- Affected level --` 只在推进到世界/刻循环的崩溃里出现），
 * 故解析结果统一表达为**有序的 label/value 列表**而不是固定字段：
 * 既能原样呈现「已核实字段」，也不必为不存在的段造空键。
 *
 * `parseError` 非空表示如实降级（读失败 / 格式不识别）——此时 `excerpt` 仍可能可用，
 * 界面不得把它当「没有报错」。
 */
export const crashArtifactFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
})

/**
 * 崩溃诊断词条：命中的结论 + 处置动作 + 该结论的**已验证 MC 版本**。
 *
 * `matchedBy` 说明是靠哪个键命中的（`description` = 崩溃报告的 `Description:`，
 * `exception` = 顶层异常行行首前缀，`logger` = 日志 logger），前端据此解释结论来处。
 */
export const crashDiagnosisEntrySchema = z.object({
  id: z.string(),
  matchedBy: z.enum(['description', 'exception', 'logger']),
  title: z.string(),
  detail: z.string(),
  actions: z.array(z.string()),
  verifiedVersions: z.array(z.string()),
  evidence: z.array(z.enum(['实测', '静态提取'])),
})

/**
 * 一次崩溃的诊断结果。
 *
 * `matched=false` 表示**没有命中任何词条**（或该产物类型没有可锚的键，如 hs_err）——
 * 此时呈现层原样展示已解析字段并给出一键反馈出路，**不猜**。
 * `verifiedForInstance` 为 null 表示实例版本未知（既不说适用也不说不适用）。
 */
export const crashDiagnosisSchema = z.object({
  matched: z.boolean(),
  entry: crashDiagnosisEntrySchema.nullable(),
  instanceVersion: z.string().nullable(),
  verifiedForInstance: z.boolean().nullable(),
})

export const crashArtifactSchema = z.object({
  /** 是否真的取到了产物（false 表示枚举/读取失败，与「从未崩溃过」的 null 不同） */
  available: z.boolean(),
  /** 产物类型：crash-report = MC 崩溃报告，jvm-crash = hs_err_pid*.log */
  kind: z.enum(['crash-report', 'jvm-crash']).optional(),
  fileName: z.string().optional(),
  mtimeMs: z.number().optional(),
  sizeBytes: z.number().optional(),
  /** 已核实字段（有序）；解析失败时为空数组 */
  summary: z.array(crashArtifactFieldSchema).optional(),
  /** 崩溃报告：`Description:`（固定词表，诊断映射的锚） */
  description: z.string().nullable().optional(),
  /** 崩溃报告 System Details 里的 Minecraft 版本（比 DB/jar 更贴近「是谁崩的」） */
  minecraftVersion: z.string().nullable().optional(),
  /** 诊断映射结果（未命中时为 matched:false，由呈现层走出路） */
  diagnosis: crashDiagnosisSchema.optional(),
  /** 崩溃报告：顶层异常行 */
  exception: z.string().nullable().optional(),
  /** 崩溃报告：顶层栈帧（文本） */
  stack: z.array(z.string()).optional(),
  /** 崩溃报告：`Caused by:` 链 */
  causedBy: z.array(z.string()).optional(),
  /** 崩溃报告：`-- <段名> --` 段名列表 */
  sections: z.array(z.string()).optional(),
  /** JVM 崩溃日志：故障行 */
  failure: z.array(z.string()).optional(),
  /** JVM 崩溃日志：问题帧（OOM 型没有该段） */
  problematicFrame: z.string().nullable().optional(),
  /** 头部节选原文（未解析部分整体呈现） */
  excerpt: z.string().optional(),
  /** 如实降级的原因；null/缺省表示解析正常 */
  parseError: z.string().nullable().optional(),
})

export type CrashArtifactField = z.infer<typeof crashArtifactFieldSchema>
export type CrashArtifact = z.infer<typeof crashArtifactSchema>
export type CrashDiagnosisEntry = z.infer<typeof crashDiagnosisEntrySchema>
export type CrashDiagnosis = z.infer<typeof crashDiagnosisSchema>

/**
 * 崩溃产物历史里的一条。
 *
 * `time`/`reason`/`detail` 都可能为 null：前者是产物本身没写（如 hs_err 无可靠时间），
 * 后两者是「读不到或取不出」，此时界面回落到文件名——**不猜**，不拿别的字段顶替。
 */
export const crashArtifactHistoryItemSchema = z.object({
  kind: z.enum(['crash-report', 'jvm-crash']),
  fileName: z.string(),
  mtimeMs: z.number(),
  sizeBytes: z.number(),
  /** 崩溃报告的 `Time:` 字段；取不到为 null（界面用 mtimeMs 兜底） */
  time: z.string().nullable(),
  /** 崩溃报告的 `Description:`；hs_err 的故障行 */
  reason: z.string().nullable(),
  /** 崩溃报告的顶层异常行；hs_err 的问题帧 */
  detail: z.string().nullable(),
})

/**
 * 崩溃产物历史（最新的在前）。产物文件本身即持久面，故不新建存储：
 * `total` 是实例目录里全部产物的份数，`hasMore` 表示还有更早的没返回。
 */
export const crashArtifactHistorySchema = z.object({
  items: z.array(crashArtifactHistoryItemSchema),
  total: z.number(),
  hasMore: z.boolean(),
})

/** 历史份数上限：够看清「崩过几次」，又不至于把几十份产物一次灌给前端 */
export const crashArtifactHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).catch(20),
})

export type CrashArtifactHistoryItem = z.infer<typeof crashArtifactHistoryItemSchema>
export type CrashArtifactHistory = z.infer<typeof crashArtifactHistorySchema>
