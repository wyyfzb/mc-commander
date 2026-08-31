import { useEffect } from 'react'
import { useUiStore } from '@/stores/ui'

/**
 * ThemeClassSync —— 根级主题同步：html.classList = dark（默认）/ light（亮色）
 * 须挂在 AppShell 外（main.tsx 根级）：登录页/引导页等无壳路由也要跟随主题，
 * 且 index.html 初始 .dark 仅为防首屏闪烁，实际状态以 store 为准
 */
export function ThemeClassSync() {
  const theme = useUiStore((s) => s.theme)
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.classList.toggle('light', theme === 'light')
  }, [theme])
  return null
}
