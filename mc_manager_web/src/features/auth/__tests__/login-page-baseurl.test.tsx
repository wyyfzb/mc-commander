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

/**
 * 面板地址展示：分域部署时登录请求的目标 ≠ 当前页面 origin，用户需在输入密码前
 * 看到凭据会发往哪块面板。展示值必须与「登录请求目标 + 会话绑定 issuedFor」同源同一函数
 * （panelAddress），否则三者可能各说各话——故这里既锁渲染值，也锁它与 issuedFor 的恒等。
 * 呈现形态锁纯文本：做成输入框会被误当可输入项（焦点环 / iOS 聚焦放大 / 多余 Tab 停靠点）。
 */
describe('LoginPage 面板地址展示（凭据去向可见）', () => {
  /** 状态探测替身：固定三态（默认 handlers 也含 status，此处显式覆盖以免依赖注册顺序） */
  function useStatus(hasPassword: boolean | 'error') {
    server.use(
      http.get('*/api/v1/auth/status', () =>
        hasPassword === 'error' ? HttpResponse.error() : okEnvelope({ hasPassword }),
      ),
    )
  }

  function hiddenUsernameField() {
    return document.querySelector('input[name="username"]') as HTMLInputElement | null
  }

  it('以纯文本展示归一化后的生效地址（≠ 原始输入），不渲染成可交互输入框', async () => {
    // 判别性输入：原始串与 panelAddress 归一结果不同——实现若改成直接渲染 baseUrl 必红
    useConnectionStore.getState().setConfig({ baseUrl: 'HTTPS://Panel.Example.COM:443/' })
    useStatus(true)
    renderLoginPage()

    expect(await screen.findByText('https://panel.example.com')).toBeInTheDocument()
    // 不可交互：没有以「面板地址」为名的可聚焦控件（输入框形态会带来焦点环与 iOS 聚焦放大）
    expect(screen.queryByLabelText('面板地址')).not.toBeInTheDocument()
  })

  it('username 槽视觉隐藏：只服务表单语义，不参与交互', async () => {
    useConnectionStore.getState().setConfig({ baseUrl: 'https://panel.example.com' })
    useStatus(true)
    renderLoginPage()

    await screen.findByText('https://panel.example.com')
    const hidden = hiddenUsernameField()
    expect(hidden).not.toBeNull()
    expect(hidden?.value).toBe('https://panel.example.com')
    // 提示抑制与密码管理器条目的依据
    expect(hidden).toHaveAttribute('autocomplete', 'username')
    // 隐藏 + 只读 + 出 Tab 序：不显示成假地址、不被误当可输入项
    expect(hidden).toHaveAttribute('hidden')
    expect(hidden).toHaveAttribute('readonly')
    expect(hidden?.tabIndex).toBe(-1)
  })

  it('未配置（同源部署）：展示当前站点根', async () => {
    useConnectionStore.getState().setConfig({ baseUrl: '' })
    useStatus(true)
    renderLoginPage()

    expect(await screen.findByText(window.location.origin)).toBeInTheDocument()
  })

  it('展示值 = 登录后会话绑定 issuedFor（凭据去向即会话身份）', async () => {
    useConnectionStore.getState().setConfig({ baseUrl: 'HTTPS://Panel.Example.COM:443/' })
    useStatus(true)
    renderLoginPage()

    await screen.findByText('https://panel.example.com')
    const shown = hiddenUsernameField()?.value

    await userEvent.type(screen.getByLabelText('管理员密码'), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
    expect(useAuthStore.getState().session?.issuedFor).toBe(shown)
  })

  it('设密态同样展示；连接失败态不出现（地址入口仍走渐进披露）', async () => {
    useConnectionStore.getState().setConfig({ baseUrl: '' })

    useStatus(false)
    const setup = renderLoginPage()
    expect(await screen.findByText(window.location.origin)).toBeInTheDocument()
    setup.unmount()

    useStatus('error')
    renderLoginPage()
    expect(await screen.findByRole('heading', { name: '连接面板' })).toBeInTheDocument()
    expect(screen.queryByText('面板地址')).not.toBeInTheDocument()
  })
})
