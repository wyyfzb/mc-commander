/**
 * AppTopBar 实例名三态（列表语义必须如实）：
 * - 列表确实为空 → 「暂无实例」+ 下拉给出「暂无实例，前往部署」
 * - 列表未到（加载中）→ 中性占位，不得谎报「一个实例都没有」
 * - 列表请求失败 → 「实例列表加载失败」，同样不谎报空
 * - 有实例但未选中 → 「未选择实例」（也不得假造并不存在的实例名）
 * - 退出登录：会话 + 残留 API Key 一并清除并落到 /login（只清会话会被守卫弹回、toast 失真）
 * MSW 拦截实例列表（结构占位虚构数据，严禁真实服务器信息）
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, redirect, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster, toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { handlers, mockInstanceStatus } from '@/test/mocks/handlers'
import { AppTopBar } from '../app-topbar'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

function renderTopbar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/', element: <AppTopBar /> },
      { path: '/dashboard', element: <div>仪表盘占位</div> },
      {
        path: '/login',
        // 复刻 routes.tsx 的 requireUnconfigured 守卫：仍有凭据时弹回仪表盘。
        // 不写这条，测试里的「落到 /login」断言在回退态下同样通过（=空转，复现不了弹回）
        loader: () =>
          useAuthStore.getState().session?.token || useConnectionStore.getState().apiKey
            ? redirect('/dashboard')
            : null,
        element: <div>登录页占位</div>,
      },
    ],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return router
}

/** 打开实例选择器下拉（按可访问名定位触发器） */
async function openInstanceMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name }))
}

function instancesOk(data: unknown) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

// server.use 的运行时处理器会累积到后续用例（否则上一例的失败/空列表会串场）
afterEach(() => {
  server.resetHandlers()
  // 间谍残留会让后续用例读到上一例的 toast（用例中途断言失败时尤甚）
  vi.restoreAllMocks()
})

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: null,
    socketConnected: true,
    lastStatusEvent: null,
  })
})

