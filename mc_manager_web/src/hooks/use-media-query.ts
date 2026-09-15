/**
 * useMediaQuery —— 响应式媒体查询 hook
 * - useSyncExternalStore：无 setState-in-effect 级联，首渲染即真实值
 * - 断点常量与 Tailwind md/lg 断点对齐（files 双栏、玩家详情面板窄屏降级共用）
 * - 「全屏承载（Sheet）还是内联并列」的判定必须与容器内部以 lg: 表达的重排口径一致，
 *   否则 768–1023px 会出现「内联窄列 + 窄屏排布」的错配
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
/** lg 以下：容器里没有并列空间，一律改由 Sheet 承载（不挤压内容列） */
export const BREAKPOINT_BELOW_LG = '(max-width: 1023px)'
/** sm 以下：无横向并排空间，玩家表由表格转行式卡片（J28/C3） */
export const BREAKPOINT_BELOW_SM = '(max-width: 639px)'
/** xl 以下：10 列玩家表合计约 1016px，容器装不下时裁到核心列（免横向滚动，J28） */
export const BREAKPOINT_BELOW_XL = '(max-width: 1279px)'
