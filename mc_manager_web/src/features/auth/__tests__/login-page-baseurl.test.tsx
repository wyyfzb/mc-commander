/**
 * LoginPage baseUrl 初值回归测试：
 * store 已配置面板地址时，登录页未触碰地址栏 → 探测与登录都打该地址、会话绑定该面板。
 * 修复前初值为空串（同源根）：登录 POST 走同源根、会话却登记成 store 地址（凭据错配，
 * 见 pending-improvements 清单 J59）。
 * 判别法：同源根的探测返回「未设密」（落设密模式），已配置地址的探测返回「已设密」
 * （落登录模式）——初值若为同源根，页面会停在设密模式。
 * mock 数据为虚构内容（TEST-NET-3 文档保留段地址），严禁真实服务器信息
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

/** TEST-NET-3 文档保留段虚构分域地址 */
const CONFIGURED_BASE = 'http://203.0.113.10:25566'

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

describe('LoginPage baseUrl 初值（store 已配置地址）', () => {
  it('用户未触碰地址栏：探测与登录都打 store 地址，会话绑定该面板', async () => {
    useConnectionStore.getState().setConfig({ baseUrl: CONFIGURED_BASE })
    server.use(
      // MSW 先注册先匹配：已配置地址的处理器必须在前，同源根兜底在后
      http.get(`${CONFIGURED_BASE}/api/v1/auth/status`, () => okEnvelope({ hasPassword: true })),
      http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })),
    )
    renderLoginPage()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: '管理员登录' })).toBeInTheDocument(),
    )
    // 设密模式标题不得出现（初值若为同源根，探测落同源根 → 设密模式）
    expect(screen.queryByText('设置管理员密码')).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('管理员密码'), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
    // 会话绑定与请求同址（非同源根）
    expect(useAuthStore.getState().session?.issuedFor).toBe(CONFIGURED_BASE)
    // 未触碰地址 → 不写回（既有回归锁，此处顺带确认写回值未被空串污染）
    expect(useConnectionStore.getState().baseUrl).toBe(CONFIGURED_BASE)

    useConnectionStore.getState().setConfig({ baseUrl: '' })
  })
})
