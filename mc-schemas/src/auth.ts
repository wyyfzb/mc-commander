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

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>
export type AuthSetupResponse = z.infer<typeof authSetupResponseSchema>
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>
export type AuthPasswordChangeResponse = z.infer<typeof authPasswordChangeResponseSchema>
export type AuthLogoutResponse = z.infer<typeof authLogoutResponseSchema>
export type AuthSessionItem = z.infer<typeof authSessionItemSchema>
export type AuthSessionsResponse = z.infer<typeof authSessionsResponseSchema>
export type AuthSessionKickResponse = z.infer<typeof authSessionKickResponseSchema>
export type ApiKeyRotateResponse = z.infer<typeof apiKeyRotateResponseSchema>
