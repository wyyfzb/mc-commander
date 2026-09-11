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
import { handlers } from '@/test/mocks/handlers'
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
      session: { token: 'sess-token-abc', sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
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
})
