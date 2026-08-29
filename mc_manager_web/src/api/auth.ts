/**
 * Auth API（安全主线：管理员密码登录 / 会话管理）
 * 对照服务端 routes/auth.js（R10 #54）：
 *  - status/setup/login 为公开端点（未认证可达，登录页首屏探测与凭据交换）
 *  - password/logout/sessions 需认证（Bearer 会话或 X-API-Key 双通道均可）
 * 类型与信封字段 camelCase 对齐服务端响应（token/sessionId/expiresAt/userAgent…）
 */
import { apiGet, apiPost, apiPut, apiDelete, apiRequest } from './client'
import type { ConnectionConfig } from './client'
import type { StoredSession } from '@/stores/auth'

export interface AuthStatusData {
  hasPassword: boolean
}

/** 登录/设密成功返回的会话凭据（setup 额外带 hasPassword: true） */
export type AuthSessionData = StoredSession

/** GET /auth/sessions 单行（camelCase 对齐服务端映射） */
export interface SessionRow {
  id: number
  userAgent: string | null
  ip: string | null
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  /** 仅当前会话为 true（服务端按 req.auth.sessionId 比对） */
  current: boolean
}

export interface SessionsData {
  sessions: SessionRow[]
}

/** 改密响应（改后其余会话全部被踢，仅保留当前） */
export interface ChangePasswordData {
  ok: boolean
  kickedSessions: number
}

/** 踢单设备响应（若踢的是当前会话，后续请求 40103 走全局过期处理） */
export interface KickSessionData {
  ok: boolean
  current: boolean
}

/** 公开端点请求配置：仅需面板地址（无需任何凭据头） */
function publicConfig(baseUrl: string): ConnectionConfig {
  return { baseUrl, apiKey: '' }
}

/** GET /auth/status（公开）：登录页探测是否已设密 */
export function fetchAuthStatus(baseUrl: string, signal?: AbortSignal): Promise<AuthStatusData> {
  return apiGet<AuthStatusData>('/api/v1/auth/status', publicConfig(baseUrl), signal)
}

/** POST /auth/setup（公开）：首访设密，成功即自动登录 */
export function setupPassword(baseUrl: string, password: string): Promise<AuthSessionData> {
  return apiPost<AuthSessionData>('/api/v1/auth/setup', publicConfig(baseUrl), { password })
}

/** POST /auth/login（公开）：密码换会话令牌（服务端按 IP 锁定防爆破） */
export function login(baseUrl: string, password: string): Promise<AuthSessionData> {
  return apiPost<AuthSessionData>('/api/v1/auth/login', publicConfig(baseUrl), { password })
}

/** POST /auth/logout：登出当前会话（仅会话通道有意义；API Key 通道返回 40301 忽略即可） */
export function logout(config: ConnectionConfig): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/api/v1/auth/logout', config)
}

/** PUT /auth/password：验旧密改新密；服务端踢其余会话（保留当前） */
export function changePassword(
  config: ConnectionConfig,
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordData> {
  return apiPut<ChangePasswordData>('/api/v1/auth/password', config, {
    currentPassword,
    newPassword,
  })
}

/** GET /auth/sessions：活跃会话列表（含 current 标记） */
export function fetchSessions(config: ConnectionConfig, signal?: AbortSignal): Promise<SessionsData> {
  return apiGet<SessionsData>('/api/v1/auth/sessions', config, signal)
}

/** DELETE /auth/sessions/:id：踢单设备 */
export function kickSession(config: ConnectionConfig, sessionId: number): Promise<KickSessionData> {
  return apiDelete<KickSessionData>(`/api/v1/auth/sessions/${sessionId}`, config)
}

/**
 * 公开端点的裸请求变体：登录页探测后端可达性（不解析信封外语义时仍走信封）。
 * 探测失败（NetworkError）用于登录页展示「无法连接服务器」错误态。
 */
export async function probeAuthEndpoint(baseUrl: string, path: '/api/v1/auth/status'): Promise<unknown> {
  return apiRequest(path, publicConfig(baseUrl))
}
