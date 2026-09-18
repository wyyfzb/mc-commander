/**
 * Auth API（安全主线：管理员密码登录 / 会话管理）
 * 对照服务端 routes/auth.js：
 *  - status/setup/login 为公开端点（未认证可达，登录页首屏探测与凭据交换）
 *  - password/logout/sessions 需认证（Bearer 会话或 X-API-Key 双通道均可）
 * 类型与信封字段 camelCase 对齐服务端响应（token/sessionId/expiresAt/userAgent…）
 */
import { apiGet, apiPost, apiPut, apiDelete, apiRequest } from './client'
import type { ConnectionConfig } from './client'
import type { ApiKeyRotateResponse, AuthCapabilitiesResponse } from '@mc-commander/schemas'
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

/** 公开端点请求配置：仅需面板地址（本机有登录会话也不携带凭据头） */
function publicConfig(baseUrl: string): ConnectionConfig {
  return { baseUrl, apiKey: '', noCredentials: true }
}

/** GET /auth/status（公开）：登录页探测是否已设密 */
export function fetchAuthStatus(baseUrl: string, signal?: AbortSignal): Promise<AuthStatusData> {
  return apiGet<AuthStatusData>('/api/v1/auth/status', publicConfig(baseUrl), signal)
}

/**
 * POST /auth/setup（公开）：首访设密，成功即自动登录。
 * 公网部署开启了所有权证明时需携一次性 SETUP_TOKEN（服务端以
 * `Authorization: SetupToken <token>` 校验，通过即作废，见 routes/auth.js 顶部约定）
 */
export function setupPassword(
  baseUrl: string,
  password: string,
  setupToken?: string,
): Promise<AuthSessionData> {
  return apiPost<AuthSessionData>(
    '/api/v1/auth/setup',
    publicConfig(baseUrl),
    { password },
    setupToken ? { extraHeaders: { Authorization: `SetupToken ${setupToken}` } } : undefined,
  )
}

/**
 * POST /auth/login（公开）：密码换会话令牌（服务端按 IP 锁定防爆破）
 *
 * `totpCode` 是账号启用两步验证后的第二因子（6 位动态口令或一枚一次性恢复码）。
 * 已启用而未带（或带空串）时服务端回 40105 且**不签发会话**，调用方据此就地展开
 * 第二因子输入后带码重试——省略该字段即「只提交密码」的首次尝试。
 */
export function login(
  baseUrl: string,
  password: string,
  totpCode?: string,
): Promise<AuthSessionData> {
  const code = totpCode?.trim()
  return apiPost<AuthSessionData>('/api/v1/auth/login', publicConfig(baseUrl), {
    password,
    ...(code ? { totpCode: code } : {}),
  })
}

/** GET /auth/totp/status：两步验证状态（服务端永不回传 secret 与恢复码明文） */
export interface TotpStatusData {
  enabled: boolean
  /** 启用时间（ISO）；未启用为 null */
  confirmedAt: string | null
  /** 剩余未使用的恢复码数量 */
  recoveryCodesRemaining: number
}

/** POST /auth/totp/enroll：生成候选密钥与二维码（此时尚未启用，需 confirm 自证） */
export interface TotpEnrollData {
  /** Base32 密钥明文（供无法扫码时手动输入；仅本次响应出现） */
  secret: string
  /** otpauth:// URI（认证器可直接消费） */
  otpauthUrl: string
  /** 二维码 data URL（PNG），直接作为 <img src> */
  qrDataUrl: string
}

/** POST /auth/totp/confirm：动态口令确认挂靠；恢复码明文的唯一出口 */
export interface TotpConfirmData {
  enabled: true
  confirmedAt: string | null
  /** 10 枚一次性恢复码（明文，仅此一次响应） */
  recoveryCodes: string[]
}

/** GET /auth/totp/status（认证）：两步验证状态 */
export function fetchTotpStatus(config: ConnectionConfig, signal?: AbortSignal): Promise<TotpStatusData> {
  return apiGet<TotpStatusData>('/api/v1/auth/totp/status', config, signal)
}

/**
 * 部署能力（服务端按部署配置决定，客户端无法自行推断）
 *
 * `apiKeyEnabled=false` 时 API Key 通道在 HTTP 与 WS 上一律拒绝：`rotate-key` 403 且不写
 * `.env`，携带 Key 的请求也 403——此时轮换入口应当隐藏（点它必然失败）。
 *
 * 类型直接取自契约包（与 api/types.ts 各域同口径），不在此另写字段副本。
 */
export type AuthCapabilitiesData = AuthCapabilitiesResponse

/**
 * GET /auth/capabilities（认证）：部署能力探测。
 * 不在公开白名单内 ⇒ 未认证 401；调用方须先有可用凭据（会话或 API Key）。
 *
 * `ignoreSessionExpiry`：本调用的地址很可能是用户**刚输入、还没验证过**的面板。沿用的双通道
 * 凭据注入会把请求变成一次「凭据归属判定」——未记签发面板的旧会话会带上 Bearer，目标若是别的
 * 面板/同址换了后端就回 40103；而 40103 的默认处置是**全局登出**，会把人从连接表单里直接弹走。
 * 探测只是表单内的辅助判定，与连接测试同取舍：即使 40103 是真的，也只该在表单内呈现为
 * 「未知态」（入口保持可见），不改变本机登录态。
 */
export function fetchAuthCapabilities(
  config: ConnectionConfig,
  signal?: AbortSignal,
): Promise<AuthCapabilitiesData> {
  return apiRequest<AuthCapabilitiesData>('/api/v1/auth/capabilities', config, {
    method: 'GET',
    signal,
    ignoreSessionExpiry: true,
  })
}

/**
 * POST /rotate-readonly-key（认证）：生成/轮换只读机器凭据。
 * 旧凭据立即失效，明文只在本次响应里出现一次（服务端只存摘要）。
 * 仅管理员可达：只读凭据本身调用会 403（不能自我提权或替换同类凭据）。
 */
export function rotateReadonlyKey(config: ConnectionConfig): Promise<ApiKeyRotateResponse> {
  return apiPost<ApiKeyRotateResponse>('/api/v1/rotate-readonly-key', config, {})
}

/** POST /auth/totp/enroll（认证）：生成候选密钥 + 二维码 */
export function enrollTotp(config: ConnectionConfig): Promise<TotpEnrollData> {
  return apiPost<TotpEnrollData>('/api/v1/auth/totp/enroll', config)
}

/** POST /auth/totp/confirm（认证）：以一枚动态口令确认挂靠，返回恢复码明文 */
export function confirmTotp(config: ConnectionConfig, code: string): Promise<TotpConfirmData> {
  return apiPost<TotpConfirmData>('/api/v1/auth/totp/confirm', config, { code })
}

/** POST /auth/totp/disable（认证）：密码 + 第二因子双证关闭两步验证 */
export function disableTotp(
  config: ConnectionConfig,
  password: string,
  code: string,
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/api/v1/auth/totp/disable', config, { password, code })
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
export function kickSession(config: ConnectionConfig, sessionId: string): Promise<KickSessionData> {
  return apiDelete<KickSessionData>(`/api/v1/auth/sessions/${sessionId}`, config)
}
