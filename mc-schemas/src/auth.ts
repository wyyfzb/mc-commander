import { z } from 'zod'

/**
 * 认证与 API Key 域响应契约（issue 414）
 *
 * - 会话令牌为 base64url 明文交客户端（服务端仅存 SHA-256 摘要）；sessionId 为 UUID 字符串
 * - login 会话结构与 sessions 列表条目分开定义（字段语义不同：前者含明文 token，后者含 current 标记）
 * - apiKey 轮换响应白名单化：明文新 Key 出参仅允许 apiKey 单字段，防结构漂移导致意外泄漏
 */

/** login 成功响应：新会话（明文 token + UUID 会话 id + 过期时间 ISO） */
export const authSessionResponseSchema = z.object({
  token: z.string(),
  sessionId: z.string(),
  expiresAt: z.string(),
})

/** setup 成功响应：设密即登录（hasPassword 恒 true + 新会话） */
export const authSetupResponseSchema = authSessionResponseSchema.extend({
  hasPassword: z.literal(true),
})

/** status 探测响应：是否已设密（登录页首屏） */
export const authStatusResponseSchema = z.object({
  hasPassword: z.boolean(),
})

// ---------------------------------------------------------------------------
// 部署能力探测（认证域内）
//
// 为什么需要它：API_KEY_ENABLED 是服务端部署配置，公开的 auth/status 刻意不回传
// 任何配置面；而「用 API Key 打通」不是它的替代信号——通道关闭时 fail-closed 只拒绝
// **携带 Key** 的请求，不携带 Key 的公开端点照常 200，据此判断会得到一个随机消失的入口。
// 故把该开关放进受保护的独立端点：路由挂在全局认证中间件之后，未认证不可达。
// 只读机器凭据同理（readonlyApiKeyEnabled / readonlyApiKeyConfigured）：设置页要据它
// 决定「生成/轮换只读凭据」入口是否可用、以及显示「尚未创建 / 已配置」哪一态。
// 契约只暴露「通道开关 + 凭据是否已配置」这几个布尔量，部署配置的其余部分
// （路径/端口/后端开关）一律不进响应面。
// ---------------------------------------------------------------------------

/** 部署能力：API Key 通道是否开放（关闭时 rotate-key 及 Key 鉴权一律 403） */
export const authCapabilitiesResponseSchema = z.object({
  apiKeyEnabled: z.boolean(),
  /** 只读机器凭据通道开关（READONLY_API_KEY_ENABLED；关闭时该凭据一律 403、轮换端点 403） */
  readonlyApiKeyEnabled: z.boolean(),
  /** 服务端是否已配置只读凭据哈希（未配置 = 该通道不存在，轮换即「首次生成」） */
  readonlyApiKeyConfigured: z.boolean(),
})

/** 改密成功响应（会话通道与 API Key 通道同构：kickedSessions 为被踢会话数） */
export const authPasswordChangeResponseSchema = z.object({
  ok: z.literal(true),
  kickedSessions: z.number(),
})

/** 登出成功响应 */
export const authLogoutResponseSchema = z.object({
  ok: z.literal(true),
})

/** 会话列表条目（id 为 UUID；userAgent/ip 允许 null；current 标记当前会话） */
export const authSessionItemSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
})

/** 会话列表响应（踢单设备 UI 数据源） */
export const authSessionsResponseSchema = z.object({
  sessions: z.array(authSessionItemSchema),
})

/** 踢单设备成功响应（current 标记被踢的是否为当前会话） */
export const authSessionKickResponseSchema = z.object({
  ok: z.literal(true),
  current: z.boolean(),
})

/** API Key 轮换成功响应（明文新 Key 白名单单字段） */
export const apiKeyRotateResponseSchema = z.object({
  apiKey: z.string(),
})

// ---------------------------------------------------------------------------
// TOTP 两步验证（RFC 6238）
//
// 契约边界：secret 与恢复码明文**只在生成它的那一次响应里**出现——status 恒不含
// 二者，enroll 只给候选 secret（未启用），confirm 是恢复码明文唯一出口。
// 时间字段与全仓口径一致，为带时区的 ISO8601（服务端把 SQLite 的无时区
// CURRENT_TIMESTAMP 经 toIsoUtc 归一化后下发）。
// ---------------------------------------------------------------------------

