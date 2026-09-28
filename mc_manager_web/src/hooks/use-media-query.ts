import { useSyncExternalStore } from 'react'

/**
 * useMediaQuery —— 视口媒体查询 hook
 * - useSyncExternalStore：无 setState-in-effect 级联，首渲染即真实值
 *
 * 适用范围已收窄：凡「这一块有多宽」可问容器的场景，一律改用 `useContainerWidth`
 * （ResizeObserver 测实宽）——侧栏可折叠（56px ↔ 208px）、md 以下退化成抽屉（不占布局宽）、
 * 主从页还会被右层面板借走宽度，同一视口下容器实宽能差出六百多 px，视口断点判不准。
 * 剩下的 `BREAKPOINT_BELOW_SM` 是唯一仍在用的视口档，且是刻意保守的选型：卡片态把一行
 * 摊成「姓名（与徽标同行）+ 摘要行」两行（见 player-card-list.tsx），比紧凑 4 列表格更适合
 * 窄屏阅读，因此阈值取视口而非表格区实宽（抽屉侧栏下 512–639 视口的内容宽其实放得下紧凑表，
 * 仍选卡片态）
 */
/** 响应式媒体查询 hook（useSyncExternalStore：无 setState-in-effect 级联，首渲染即真实值） */
export function useMediaQuery(query: string, initialValue = false): boolean {
  const subscribe = (onStoreChange: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener('change', onStoreChange)
    return () => mql.removeEventListener('change', onStoreChange)
  }
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => initialValue,
  )
}

/** sm 以下：无横向并排空间，玩家表由表格转行式卡片 */
export const BREAKPOINT_BELOW_SM = '(max-width: 639px)'
