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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

  it('实例列表未就绪时顶栏不假造实例名（空/失败/加载三态断言见 app-topbar.test.tsx）', () => {
    renderShell()
    // 本文件未挂 MSW 且连接未配置 → 列表永不就绪，名字位应是中性占位而非编造的实例名
    expect(screen.getByText('加载中…')).toBeInTheDocument()
    expect(screen.queryByText('默认实例')).not.toBeInTheDocument()
  })

  it('点击侧栏导航跳转对应页面（玩家页：搜索框/筛选/表格）', async () => {
    // 玩家页本体要求已选中实例（无实例时展示实例门，见 InstanceRequiredState）
    useConnectionStore.setState({ apiKey: 'test-key', status: 'ready' })
    useServerStore.setState({ instanceId: 'demo' })
    renderShell()
    fireEvent.click(screen.getByRole('link', { name: /玩家/ }))
    // 玩家页：搜索框 + 状态筛选（列表即便取不到，筛选栏仍渲染）
    expect(await screen.findByPlaceholderText('搜索玩家名或 UUID…')).toBeInTheDocument()
  })

  it('顶栏主题按钮切换 store 状态（html class 联动由根级 ThemeClassSync 负责）', () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: /切换到亮色主题/ }))
    expect(screen.getByRole('button', { name: /切换到深色主题/ })).toBeInTheDocument()
    expect(useUiStore.getState().theme).toBe('light')
  })

  it('Cmd+K 打开命令面板；选择页面命令跳转', async () => {
    renderShell()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const input = await screen.findByPlaceholderText('输入页面名称或命令…')
    expect(input).toBeInTheDocument()

    // 选择"世界"跳转（cmdk item role=option，与侧栏导航文本区分）
    fireEvent.click(await screen.findByRole('option', { name: /世界/ }))
    expect(await screen.findByText('世界占位')).toBeInTheDocument()

    // 回归：命令面板页面组必须包含「插件」「Webhook」（此前漏配导致 Ctrl+K 无法跳转）
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(await screen.findByRole('option', { name: /插件/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Webhook/ })).toBeInTheDocument()
  })

  it('侧栏 Logo 开合按钮切换宽度状态（开合交互归属侧栏本体）', () => {
    renderShell()
    const aside = screen.getByRole('complementary', { name: '主导航' })
    expect(aside).not.toHaveClass('w-14')
    fireEvent.click(screen.getByRole('button', { name: /收起侧栏/ }))
    expect(aside).toHaveClass('w-14')
    fireEvent.click(screen.getByRole('button', { name: /展开侧栏/ }))
    expect(aside).not.toHaveClass('w-14')
  })
})
