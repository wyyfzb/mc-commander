import { useSyncExternalStore } from 'react'
import { resolveTheme, useUiStore, type ResolvedTheme } from '@/stores/ui'

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/** 订阅操作系统配色变化（只在 'system' 档下有消费者，但订阅本身无副作用） */
function subscribeSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(SYSTEM_DARK_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function readSystemDark(): boolean {
  return window.matchMedia(SYSTEM_DARK_QUERY).matches
}

/**
 * 当前**实际生效**的配色（dark / light）。
 *
 * 需要具体调色板的消费者（xterm 主题、Monaco 主题）必须用它而不是 useUiStore().theme：
 * 后者可能是 'system'，不是一种配色。偏好为 'system' 时订阅 prefers-color-scheme，
 * 系统切换后这些消费者才跟着换调色板——只读一次会让终端停在旧配色上。
 */
export function useResolvedTheme(): ResolvedTheme {
  const mode = useUiStore((s) => s.theme)
  // 非 system 档也调用（hooks 不能条件调用）；值不参与计算
  const systemDark = useSyncExternalStore(subscribeSystemTheme, readSystemDark, () => true)
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return resolveTheme(mode)
}
