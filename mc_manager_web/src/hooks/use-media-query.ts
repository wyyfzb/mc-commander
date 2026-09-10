/**
 * useMediaQuery —— 响应式媒体查询 hook
 * - useSyncExternalStore：无 setState-in-effect 级联，首渲染即真实值
 * - 断点常量与 Tailwind md/lg 断点对齐（files 双栏、玩家详情面板窄屏降级共用）
 */
import { useSyncExternalStore } from 'react'

/** 响应式媒体查询 hook（useSyncExternalStore：无 setState-in-effect 级联，首渲染即真实值） */
export function useMediaQuery(query: string, initialValue = false): boolean {
  const subscribe = (onStoreChange: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener('change', onStoreChange)
    return () => mql.removeEventListener('change', onStoreChange)
  }
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => initialValue)
}

/** 断点常量（与 Tailwind md/lg 断点对齐） */
export const BREAKPOINT_MOBILE = '(max-width: 767px)'
export const BREAKPOINT_NARROW = '(min-width: 768px) and (max-width: 1023px)'
