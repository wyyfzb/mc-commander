import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { resolveTheme, useUiStore, type ResolvedTheme, type ThemeMode } from '@/stores/ui'

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/** 订阅操作系统配色变化（matchMedia 不可用时返回空订阅） */
function subscribeSystemTheme(onChange: () => void): () => void {
  let media: MediaQueryList
  try {
    media = window.matchMedia(SYSTEM_DARK_QUERY)
  } catch {
    return () => {}
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** matchMedia 不可用时回退 dark（与 resolveTheme 的 catch 一致） */
function readSystemDark(): boolean {
  try {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches
  } catch {
    return true
  }
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

let activeReveal: { transition: ViewTransition; commit: () => void } | undefined

/** 只有显式操作带来配色变化时才截图；偏好持久化不依赖动效。 */
export function changeThemeFrom(origin: HTMLElement | null, mode?: ThemeMode) {
  if (activeReveal) {
    // skipTransition 不会取消尚未运行的更新回调。先兑现上一笔意图，再解析下一笔。
    activeReveal.transition.skipTransition()
    activeReveal.commit()
  }

  const { theme, setTheme } = useUiStore.getState()
  if (theme === mode) return
  const current = resolveTheme(theme)
  // 快照回调可能晚于系统换色，目标必须在本次操作时确定。
  const nextMode = mode ?? (current === 'dark' ? 'light' : 'dark')
  const applyTheme = () => setTheme(nextMode)
  if (
    !origin?.isConnected ||
    current === resolveTheme(nextMode) ||
    typeof document.startViewTransition !== 'function' ||
    !window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches
  ) {
    applyTheme()
    return
  }

  const { left, top, width, height } = origin.getBoundingClientRect()
  const x = left + width / 2
  const y = top + height / 2
  const radius = Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)))
  const root = document.documentElement
  root.style.setProperty('--mcs-theme-reveal-x', `${x}px`)
  root.style.setProperty('--mcs-theme-reveal-y', `${y}px`)
  root.style.setProperty('--mcs-theme-reveal-radius', `${radius}px`)
  root.setAttribute('data-theme-reveal', 'capture')

  let committed = false
  const commit = () => {
    if (committed) return
    committed = true
    // 同一次 React 提交更新根类名和配色消费者，避免新快照仍是旧主题。
    flushSync(applyTheme)
  }
  const clearReveal = () => {
    root.removeAttribute('data-theme-reveal')
    root.style.removeProperty('--mcs-theme-reveal-x')
    root.style.removeProperty('--mcs-theme-reveal-y')
    root.style.removeProperty('--mcs-theme-reveal-radius')
  }

  let transition: ViewTransition
  try {
    transition = document.startViewTransition(commit)
  } catch {
    activeReveal = undefined
    clearReveal()
    applyTheme()
    return
  }
  activeReveal = { transition, commit }
  const finish = () => {
    if (activeReveal?.transition !== transition) return
    activeReveal = undefined
    clearReveal()
  }
  // 快照就绪后恢复各控件自己的过渡；跳过快照仍会执行更新回调。
  void transition.ready.then(
    () => {
      if (activeReveal?.transition === transition) root.setAttribute('data-theme-reveal', '')
    },
    () => {},
  )
  void transition.finished.then(finish, finish)
}
