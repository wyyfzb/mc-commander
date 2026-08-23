import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppShell } from '../app-shell'
import { useUiStore } from '@/stores/ui'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { PlayersPage } from '@/features/players/players-page'

/**
 * AppShell 组件测试：布局渲染 / 导航跳转 / 主题切换 / Cmd+K 面板
 */

function renderShell(initialPath = '/dashboard') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: AppShell,
        children: [
          { path: 'dashboard', element: <div>仪表盘占位</div> },
          { path: 'players', Component: PlayersPage },
          { path: 'world', element: <div>世界占位</div> },
          { path: 'files', element: <div>文件占位</div> },
          { path: 'tasks', element: <div>任务占位</div> },
          { path: 'instances', element: <div>实例占位</div> },
          { path: 'settings', element: <div>设置占位</div> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  )
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('AppShell', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.setState({ theme: 'dark', sidebarCollapsed: false, commandPaletteOpen: false })
    // 未配置连接：useInstances/useServerSocket 均不激活
    useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
    useServerStore.setState({
      status: null,
      systemStats: null,
      instanceId: null,
      socketConnected: false,
      lastStatusEvent: null,
    })
  })

  it('渲染品牌、顶栏元素与侧栏导航', () => {
    renderShell()
    // 桌面侧栏 + 移动抽屉各渲染一份品牌（jsdom 无 md: 断点样式，两者都在 DOM）
    expect(screen.getAllByText('MC Commander').length).toBeGreaterThan(0)
    // 侧栏导航项
    for (const label of ['仪表盘', '玩家', '世界', '文件', '任务', '实例', '设置']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument()
    }
    // 顶栏：搜索按钮 + 未连接状态
    expect(screen.getByRole('button', { name: /搜索或执行命令/ })).toBeInTheDocument()
    expect(screen.getByText('未连接')).toBeInTheDocument()
  })

  it('点击侧栏导航跳转对应页面（玩家页：搜索框/筛选/表格）', async () => {
    renderShell()
    fireEvent.click(screen.getByRole('link', { name: /玩家/ }))
    // 玩家页：搜索框 + 状态筛选（未配置连接时无数据，筛选栏仍渲染）
    expect(await screen.findByPlaceholderText('搜索玩家名或 UUID…')).toBeInTheDocument()
  })

  it('主题切换更新 html class（dark ↔ light）', () => {
    renderShell()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /切换到亮色主题/ }))
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('Cmd+K 打开命令面板；选择页面命令跳转', async () => {
    renderShell()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const input = await screen.findByPlaceholderText('输入页面名称或命令…')
    expect(input).toBeInTheDocument()

    // 选择"世界"跳转（cmdk item role=option，与侧栏导航文本区分）
    fireEvent.click(await screen.findByRole('option', { name: /世界/ }))
    expect(await screen.findByText('世界占位')).toBeInTheDocument()
  })

  it('侧栏折叠按钮切换宽度状态', () => {
    renderShell()
    const aside = screen.getByRole('complementary', { name: '主导航' })
    expect(aside).not.toHaveClass('w-14')
    fireEvent.click(screen.getByRole('button', { name: /折叠侧栏/ }))
    expect(aside).toHaveClass('w-14')
  })
})
