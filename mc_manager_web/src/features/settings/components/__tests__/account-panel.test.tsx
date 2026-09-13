/**
 * AccountPanel 测试（账号与安全面板）：
 * - 修改密码脏状态守卫：空表单放行 / 半填拦截 / 提交成功解除
 * - 退出登录：会话与残留 API Key 一并清除并落到 /login（只清会话会被 requireUnconfigured 弹回）
 * mock 数据为结构占位（虚构凭据），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, redirect, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster, toast as sonnerToast } from 'sonner'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { handlers } from '@/test/mocks/handlers'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { AccountPanel } from '../account-panel'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
// 运行时 handler 会累积到后续用例
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/**
 * AccountPanel 挂在 /settings/account 子路由（真实挂载点）；
 * useUnsavedGuard 依赖 data router 上下文（useBlocker），
 * 「前往其他页」Link 模拟设置页左子导航切换面板（/settings/account → /settings/* 同为路由跳转）
 */
function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/settings/account',
        element: (
          <>
            <Link to="/settings/general">前往其他页</Link>
            <AccountPanel />
          </>
        ),
      },
      { path: '/settings/general', element: <div>其他页面</div> },
      { path: '/dashboard', element: <div>仪表盘占位</div> },
      {
        path: '/login',
        // 复刻 routes.tsx 的 requireUnconfigured 守卫（仍有凭据则弹回）：让落点断言真能拦住回退
        loader: () =>
          useAuthStore.getState().session?.token || useConnectionStore.getState().apiKey
            ? redirect('/dashboard')
            : null,
        element: <div>登录页占位</div>,
      },
    ],
    { initialEntries: ['/settings/account'] },
  )
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  localStorage.clear()
  sonnerToast.dismiss()
  // API Key 直连模式（authed=true）：会话列表请求走 handlers mock，改密仍可用
  useAuthStore.setState({ session: null })
  useConnectionStore.setState({
    baseUrl: 'https://192.168.1.100:25566',
    apiKey: 'demo-key-123',
    status: 'ready',
  })
})

describe('AccountPanel 修改密码脏状态守卫', () => {
  it('表单为空（dirty=false）：导航直接放行', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByText('前往其他页'))
    expect(await screen.findByText('其他页面')).toBeInTheDocument()
    expect(screen.queryByText('密码修改尚未提交')).not.toBeInTheDocument()
  })

  it('输入一半（dirty）：导航被拦截弹确认；留下回滚、离开放行', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.type(screen.getByLabelText('当前密码'), 'old-pass-123')
    // dirty → 导航被拦截：确认弹窗出现，仍留在面板
    await user.click(screen.getByText('前往其他页'))
    expect(await screen.findByText('密码修改尚未提交')).toBeInTheDocument()
    expect(screen.getByText('离开页面将丢失未提交的密码输入，确定离开吗？')).toBeInTheDocument()
    expect(screen.queryByText('其他页面')).not.toBeInTheDocument()

    // 留下：回滚导航，弹窗关闭，输入保留
    await user.click(screen.getByRole('button', { name: '留下' }))
    expect(screen.queryByText('密码修改尚未提交')).not.toBeInTheDocument()
    expect(screen.getByLabelText('当前密码')).toHaveValue('old-pass-123')

    // 再次离开并确认：放行到目标页
    await user.click(screen.getByText('前往其他页'))
    expect(await screen.findByText('密码修改尚未提交')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '放弃修改并离开' }))
    expect(await screen.findByText('其他页面')).toBeInTheDocument()
  })

  it('提交成功：toast + 表单清空（dirty 自动解除）', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.type(screen.getByLabelText('当前密码'), 'old-pass-123')
    await user.type(screen.getByLabelText('新密码（8–128 位）'), 'new-pass-12345')
    await user.type(screen.getByLabelText('确认新密码'), 'new-pass-12345')
    await user.click(screen.getByRole('button', { name: '更新密码' }))

    expect(await screen.findByText('密码已更新，已下线其他 2 个会话')).toBeInTheDocument()
    expect(screen.getByLabelText('当前密码')).toHaveValue('')
    expect(screen.getByLabelText('新密码（8–128 位）')).toHaveValue('')
    expect(screen.getByLabelText('确认新密码')).toHaveValue('')
  })

  it('提交成功后导航放行（dirty 已解除，不触发守卫）', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.type(screen.getByLabelText('当前密码'), 'old-pass-123')
    await user.type(screen.getByLabelText('新密码（8–128 位）'), 'new-pass-12345')
    await user.type(screen.getByLabelText('确认新密码'), 'new-pass-12345')
    await user.click(screen.getByRole('button', { name: '更新密码' }))
    expect(await screen.findByText('密码已更新，已下线其他 2 个会话')).toBeInTheDocument()

    await user.click(screen.getByText('前往其他页'))
    expect(await screen.findByText('其他页面')).toBeInTheDocument()
    expect(screen.queryByText('密码修改尚未提交')).not.toBeInTheDocument()
  })
})

describe('AccountPanel 登出', () => {
  it('踢会话遇到 40103：不销毁本机 API Key，也不强跳登录页（交回全局通道处置）', async () => {
    useAuthStore.setState({
      session: {
        token: 'sess-token-abc',
        sessionId: 'sess-mock-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    let kickCalled = false
    server.use(
      http.delete('*/api/v1/auth/sessions/:id', () => {
        kickCalled = true
        return HttpResponse.json(
          { status: 'error', code: 40103, message: '会话已过期', details: null },
          { status: 401 },
        )
      }),
    )
    const user = userEvent.setup()
    const router = renderPanel()

    await user.click(await screen.findByRole('button', { name: /下线会话/ }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '下线' }))
    await waitFor(() => expect(kickCalled).toBe(true))

    // 令牌已失效的竞态：40103 归全局通道管（有 Key 就继续用），此处若再清一次会把 Key 一并销毁
    expect(useConnectionStore.getState().apiKey).toBe('demo-key-123')
    expect(router.state.location.pathname).toBe('/settings/account')
    expect(screen.queryByText(/操作失败/)).not.toBeInTheDocument()
  })

  it('退出登录：会话与残留 API Key 一并清除并落到 /login（只清会话会被守卫弹回）', async () => {
    useAuthStore.setState({
      session: {
        token: 'sess-token-abc',
        sessionId: 'sess-mock-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    const user = userEvent.setup()
    const router = renderPanel()

    // 卡片里的登出按钮 → 确认弹窗（两处同名，按弹窗内定位）
    await user.click(screen.getAllByRole('button', { name: '退出登录' })[0]!)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '退出登录' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(useAuthStore.getState().session).toBeNull()
    // 本机 API Key 同批清除：否则 status 仍 ready、/login 被弹回（toast 说已登出人还在面板里）
    expect(useConnectionStore.getState().apiKey).toBe('')
    expect(useConnectionStore.getState().status).toBe('unconfigured')
  })

  it('仅 API Key（无会话）：登出按钮仍可用，清除本机 Key 并落到 /login', async () => {
    // beforeEach 即 Key 直连态（session=null + apiKey=demo-key-123）：
    // 卡片描述承诺清「全部凭据」，那按钮就不能只对会话可达
    const user = userEvent.setup()
    const router = renderPanel()
    const trigger = screen.getAllByRole('button', { name: '退出登录' })[0]!
    expect(trigger).toBeEnabled()

    await user.click(trigger)
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '退出登录' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(useConnectionStore.getState().apiKey).toBe('')
    expect(useConnectionStore.getState().status).toBe('unconfigured')
  })
})
