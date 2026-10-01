import { z } from 'zod'

export const versionsResponseSchema = z.object({
  type: z.string(),
  versions: z.array(z.string()),
  loaders: z.array(z.string()).optional(),
})

export const deployRequestSchema = z.object({
  type: z.enum(['vanilla', 'paper', 'fabric', 'forge', 'purpur']),
  mcVersion: z.string(),
  // 实例名的另一条写入路径（部署）：与 PUT /instances/:id 同口径归一化首尾空白，
  // 避免把带空格的名字落库后让卸载/恢复的实例名确认永久对不上
  instanceName: z.string().trim().min(1, 'instanceName 不能为空或纯空白'),
  maxMemory: z.string().optional(),
  loaderVersion: z.string().optional(),
  // EULA 同意（用户动作，非部署配置）：true → 写 eula=true 并执行首启；
  // 缺省/false → 写 eula=false 且跳过首启，待实例启动流程的 EULA 确认再写
  eula: z.boolean().optional(),
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

/**
 * POST /instances/deploy/cancel 请求契约（取消在途部署）。
 * instanceId 必须是服务端当前在途部署的实例 id：部署实例在完成前未入库，
 * 服务端按 id 精确匹配注册表条目，不做「取消当前在途的那一个」的兜底推断
 * （滞后一个部署周期的取消请求会误杀随后发起的新部署）。
 */
export const deployCancelRequestSchema = z.object({
  instanceId: z.string().min(1, 'instanceId 不能为空'),
})

/** POST /instances/deploy/cancel 响应契约（已受理中断，终态由 deployProgress 事件推送） */
export const deployCancelResponseSchema = z.object({
  instanceId: z.string(),
  cancelled: z.literal(true),
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

/**
 * GET /instances/deploy/status 响应契约（部署进度兜底查询）。
 * - deploying 为判别字段：true 表示服务端确有部署在途（进度对象展开），
 *   false 表示**空态**——从未部署过、部署已终态、或快照超出时限视为死快照，
 *   三种情况都返回同一空态而非 404（与 upgradeStatusResponseSchema 同口径）。
 * - 快照是内存态、按实例仅保留最近一次；服务重启会丢失快照，此时返回空态。
 * - updatedAt 为快照最后写入时刻，供前端识别陈旧在途快照。
 */
export const deployStatusResponseSchema = z.discriminatedUnion('deploying', [
  z.object({ deploying: z.literal(false) }),
  z.object({
    deploying: z.literal(true),
    instanceId: z.string(),
    instanceName: z.string(),
    type: z.string(),
    mcVersion: z.string(),
    stage: z.string(),
    percent: z.number(),
    transferred: z.number(),
    total: z.number(),
    updatedAt: z.number(),
    error: z.string().optional(),
  }),
])

export const upgradeStageSchema = z.enum([
  'backup',
  'download',
  'replace',
  'verify',
  'completed',
  'failed',
  'rolled_back',
  // 用户取消（服务端在途升级被中断）：与 failed/rolled_back 分档——取消不是故障，
  // detail 里写明是否发生了回滚（替换 JAR 之后取消才需要回滚）
  'cancelled',
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
 * - type 枚举错误消息保留原路由 'Invalid type' 文案（error 回调保留既有
 *   断言与前端提示兼容），缺省归一为 vanilla（与原解构默认值一致）。
 */
export const upgradeRequestSchema = z.object({
  mcVersion: z.string({
    error: (iss) => (iss.input === undefined ? 'mcVersion is required' : undefined),
  }),
  type: z
    .enum(['vanilla', 'paper', 'purpur'], {
      error: () => ({ message: 'Invalid type. Must be one of: vanilla, paper, purpur' }),
    })
    .default('vanilla'),
})

export const upgradeStartResponseSchema = z.object({
  message: z.string(),
  instanceId: z.string(),
  mcVersion: z.string(),
  type: z.string(),
})

/** POST /instances/:id/upgrade/cancel 响应契约（已受理中断，终态由 upgradeProgress 事件推送） */
export const upgradeCancelResponseSchema = z.object({
  instanceId: z.string(),
  cancelled: z.literal(true),
})

/**
 * GET /instances/:id/upgrade/status 响应契约（issue 402 响应侧接入）。
 * upgrading 为判别字段：升级中 = 进度对象展开（与 upgradeProgressSchema 同构），
 * 空闲 = 仅布尔 false（与路由 null progress 分支一致）。
 */
export const upgradeStatusResponseSchema = z.discriminatedUnion('upgrading', [
  z.object({ upgrading: z.literal(false) }),
  z.object({
    upgrading: z.literal(true),
    instanceId: z.string(),
    stage: upgradeStageSchema,
    percent: z.number(),
    detail: z.string(),
    timestamp: z.number(),
  }),
])

export type VersionsResponse = z.infer<typeof versionsResponseSchema>
export type DeployRequest = z.infer<typeof deployRequestSchema>
export type DeployResult = z.infer<typeof deployResultSchema>
export type DeployCancelRequest = z.infer<typeof deployCancelRequestSchema>
export type DeployCancelResponse = z.infer<typeof deployCancelResponseSchema>
export type DeployProgress = z.infer<typeof deployProgressSchema>
export type DeployStatusResponse = z.infer<typeof deployStatusResponseSchema>
export type UpgradeStage = z.infer<typeof upgradeStageSchema>
export type UpgradeProgress = z.infer<typeof upgradeProgressSchema>
export type UpgradeRequest = z.infer<typeof upgradeRequestSchema>
export type UpgradeStartResponse = z.infer<typeof upgradeStartResponseSchema>
export type UpgradeCancelResponse = z.infer<typeof upgradeCancelResponseSchema>
export type UpgradeStatusResponse = z.infer<typeof upgradeStatusResponseSchema>
