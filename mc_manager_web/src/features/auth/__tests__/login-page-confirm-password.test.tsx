/**
 * LoginPage 确认密码的清错回归
 * 同表单的「管理员密码」「SETUP_TOKEN」在 onChange 里都会清 errorText，
 * 唯独确认密码不清——「两次输入的密码不一致」会一直挂在页面上直到再次提交。
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

describe('LoginPage 设密模式确认密码', () => {
  beforeEach(() => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
  })

  it('确认密码再次输入时清掉「两次输入的密码不一致」（校验前置失败后不再反复提交）', async () => {
    const user = userEvent.setup()
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('确认密码')).toBeInTheDocument())

    await user.type(screen.getByLabelText('管理员密码'), 'T3st-Panel-2026!')
    await user.type(screen.getByLabelText('确认密码'), 'T3st-Panel-2026?')
    await user.click(screen.getByRole('button', { name: /设置密码并登录/ }))
    expect(await screen.findByText('两次输入的密码不一致')).toBeInTheDocument()

    // 修正确认密码：提示随之消失（不再挂到下次提交）
    await user.type(screen.getByLabelText('确认密码'), '{backspace}!')
    await waitFor(() =>
      expect(screen.queryByText('两次输入的密码不一致')).not.toBeInTheDocument(),
    )
  })
})
