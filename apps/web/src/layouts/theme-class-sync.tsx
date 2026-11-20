import { useLayoutEffect } from 'react'
import { useResolvedTheme } from '@/hooks/use-resolved-theme'

/**
 * ThemeClassSync —— 根级主题同步：html.classList = dark / light
 *
 * 依赖解析后的配色（而不是 store 里的偏好）：偏好为 'system' 时，操作系统切换由
 * useResolvedTheme 的 matchMedia 订阅驱动，本组件与 Monaco 等消费者在同一次 React
 * 提交里重渲染；本组件在树里排在路由之前，layout effect 按树序先落类名，消费者随后
 * 才在 layout 阶段读 CSS 变量。
 *
 * 首帧由 `/theme-init.js`（同源外链，CSP 放行）负责：React 挂载前就把类名放好，
 * 否则持久化成亮色的用户会先看到一帧暗色。本组件只接管之后的变更。
 */
export function ThemeClassSync() {
  const theme = useResolvedTheme()

  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.classList.toggle('light', theme === 'light')
  }, [theme])

  return null
}
