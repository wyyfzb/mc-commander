/**
 * useUnsavedGuard —— 编辑未保存导航守卫
 * - when=true 时拦截路由导航（react-router useBlocker，data router 必需）+ 浏览器关闭/刷新（beforeunload）
 * - 拦截后由调用方渲染确认 Dialog（isBlocked 开关），用户选择后调用 proceed（离开）/ cancel（留在当前页）
 * - 与 files-page 的脏关闭确认互补：本 hook 管「离开页面」，组件内自管理管「关闭面板」
 *
 * 用法：
 *   const guard = useUnsavedGuard(dirty)
 *   <Dialog open={guard.isBlocked}>…<Button onClick={guard.cancel}>留下</Button><Button onClick={guard.proceed}>离开</Button></Dialog>
 */
import { useEffect } from 'react'
import { useBlocker } from 'react-router'

export interface UnsavedGuardResult {
  /** 导航被拦截、等待用户确认（渲染确认 Dialog 的开关） */
  isBlocked: boolean
  /** 用户确认离开当前页（放行导航） */
  proceed: () => void
  /** 用户取消离开（留在当前页，导航回滚） */
  cancel: () => void
}

export function useUnsavedGuard(when: boolean): UnsavedGuardResult {
  const blocker = useBlocker(when)

  // 浏览器关闭/刷新保护（beforeunload；现代浏览器仅显示通用提示，custom message 不展示）
  useEffect(() => {
    if (!when) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [when])

  return {
    isBlocked: blocker.state === 'blocked',
    proceed: () => {
      if (blocker.state === 'blocked') blocker.proceed()
    },
    cancel: () => {
      if (blocker.state === 'blocked') blocker.reset()
    },
  }
}
