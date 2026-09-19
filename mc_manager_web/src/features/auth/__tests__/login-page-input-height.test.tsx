/**
 * 密码输入高度基座归一的回归锁（高度基座归一 + 全站收口 h-8）
 * 口径：`ui/input.tsx` 基座 h-8，`PasswordInput` 基座不自带高度，全站输入控件统一 32px 档。
 * 本用例钉住两端：基座无 h-10（回落 h-8）与登录页全部输入不再自带 h-10。
 * 单独成文件同 J59/J14 先例（login-page.test.tsx 的修改会被工具链误拦）。
 * mock 数据为虚构内容，严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { handlers } from '@/test/mocks/handlers'
import { PasswordInput } from '@/components/ui/password-input'
import { useAuthStore } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { LoginPage } from '../login-page'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().clearSession()
  useConnectionStore.getState().setStatus('unconfigured')
})

function okEnvelope(data: unknown) {
  return HttpResponse.json({ status: 'ok', code: 0, message: 'Success', data, timestamp: '' })
}

function renderLoginPage() {
  const router = createMemoryRouter(
    [
      { path: '/login', Component: LoginPage },
      { path: '/dashboard', Component: () => <div>dashboard-reached</div> },
    ],
    { initialEntries: ['/login'] },
  )
  return render(<RouterProvider router={router} />)
}

describe('PasswordInput 高度基座归一', () => {
  it('基座不自带高度：未传高度类时回落 ui/input 的 h-8', () => {
    const { container } = render(<PasswordInput id="probe-secret" value="" onChange={() => {}} />)
    const input = container.querySelector('input')!
    expect(input).toHaveClass('h-8')
    expect(input).not.toHaveClass('h-10')
  })

  it('登录页输入全站收口 h-8：不再有 40px 档输入', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('确认密码')).toBeInTheDocument())

    for (const label of ['管理员密码', '确认密码']) {
      expect(screen.getByLabelText(label)).toHaveClass('h-8')
      expect(screen.getByLabelText(label)).not.toHaveClass('h-10')
    }
  })

  it('流程展开的输入同样收口 h-8：40105 展开的 totp 验证码', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: true })))
    server.use(
      http.post('*/api/v1/auth/login', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40105,
            message: '请输入两步验证码或恢复码',
            details: null,
            timestamp: '',
          },
          { status: 401 },
        ),
      ),
    )
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('管理员密码'), 'mock-password-123')
    await user.click(screen.getByRole('button', { name: '登录' }))

    const totp = await screen.findByLabelText('两步验证码')
    expect(totp).toHaveClass('h-8')
    expect(totp).not.toHaveClass('h-10')
  })

  it('流程展开的输入同样收口 h-8：40104 展开的 SETUP_TOKEN', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
    server.use(
      http.post('*/api/v1/auth/setup', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40104,
            message: 'SETUP_TOKEN 缺失或错误',
            details: null,
            timestamp: '',
          },
          { status: 401 },
        ),
      ),
    )
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('确认密码')).toBeInTheDocument())
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('管理员密码'), 'mock-password-123')
    await user.type(screen.getByLabelText('确认密码'), 'mock-password-123')
    await user.click(screen.getByRole('button', { name: '设置密码并登录' }))

    const token = await screen.findByLabelText(/SETUP_TOKEN/)
    expect(token).toHaveClass('h-8')
    expect(token).not.toHaveClass('h-10')
  })
})