/** 两步验证状态（管理端设置页数据源；任何情况下不返回 secret 与恢复码） */
export const authTotpStatusResponseSchema = z.object({
  enabled: z.boolean(),
  confirmedAt: z.string().nullable(),
  recoveryCodesRemaining: z.number(),
})

/** enroll 响应：候选 secret + otpauth URI + 二维码 data URL（此时尚未启用） */
export const authTotpEnrollResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrDataUrl: z.string(),
})

/** confirm 请求体：用当前动态口令证明已成功录入 secret */
export const authTotpConfirmRequestBodySchema = z.object({
  code: z.string(),
})

/** confirm 响应：启用态 + 10 个恢复码明文（唯一一次下发） */
export const authTotpConfirmResponseSchema = z.object({
  enabled: z.literal(true),
  confirmedAt: z.string(),
  recoveryCodes: z.array(z.string()),
})

/** disable 请求体：密码 + 第二因子（动态口令或恢复码）双重确认 */
export const authTotpDisableRequestBodySchema = z.object({
  password: z.string(),
  code: z.string(),
})

/** disable 成功响应 */
export const authTotpDisableResponseSchema = z.object({
  ok: z.literal(true),
})

export type AuthTotpStatusResponse = z.infer<typeof authTotpStatusResponseSchema>
export type AuthTotpEnrollResponse = z.infer<typeof authTotpEnrollResponseSchema>
export type AuthTotpConfirmRequestBody = z.infer<typeof authTotpConfirmRequestBodySchema>
export type AuthTotpConfirmResponse = z.infer<typeof authTotpConfirmResponseSchema>
export type AuthTotpDisableRequestBody = z.infer<typeof authTotpDisableRequestBodySchema>
export type AuthTotpDisableResponse = z.infer<typeof authTotpDisableResponseSchema>

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>
export type AuthSetupResponse = z.infer<typeof authSetupResponseSchema>
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>
export type AuthCapabilitiesResponse = z.infer<typeof authCapabilitiesResponseSchema>
export type AuthPasswordChangeResponse = z.infer<typeof authPasswordChangeResponseSchema>
export type AuthLogoutResponse = z.infer<typeof authLogoutResponseSchema>
export type AuthSessionItem = z.infer<typeof authSessionItemSchema>
export type AuthSessionsResponse = z.infer<typeof authSessionsResponseSchema>
export type AuthSessionKickResponse = z.infer<typeof authSessionKickResponseSchema>
export type ApiKeyRotateResponse = z.infer<typeof apiKeyRotateResponseSchema>

// ---------------------------------------------------------------------------
// 输入侧契约（issue 428）
//
// 凭据端点入参只锁「形状」（字段存在 + string 类型）；密码强度（8-128 位）
// 校验留在路由层，且必须置于以下既有安全语义之后：
// - setup：未证明所有权（SetupToken 403）不得泄露后续校验语义，403 先于 400
// - login：弱密码属凭据错误（401 + 失败锁定计数），升为 400 会挪动锁定挂靠点
// - 改密：旧密 401 校验先于新密强度 400，错误呈现顺序保持
// 因此 schema 不加 min/max 长度约束——长度约束的显式持有方是路由层
// PASSWORD_MIN / PASSWORD_MAX 常量。
// ---------------------------------------------------------------------------

/** setup 请求体：首访设密（仅未设密时可用） */
export const authSetupRequestBodySchema = z.object({
  password: z.string(),
})

/** login 请求体：密码换会话令牌；已挂靠两步验证时须带 totpCode（动态口令或恢复码） */
export const authLoginRequestBodySchema = z.object({
  password: z.string(),
  totpCode: z.string().optional(),
})

/** 改密请求体：验旧密 + 设新密 */
export const authPasswordChangeRequestBodySchema = z.object({
  oldPassword: z.string(),
  newPassword: z.string(),
})

export type AuthSetupRequestBody = z.infer<typeof authSetupRequestBodySchema>
export type AuthLoginRequestBody = z.infer<typeof authLoginRequestBodySchema>
export type AuthPasswordChangeRequestBody = z.infer<typeof authPasswordChangeRequestBodySchema>
