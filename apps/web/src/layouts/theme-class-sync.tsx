import { useLayoutEffect } from 'react'
import { resolveTheme, useUiStore } from '@/stores/ui'

/**
 * ThemeClassSync —— 根级主题同步：html.classList = dark / light
 *
 * 偏好是 'system' 时跟随操作系统：监听 prefers-color-scheme 的变化即时换档，
 * 而不是只在挂载时读一次（用户在系统设置里切主题后面板要跟着动）。
 *
 * 用 useLayoutEffect 而非 useEffect：读 CSS 变量的消费者（Monaco 主题注册）也在
 * layout 阶段读——若类名等到 passive effect 才落，那些消费者读到的是上一档的值。
 * 本组件在树里排在路由之前，layout effect 按树序执行，故消费者总能读到新档。
 *
 * 首帧由 `/theme-init.js`（同源外链，CSP 放行）负责：React 挂载前就把类名放好，
 * 否则持久化成亮色的用户会先看到一帧暗色。本组件只接管之后的变更。
 */
export function ThemeClassSync() {
  const theme = useUiStore((s) => s.theme)

  useLayoutEffect(() => {
    const root = document.documentElement
    const apply = () => {
      const resolved = resolveTheme(theme)
      root.classList.toggle('dark', resolved === 'dark')
      root.classList.toggle('light', resolved === 'light')
    }
    apply()
    if (theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  return null
}
