/**
 * Auth store（安全主线 §认证会话）
 * - 管理员登录后的会话凭据（Bearer token），与 connection store（API Key 通道）并列
 * - localStorage 持久化 `mcs-session`：刷新/新标签页保持登录（服务端 7 天滑动续期）
 * - 安全取舍：token 存 localStorage 而非 sessionStorage——自托管单管理员场景下
 *   可用性优先；服务端支持踢单设备/改密全踢，泄露风险可通过会话管理面板处置
 */
import { create } from 'zustand'
import { panelAddress } from '@/lib/mc-connection'

const SESSION_STORAGE_KEY = 'mcs-session'

/** 服务端 /auth/login|setup 返回的会话凭据 */
export interface StoredSession {
  token: string
  sessionId: string
  /** ISO 时间；过期后服务端返回 40103，由全局拦截清会话跳登录 */
  expiresAt: string
  /**
   * 签发面板地址（`panelAddress()` 归一后的值）。会话只在签发它的面板有效：
   * 地址不一致时不发 Bearer（避免拿 A 的令牌打 B 面板换 40103 被踢下线），
   * 缺失＝旧会话，按适用处理（宽限到下次登录）。
   */
  issuedFor?: string
}

function readInitialSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (
      typeof parsed.token === 'string' &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return {
        token: parsed.token,
        sessionId: parsed.sessionId,
        expiresAt: parsed.expiresAt,
        ...(typeof parsed.issuedFor === 'string' && parsed.issuedFor !== ''
          ? { issuedFor: parsed.issuedFor }
          : {}),
      }
    }
  } catch {
    // 解析失败按未登录处理
  }
  return null
}

interface AuthState {
  session: StoredSession | null
  setSession: (session: StoredSession) => void
  clearSession: () => void
}

export const useAuthStore = create<AuthState>()((set) => ({
  session: readInitialSession(),
  setSession: (session) => {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    } catch {
      // 持久化失败不影响内存态（仅刷新后需重登）
    }
    set({ session })
  },
  clearSession: () => {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY)
    } catch {
      // 忽略
    }
    set({ session: null })
  },
}))

/** 非 React 上下文读取会话（loader/client.ts 用） */
export function getStoredSession(): StoredSession | null {
  return useAuthStore.getState().session
}

/**
 * 旧会话（无签发面板信息）在本面板被服务端接受后回填签发面板。
 * 地址能用本机令牌打通，就证明它就是签发方——把「无限宽限」收敛为「一次请求宽限」，
 * 否则持续使用（7 天滑动续期）的用户永远走不到重新登录，旧症状会一直留在他们身上。
 */
export function backfillSessionPanel(baseUrl: string): void {
  const { session, setSession } = useAuthStore.getState()
  if (!session?.token || session.issuedFor) return
  setSession({ ...session, issuedFor: panelAddress(baseUrl) })
}

/**
 * 全局会话过期事件（client.ts 检测 40103 时派发）。
 * routes.tsx 监听后跳登录页（router.navigate 与路由模式无关，
 * history/hash 两种部署形态下均正确）。
 */
export const SESSION_EXPIRED_EVENT = 'mcs:session-expired'

/** 会话过期统一处置：清会话 + 派发全局事件（client.ts 单一入口） */
export function clearSessionAndDispatchExpired(): void {
  useAuthStore.getState().clearSession()
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
}
