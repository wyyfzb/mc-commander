import { z } from 'zod'

export const diskInfoSchema = z.object({
  mountpoint: z.string(),
  totalGB: z.number(),
  usedGB: z.number(),
  percent: z.number(),
})

export const diskUsageSchema = z.object({
  primary: diskInfoSchema.nullable(),
  all: z.array(diskInfoSchema),
})

/**
 * 磁盘告警阈值。由服务端下发的唯一来源（`config.diskAlert`），前端据此判定告警，
 * 避免前端另写一份数字而与部署配置漂移。
 */
export const diskAlertThresholdsSchema = z.object({
  warningPercent: z.number(),
  errorPercent: z.number(),
})

/**
 * 内存告警阈值。同 `diskAlert` 的理由：由服务端下发，前端不另写一份数字。
 *
 * 口径是**整机**内存使用率（`os.freemem()` 反推），与 `memoryPercent` 同源——
 * 不是 MC 进程的 RSS，也不是 JVM 堆。判「这台机器内存吃紧」要用整机口径；
 * 「这个 JVM 是否快 OOM」是另一个问题（进程 RSS ÷ 整机 RAM 的分子分母不同源，会失真）。
 */
export const memoryAlertThresholdsSchema = z.object({
  warningPercent: z.number(),
})

export const systemStatsSchema = z.object({
  cpuUsage: z.number(),
  memoryUsage: z.number(),
  totalMemory: z.number(),
  memoryPercent: z.number(),
  cpuCores: z.number(),
  loadAvg: z.array(z.number()),
  uptime: z.number(),
  diskUsage: diskUsageSchema.optional(),
  diskAlert: diskAlertThresholdsSchema.optional(),
  memoryAlert: memoryAlertThresholdsSchema.optional(),
})

export const updateCheckResultSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  hasUpdate: z.boolean(),
  offline: z.boolean().optional(),
  url: z.string().optional(),
})

/**
 * 面板自身错误日志（`error.log` 及轮转档）中的一条。
 *
 * `message` 可能多行：写入侧走 `util.format`，异常堆栈一类会带换行，故解析按
 * 「行首是 `[时间] [级别]` 才是新条目、其余行归上一条」的规则还原。
 */
export const panelErrorEntrySchema = z.object({
  time: z.string(),
  level: z.string(),
  message: z.string(),
})

/**
 * 面板自身错误日志的读取结果。
 *
 * `readState` 把「文件在不在」与「这次读成不成功」**分成两个事实**——它们正交，压成一个布尔值
 * 时消费方只能对用户说含糊话（「不存在，或存在但读不到」），而这两者对维护者指向完全不同的排查
 * 方向（改用日志级别 / 查权限与路径）：
 * - `ok`：至少读到了一档文件（`entries` 为空即「文件在、里面没条目」）
 * - `no-file`：所有轮转档都是 `ENOENT`（全新自托管机器的常态）
 * - `unreadable`：存在非 `ENOENT` 的失败（权限、磁盘故障等），**这一档才是「读取失败」**
 *
 * 聚合口径：只有**一档都没读到**时 `readState` 才有信息量；读到任意一档即 `ok`。
 * `available` 保留为派生字段（`readState === 'ok'`），旧消费方语义不变。
 * `hasMore=true` 表示还有更早的条目未返回：读取按尾部字节截断（单档上限 20MB），不整读。
 */
export const panelErrorsSchema = z.object({
  readState: z.enum(['ok', 'no-file', 'unreadable']),
  available: z.boolean(),
  entries: z.array(panelErrorEntrySchema),
  hasMore: z.boolean(),
  logFile: z.string(),
})

/** 读取条数上限：够看清「刚才为什么失败」，又不至于把整档日志灌给前端 */
export const panelErrorsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).catch(50),
})

export type DiskInfo = z.infer<typeof diskInfoSchema>
export type DiskUsage = z.infer<typeof diskUsageSchema>
export type DiskAlertThresholds = z.infer<typeof diskAlertThresholdsSchema>
export type MemoryAlertThresholds = z.infer<typeof memoryAlertThresholdsSchema>
export type SystemStats = z.infer<typeof systemStatsSchema>
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>
export type PanelErrorEntry = z.infer<typeof panelErrorEntrySchema>
export type PanelErrors = z.infer<typeof panelErrorsSchema>

// ---------------------------------------------------------------------------
// 内置 HTTPS
//
// 面板在同一端口同时提供明文与 TLS，故「是否启用」与「当前设备是否已信任
// 本地面板 CA」是两件事：前者是部署能力（服务端决定），后者是设备状态
// （只有浏览器自己知道）。两者都要下发给设置页，否则用户看到的永远是
// 一句「请安装证书」，装完也无从确认成功。
//
// 指纹进响应面是刻意的：它是用户核对「装进去的是不是这个面板的 CA」的唯一
// 手段，而根证书是公开信息（私钥不在响应里）。不给指纹，用户在系统证书
// 列表里看到的那串字符就无从对照，装错 CA 会表现为「装完还是不受信」。
// ---------------------------------------------------------------------------

/** 内置 HTTPS 状态（认证域内） */
export const httpsStatusSchema = z.object({
  /** 服务端是否在监听 TLS（openssl 缺失或证书签发失败时为 false） */
  enabled: z.boolean(),
  /** 未启用时的原因（设置页直接展示，不让用户自己猜） */
  disabledReason: z.string().nullable(),
  /** CA 证书 SHA-256 指纹（大写冒号分隔，与各平台证书查看界面同格式） */
  caFingerprint: z.string().nullable(),
  /** 服务端证书覆盖的地址：用户据此确认当前访问地址是否在覆盖范围内 */
  serverNames: z.array(z.string()),
  /** 服务端证书到期时间（ISO8601） */
  expiresAt: z.string().nullable(),
})

export type HttpsStatus = z.infer<typeof httpsStatusSchema>
