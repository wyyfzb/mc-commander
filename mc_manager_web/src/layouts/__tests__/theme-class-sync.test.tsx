import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { ThemeClassSync } from '../theme-class-sync'
import { useUiStore } from '@/stores/ui'

/**
 * ThemeClassSync 组件测试：store 主题 ↔ html class 同步（AppShell 外路由的主题来源）
 */

describe('ThemeClassSync', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    useUiStore.setState({ theme: 'dark' })
  })

  it('初始渲染即同步 store 主题（覆盖 index.html 初始 .dark 假设）', () => {
    useUiStore.setState({ theme: 'light' })
    render(<ThemeClassSync />)
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('store 主题变化联动 html class（dark ↔ light）', () => {
    render(<ThemeClassSync />)
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    act(() => useUiStore.getState().setTheme('light'))
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    act(() => useUiStore.getState().setTheme('dark'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })
})
