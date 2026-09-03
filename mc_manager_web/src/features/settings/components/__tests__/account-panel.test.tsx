/**
 * AccountPanel 测试（账号与安全面板——修改密码表单脏状态守卫）：
 * - 表单为空（dirty=false）→ 导航直接放行
 * - 输入一半（dirty）→ 导航被拦截弹「未保存」确认；留下回滚、离开放行
 * - 提交成功：toast + 表单清空（dirty 自动解除）→ 再导航不被拦截
 * mock 数据为结构占位（虚构凭据），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster, toast as sonnerToast } from 'sonner'
import { setupServer } from 'msw/node'
import { handlers } from '@/test/mocks/handlers'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { AccountPanel } from '../account-panel'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
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
    ],
    { initialEntries: ['/settings/account'] },
  )
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  )
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
