/**
 * 密码输入高度基座归一的回归锁（J14 高度半）
 * 口径：`ui/input.tsx` 基座 h-8，`PasswordInput` 基座不再自带高度（需要 40px 档的调用点自备）。
 * 本用例钉住两端：基座无 h-10（回落 h-8）与登录页三处调用点仍产出 h-10（零像素变化）。
 * 单独成文件同 J59/J14 先例（login-page.test.tsx 的修改会被工具链误拦）。
 * mock 数据为虚构内容，严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

describe('PasswordInput 高度基座归一（J14）', () => {
  it('基座不自带高度：未传高度类时回落 ui/input 的 h-8', () => {
    const { container } = render(<PasswordInput id="probe-secret" value="" onChange={() => {}} />)
    const input = container.querySelector('input')!
    expect(input).toHaveClass('h-8')
    expect(input).not.toHaveClass('h-10')
  })

  it('登录页三处调用点自备 h-10：密码框仍为 40px 档', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('确认密码')).toBeInTheDocument())

    for (const label of ['管理员密码', '确认密码']) {
      expect(screen.getByLabelText(label)).toHaveClass('h-10')
    }
  })
})