describe('AppTopBar 实例名三态', () => {
  it('列表为空：显示「暂无实例」+ 下拉给出部署入口', async () => {
    server.use(http.get('*/api/v1/instances', () => instancesOk([])))
    const user = userEvent.setup()
    renderTopbar()
    await openInstanceMenu(user, '暂无实例')
    expect(screen.getByRole('menuitem', { name: '暂无实例，前往部署' })).toBeInTheDocument()
  })

  it('列表加载中：显示中性占位，不谎报「暂无实例」', async () => {
    server.use(http.get('*/api/v1/instances', () => new Promise<Response>(() => {})))
    renderTopbar()
    expect(await screen.findByText('加载中…')).toBeInTheDocument()
    expect(screen.queryByText('暂无实例')).not.toBeInTheDocument()
  })

  it('列表请求失败：显示「实例列表加载失败」，不谎报「暂无实例」', async () => {
    server.use(http.get('*/api/v1/instances', () => HttpResponse.error()))
    renderTopbar()
    expect(await screen.findByText('实例列表加载失败')).toBeInTheDocument()
    expect(screen.queryByText('暂无实例')).not.toBeInTheDocument()
  })

  it('有实例但未选中：显示「未选择实例」，不假造实例名', async () => {
    renderTopbar()
    expect(await screen.findByText('未选择实例')).toBeInTheDocument()
    expect(screen.queryByText('暂无实例')).not.toBeInTheDocument()
    // 未选中实例 → 不渲染实例固定色相点（否则会与占位文案一起假装有个实例）
    const display = screen.getByText('未选择实例')
    expect(display.parentElement?.querySelector('[data-instance-hue]')).toBeNull()
  })

  it('单实例：选择器降级为纯展示（不给下拉触发器），实例名与色相点照常可见', async () => {
    useServerStore.setState({ instanceId: 'demo' })
    renderTopbar()
    const name = await screen.findByText('演示实例')
    // 只有一个选项的下拉除了展开什么也做不了，不该长期占着顶栏一级空间
    expect(screen.queryByRole('button', { name: /演示实例/ })).not.toBeInTheDocument()
    expect(name.parentElement?.querySelector('[data-instance-hue]')).not.toBeNull()
  })

  it('单实例但选中的 id 不在列表里（陈旧 id）：仍给下拉，可把唯一实例选回来', async () => {
    useServerStore.setState({ instanceId: 'ghost' })
    const user = userEvent.setup()
    renderTopbar()
    // 此时顶栏没有可点的实例名 → 降级为纯展示会把用户锁死在「未选择实例」上
    await openInstanceMenu(user, '未选择实例')
    expect(await screen.findByRole('menuitem', { name: /演示实例/ })).toBeInTheDocument()
  })

  // 地址 chip：内网地址必须显式标注，否则用户照着「复制给玩家」却连不上且无线索。
  // 判据来自服务端契约 addressType，前端不自己按网段猜（双端各判一次必然漂移）。
  it('addressType=private：chip 标注「内网地址」并改用警示色', async () => {
    server.use(
      http.get('*/api/v1/instances/:id', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: { ...mockInstanceStatus, address: '10.1.2.3:25565', addressType: 'private' },
          timestamp: new Date().toISOString(),
        }),
      ),
    )
    useServerStore.setState({ instanceId: 'demo' })
    renderTopbar()
    // 地址照常可见（仍有用：同一网络内可直连），但必须带「内网地址」标注
    expect(await screen.findByText('10.1.2.3:25565')).toBeInTheDocument()
    expect(screen.getByText('内网地址')).toBeInTheDocument()
  })

  it('addressType=public：不出现「内网地址」标注', async () => {
    server.use(
      http.get('*/api/v1/instances/:id', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: { ...mockInstanceStatus, address: '1.2.3.4:25565', addressType: 'public' },
          timestamp: new Date().toISOString(),
        }),
      ),
    )
    useServerStore.setState({ instanceId: 'demo' })
    renderTopbar()
    expect(await screen.findByText('1.2.3.4:25565')).toBeInTheDocument()
    expect(screen.queryByText('内网地址')).not.toBeInTheDocument()
  })

  it('复制内网地址：提示「公网玩家连不上」，不只回「已复制」', async () => {
    const user = userEvent.setup()
    const warning = vi.spyOn(toast, 'warning')
    const success = vi.spyOn(toast, 'success')
    server.use(
      http.get('*/api/v1/instances/:id', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: { ...mockInstanceStatus, address: '10.1.2.3:25565', addressType: 'private' },
          timestamp: new Date().toISOString(),
        }),
      ),
    )
    useServerStore.setState({ instanceId: 'demo' })
    renderTopbar()
    await screen.findByText('10.1.2.3:25565')
    await user.click(screen.getByRole('button', { name: '复制服务器地址' }))
    // 用户复制它就是为了发给玩家，而这份地址玩家多半连不上——必须说清楚
    await waitFor(() => expect(warning).toHaveBeenCalled())
    expect(success).not.toHaveBeenCalled()
  })

  it('多实例：仍给下拉，可切换实例', async () => {
    server.use(
      http.get('*/api/v1/instances', () =>
        instancesOk([
          { ...mockInstanceStatus, isRunning: true },
          { ...mockInstanceStatus, id: 'demo-2', name: '第二实例', isRunning: false },
        ]),
      ),
    )
    useServerStore.setState({ instanceId: 'demo' })
    const user = userEvent.setup()
    renderTopbar()

    await openInstanceMenu(user, '演示实例')
    expect(await screen.findByRole('menuitem', { name: /第二实例/ })).toBeInTheDocument()
  })

  it('已选中实例：实例名旁渲染该实例的固定色相点（类名钉死，映射漂移即红）', async () => {
    useServerStore.setState({ instanceId: 'demo' })
    renderTopbar()
    const name = await screen.findByText('演示实例')
    const dot = name.parentElement?.querySelector('[data-instance-hue]')
    expect(dot).not.toBeNull()
    // 字面量断言（不调 instanceHueFillClass 自证）：demo → slot 3；改哈希或改槽位映射都会让本用例变红
    expect(dot).toHaveClass('bg-mcs-identity-3')
    expect(dot).toHaveAttribute('aria-hidden')
  })

  it('搜索按钮的快捷键提示按平台取词（macOS 是 ⌘，其余是 Ctrl）', () => {
    renderTopbar()
    // jsdom 的平台是 Linux：提示必须与 handler 接受的按键一致，且不能给 mac 用户错误提示
    expect(screen.getByRole('button', { name: '搜索或执行命令' })).toHaveTextContent('Ctrl K')
  })

  it('macOS 平台下提示改为 ⌘ K', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    renderTopbar()
    const trigger = screen.getByRole('button', { name: '搜索或执行命令' })
    expect(trigger).toHaveTextContent('⌘ K')
    expect(trigger).not.toHaveTextContent('Ctrl K')
  })

  it('仅 API Key（无会话）：登出并如实报告 Key 已一并清除', async () => {
    const infoSpy = vi.spyOn(toast, 'info')
    useAuthStore.setState({ session: null })
    useConnectionStore.setState({ baseUrl: '', apiKey: 'stored-key-abc', status: 'ready' })
    const user = userEvent.setup()
    const router = renderTopbar()

    // 该通道无服务端会话：菜单里只有 Key 直连分支的「退出登录」
    await user.click(screen.getByRole('button', { name: 'API Key 直连状态' }))
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(useConnectionStore.getState().apiKey).toBe('')
    // 文案求值必须在清凭据之前：清完再取会恒判「没清过」，本分支就永远只说「已退出登录」
    expect(infoSpy).toHaveBeenCalledWith('已退出登录，本机保存的 API Key 已一并清除')
  })

  it('退出登录：会话与残留 API Key 一并清除并落到 /login（只清会话会被守卫弹回）', async () => {
    useAuthStore.setState({
      session: {
        token: 'sess-token-abc',
        sessionId: 'sess-mock-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    useConnectionStore.setState({ baseUrl: '', apiKey: 'stored-key-abc', status: 'ready' })
    const user = userEvent.setup()
    const router = renderTopbar()

    await user.click(screen.getByRole('button', { name: '管理员菜单' }))
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(useAuthStore.getState().session).toBeNull()
    expect(useConnectionStore.getState().apiKey).toBe('')
    // 凭据全清 → 未配置态：requireUnconfigured 不再把 /login 弹回面板
    expect(useConnectionStore.getState().status).toBe('unconfigured')
  })

  it('会话属于别的面板：按 API Key 直连呈现，登出仍清掉本机那条会话', async () => {
    useAuthStore.setState({
      session: {
        token: 'sess-token-abc',
        sessionId: 'sess-mock-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        issuedFor: 'https://panel-a.example.com',
      },
    })
    useConnectionStore.setState({ baseUrl: '', apiKey: 'stored-key-abc', status: 'ready' })
    const user = userEvent.setup()
    const router = renderTopbar()

    // 本面板用不上那条会话（异地址不发 Bearer）→ 不得呈现为管理员会话
    expect(screen.queryByRole('button', { name: '管理员菜单' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'API Key 直连状态' }))
    expect(await screen.findByText('API Key 直连')).toBeInTheDocument()
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(useAuthStore.getState().session).toBeNull()
  })
})
