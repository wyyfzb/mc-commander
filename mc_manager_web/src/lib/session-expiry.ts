/**
 * 会话过期（40103）的全局处置：落点决策 + 监听器接线（routes.tsx 调用一次）。
 * 拆出 installSessionExpiryHandler 是为了让**接线本身**可测——
 * 只有纯函数有用例时，把监听器改回旧写法（无条件跳登录）测试仍会全绿。
 *
 * 关键一条：本机仍持有 API Key 时 connection.status 仍是 ready，此时跳 /login 会被
 * requireUnconfigured 弹回仪表盘（用户被无声挪页、returnTo 也丢）——而双通道设计本就是
 * 「会话没了由 Key 顶上继续用」，故这种情况不跳转，只轻提示一句。
 * 清会话由派发方（auth 的 clearSessionAndDispatchExpired）完成，这里补一次 status 重算。
 */
import { toast } from 'sonner'
import { useConnectionStore, type ConnectionStatus } from '@/stores/connection'
import { SESSION_EXPIRED_EVENT } from '@/stores/auth'

/** @returns 是否应把用户送到登录页 */
export function shouldRedirectToLoginAfterSessionExpiry(
  status: ConnectionStatus,
  currentPath: string,
): boolean {
  if (status === 'ready') return false
  // 已在登录页/引导页时不再跳转（避免循环）
  return currentPath !== '/login' && currentPath !== '/onboarding'
}

/** 监听器只需要 router 的这两处能力（结构化取型，免把 react-router 拉进本模块） */
export interface SessionExpiryRouter {
  state: { location: { pathname: string } }
  navigate: (to: string) => unknown
}

/**
 * 注册全局会话过期监听（模块级一次）。
 * @returns 注销函数（测试与热更新用）
 */
export function installSessionExpiryHandler(router: SessionExpiryRouter): () => void {
  const handler = () => {
    useConnectionStore.getState().refreshStatus()
    const { status } = useConnectionStore.getState()
    const current = router.state.location.pathname
    if (!shouldRedirectToLoginAfterSessionExpiry(status, current)) {
      // id 去重：一次过期会有多个并发请求各自派发事件，提示只应出现一条
      if (status === 'ready') {
        toast.info('登录会话已过期，已转为使用本机保存的 API Key', {
          id: 'session-expired-key-fallback',
        })
      }
      return
    }
    const search = new URLSearchParams()
    if (current && current !== '/') search.set('returnTo', current)
    const qs = search.toString()
    void router.navigate(`/login${qs ? `?${qs}` : ''}`)
  }
  window.addEventListener(SESSION_EXPIRED_EVENT, handler)
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler)
}
