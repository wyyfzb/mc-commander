/**
 * LoginPage 测试（登录/首访设密三态）：
 * - 探测驱动：hasPassword=true → 登录模式；false → 设密模式；后端不可达 → 错误态
 * - 登录成功：写会话（auth store）+ 状态同步（connection ready）+ 跳转
 * - 设密校验：强度条渲染 / 两次密码不一致报错不提交
 * - 服务端错误：40102 密码错误显示友好文案；40911 抢先设密 → 切回登录模式
 * - returnTo 回跳
 * mock 数据为结构占位（虚构凭据），严禁真实服务器信息
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

/** MemoryRouter 包装：/login + /dashboard + /onboarding 兜底，供跳转断言 */
function renderLoginPage(initialPath = '/login') {
  const router = createMemoryRouter(
    [
      { path: '/login', Component: LoginPage },
      { path: '/dashboard', Component: () => <div>dashboard-reached</div> },
      { path: '/onboarding', Component: () => <div>onboarding-reached</div> },
      { path: '*', Component: () => <div>fallback-reached</div> },
    ],
    { initialEntries: [initialPath] },
  )
  return render(<RouterProvider router={router} />)
}

function okEnvelope(data: unknown) {
  return HttpResponse.json({ status: 'ok', code: 0, message: 'Success', data, timestamp: '' })
}

describe('LoginPage（登录/首访设密三态）', () => {
  it('已设密 → 登录模式：输入密码登录成功写会话并跳转', async () => {
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: '管理员登录' })).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('管理员密码'), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))

    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
    expect(useAuthStore.getState().session?.token).toBe('mock-session-token-0123456789abcdef')
    // 连接状态同步为 ready（setConfig 内含凭据重算）
    expect(useConnectionStore.getState().status).toBe('ready')
  })

  it('未设密 → 设密模式：强度条可见；两次密码不一致报错不提交', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
    renderLoginPage()
    await waitFor(() => expect(screen.getByRole('heading', { name: '设置管理员密码' })).toBeInTheDocument())

    await userEvent.type(screen.getByLabelText('管理员密码'), 'Abcdef123456')
    expect(screen.getByText(/密码强度/)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('确认密码'), 'Abcdef654321')
    await userEvent.click(screen.getByRole('button', { name: /设置密码并登录/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的密码不一致')
    expect(useAuthStore.getState().session).toBeNull()
  })

  it('设密模式成功路径：写会话 + 跳转', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('确认密码')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('管理员密码'), 'Abcdef123456')
    await userEvent.type(screen.getByLabelText('确认密码'), 'Abcdef123456')
    await userEvent.click(screen.getByRole('button', { name: /设置密码并登录/ }))
    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
    expect(useAuthStore.getState().session?.sessionId).toBe(1)
  })

  it('密码不足 8 位 → 前置拦截不发请求', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('确认密码')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('管理员密码'), 'short1A')
    await userEvent.type(screen.getByLabelText('确认密码'), 'short1A')
    await userEvent.click(screen.getByRole('button', { name: /设置密码并登录/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('密码至少需要 8 位')
    expect(useAuthStore.getState().session).toBeNull()
  })

  it('密码错误（40102）→ 显示服务端友好文案，不跳转', async () => {
    server.use(
      http.post('*/api/v1/auth/login', () =>
        HttpResponse.json(
          { status: 'error', code: 40102, message: '密码错误', details: null, timestamp: '' },
          { status: 401 },
        ),
      ),
    )
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('管理员密码'), 'wrong-pass')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('密码错误')
    expect(useAuthStore.getState().session).toBeNull()
  })

  it('后端不可达 → 错误态 + 重新探测按钮', async () => {
    server.use(http.get('*/api/v1/auth/status', () => HttpResponse.error()))
    renderLoginPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('连接失败')
    expect(screen.getByRole('button', { name: /重新探测/ })).toBeInTheDocument()
  })

  it('returnTo 参数：登录后回跳原页面（非 dashboard）', async () => {
    renderLoginPage('/login?returnTo=%2Fonboarding')
    await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('管理员密码'), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(screen.getByText('onboarding-reached')).toBeInTheDocument())
  })
})
