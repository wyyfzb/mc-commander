import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppShell } from '../app-shell'
import { useUiStore } from '@/stores/ui'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { PlayersPage } from '@/features/players/players-page'

/**
 * AppShell 组件测试：布局渲染 / 导航跳转 / 主题切换 / Cmd+K 面板 / 实例自动选择
 */

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

function instancesOk(data: unknown) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

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
    useUiStore.setState({
      theme: 'dark',
      sidebarCollapsed: false,
      // 抽屉态必须逐例重置：开着抽屉会多渲染一份同名导航链接，撞 strict 模式查询
      mobileNavOpen: false,
      commandPaletteOpen: false,
    })
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

  it('移动抽屉恒按展开态渲染：桌面「收起」态不渗入抽屉（窄屏拖动回归）', () => {
    // 桌面收起 + 抽屉打开（关闭态抽屉 aria-hidden，role 查询取不到）
    useUiStore.setState({ sidebarCollapsed: true, mobileNavOpen: true })
    renderShell()
    // 桌面侧栏确实处于收起态（这条保证下面断言测的是渗漏、不是状态没切成功）
    expect(screen.getByRole('complementary', { name: '主导航' })).toHaveClass('w-14')

    // 抽屉是 256px 浮层、不占布局宽 ⇒ 没有「收起」语义：链接带文字而非图标化
    const drawer = screen.getByRole('complementary', { name: '主导航（移动端）' })
    const link = within(drawer).getByRole('link', { name: '仪表盘' })
    expect(link).toHaveClass('px-2.5')
    expect(link).not.toHaveClass('justify-center')
    expect(link).not.toHaveClass('px-0')
    const label = within(drawer).getByText('仪表盘')
    expect(label).toHaveClass('max-w-28', 'opacity-100')
    expect(label).not.toHaveClass('max-w-0', 'opacity-0')

    // drawer 形态不接入开合交互：整个抽屉里没有「收起/展开侧栏」按钮
    // （rail 的那个在桌面 aside 里，两侧各一个，不会串）
    expect(within(drawer).queryByRole('button', { name: /侧栏/ })).toBeNull()
  })

  // 实例自动选择的两个方向：已选项有效时必须**保留**（以前刷新后一律跳回
  // 列表第一个，用户会对着错误的服务器操作），失效时才回落到第一个。
  describe('实例自动选择', () => {
    function readyWith(instances: Array<{ id: string; name: string }>) {
      useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
      server.use(http.get('*/api/v1/instances', () => instancesOk(instances)))
    }

    it('已选实例仍在列表里：保留该选择，不跳回第一个', async () => {
      // 列表顺序 = 创建时间倒序 ⇒ [0] 是「最新创建」的那个，正是以前会跳过去的位置
      readyWith([
        { id: 'newest', name: '最新实例' },
        { id: 'chosen', name: '我选的那个' },
      ])
      useServerStore.setState({ instanceId: 'chosen' })
      renderShell()
      // 断言顶栏**渲染出**被选中的那个名字：只断言 store 值等于初值的话，
      // 即便自动选择被改成「无条件跳第一个」也照样通过（初值本来就是 chosen
      // → 空转假绿）。顶栏显示「我选的那个」才是保留生效的可观测证据。
      await waitFor(() => {
        expect(screen.getAllByText('我选的那个').length).toBeGreaterThan(0)
      })
      expect(screen.queryByText('最新实例')).not.toBeInTheDocument()
      expect(useServerStore.getState().instanceId).toBe('chosen')
    })

    it('已选实例不在列表里（被删/换了面板）：回落到第一个，不留陈旧 id', async () => {
      readyWith([{ id: 'newest', name: '最新实例' }])
      useServerStore.setState({ instanceId: 'ghost' })
      renderShell()
      // 陈旧 id 保留会让所有 per-instance 查询 404，界面停在加载失败
      await waitFor(() => {
        expect(useServerStore.getState().instanceId).toBe('newest')
      })
    })

    it('未选择过：取第一个', async () => {
      readyWith([
        { id: 'newest', name: '最新实例' },
        { id: 'older', name: '旧实例' },
      ])
      useServerStore.setState({ instanceId: null })
      renderShell()
      await waitFor(() => {
        expect(useServerStore.getState().instanceId).toBe('newest')
      })
    })

    it('列表为空：不选择（也不报错）', async () => {
      readyWith([])
      useServerStore.setState({ instanceId: null })
      renderShell()
      // 给足一拍确认没有副作用
      await new Promise((r) => setTimeout(r, 50))
      expect(useServerStore.getState().instanceId).toBeNull()
    })
  })
})
