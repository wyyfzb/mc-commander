/**
 * LoginPage 测试（登录/首访设密三态）：
 * - 探测驱动：hasPassword=true → 登录模式；false → 设密模式；后端不可达 → 错误态
 * - 登录成功：写会话（auth store）+ 状态同步（connection ready）+ 跳转
 * - 设密校验：强度条渲染 / 两次密码不一致报错不提交
 * - 服务端错误：40102 密码错误显示友好文案；40911 抢先设密 → 切回登录模式；
 *   40104 SETUP_TOKEN 必需 → 令牌输入框出现，携 Authorization: SetupToken 头重试
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
    // 会话绑定签发面板：同源部署 → 当前站点根（换地址后不再发 Bearer，见 lib/mc-connection）
    expect(useAuthStore.getState().session?.issuedFor).toBe(window.location.origin)
    // 连接状态同步为 ready（setConfig 内含凭据重算）
    expect(useConnectionStore.getState().status).toBe('ready')
  })

  it('未设密 → 设密模式：强度条可见；两次密码不一致报错不提交', async () => {
    server.use(http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })))
    renderLoginPage()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: '设置管理员密码' })).toBeInTheDocument(),
    )

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
    expect(useAuthStore.getState().session?.sessionId).toBe('sess-mock-1')
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

  it('设密 40104（SETUP_TOKEN 必需）→ 展示令牌输入框，携 Authorization: SetupToken 头重试成功', async () => {
    // 虚构令牌（64 位 hex，非真实凭据）：服务端按头校验，错误 403 / 正确 200
    const CORRECT_TOKEN = 'a'.repeat(64)
    const WRONG_TOKEN = 'f'.repeat(64)
    server.use(
      http.get('*/api/v1/auth/status', () => okEnvelope({ hasPassword: false })),
      http.post('*/api/v1/auth/setup', async ({ request }) => {
        const auth = request.headers.get('authorization')
        if (auth !== `SetupToken ${CORRECT_TOKEN}`) {
          return HttpResponse.json(
            {
              status: 'error',
              code: 40104,
              message: 'SETUP_TOKEN 缺失或错误：请携带部署完成时输出的一次性令牌',
              details: null,
              timestamp: '',
            },
            { status: 403 },
          )
        }
        return okEnvelope({
          hasPassword: true,
          token: 'mock-session-token-0123456789abcdef',
          sessionId: 'sess-mock-1',
          expiresAt: '2099-01-01T00:00:00.000Z',
        })
      }),
    )
    renderLoginPage()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: '设置管理员密码' })).toBeInTheDocument(),
    )
    // 初始态不展示令牌输入框（未配置保护的面板零打扰）
    expect(screen.queryByLabelText(/SETUP_TOKEN/)).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('管理员密码'), 'Abcdef123456')
    await userEvent.type(screen.getByLabelText('确认密码'), 'Abcdef123456')
    await userEvent.click(screen.getByRole('button', { name: /设置密码并登录/ }))

    // 首次无凭据头请求被 40104 拒 → 令牌输入框出现 + 错误文案
    const tokenInput = await screen.findByLabelText(/SETUP_TOKEN/)
    expect(screen.getByRole('alert')).toHaveTextContent('SETUP_TOKEN 缺失或错误')

    // 未填 token 直接提交 → 前端拦截不发请求
    await userEvent.click(screen.getByRole('button', { name: /设置密码并登录/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('请输入 SETUP_TOKEN')

    // 错误 token → 服务端仍 40104
    await userEvent.type(tokenInput, WRONG_TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /设置密码并登录/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('SETUP_TOKEN 缺失或错误')

    // 正确 token → 携 SetupToken 头请求成功，写会话并跳转
    await userEvent.clear(screen.getByLabelText(/SETUP_TOKEN/))
    await userEvent.type(screen.getByLabelText(/SETUP_TOKEN/), CORRECT_TOKEN)
    await userEvent.click(screen.getByRole('button', { name: /设置密码并登录/ }))
    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
    expect(useAuthStore.getState().session?.sessionId).toBe('sess-mock-1')
    // 慢机器全量并发超基线（单跑/CI 均绿），放宽上限避免抖动误报
  }, 15000)

  it('returnTo 参数：登录后回跳原页面（非 dashboard）', async () => {
    renderLoginPage('/login?returnTo=%2Fonboarding')
    await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())
    await userEvent.type(screen.getByLabelText('管理员密码'), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(screen.getByText('onboarding-reached')).toBeInTheDocument())
  })

  // ── 面板地址写回（分域部署回归锁）──

  it('用户未触碰地址：登录成功不得用空串覆盖已配置的面板地址', async () => {
    useConnectionStore.getState().setConfig({ baseUrl: 'http://192.168.1.100:25566' })
    renderLoginPage()
    await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())

    await userEvent.type(screen.getByLabelText('管理员密码'), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())

    // 修复前：setConfig({ baseUrl: '' }) 里的空串不是 nullish，`??` 挡不住，
    // 已配置地址被抹成同源——分域部署下次进面板就找不到服务端
    expect(useConnectionStore.getState().baseUrl).toBe('http://192.168.1.100:25566')
    expect(JSON.parse(localStorage.getItem('mcs-connection') ?? '{}').baseUrl).toBe(
      'http://192.168.1.100:25566',
    )
    expect(useConnectionStore.getState().status).toBe('ready')

    useConnectionStore.getState().setConfig({ baseUrl: '' })
  })

  it('用户显式填写地址：登录成功后按填写值写回', async () => {
    let probes = 0
    server.use(
      http.get('*/api/v1/auth/status', () => {
        probes += 1
        // 首挂载（同源）失败 → 不可达态才出现「连接其他面板地址」入口
        return probes === 1 ? HttpResponse.error() : okEnvelope({ hasPassword: true })
      }),
    )
    renderLoginPage()
    await waitFor(() => expect(screen.getByText('连接失败')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /尝试连接其他面板地址/ }))
    await userEvent.type(
      screen.getByLabelText('面板服务端地址（用于面板网页与服务端分开部署的场景）'),
      'http://192.168.1.100:25566',
    )
    await userEvent.click(screen.getByRole('button', { name: '连接' }))
    await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())

    await userEvent.type(screen.getByLabelText('管理员密码'), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())

    expect(useConnectionStore.getState().baseUrl).toBe('http://192.168.1.100:25566')
    // 会话绑定到登录时使用的地址（不是同源根）
    expect(useAuthStore.getState().session?.issuedFor).toBe('http://192.168.1.100:25566')

    useConnectionStore.getState().setConfig({ baseUrl: '' })
  })

  it('用户点「恢复默认地址」：登录成功后写回空串（同源），不留先前填的地址', async () => {
    let probes = 0
    server.use(
      http.get('*/api/v1/auth/status', () => {
        probes += 1
        // 首挂载（同源）失败 → 不可达态；点「恢复默认地址」后重新探测成功
        return probes === 1 ? HttpResponse.error() : okEnvelope({ hasPassword: true })
      }),
    )
    renderLoginPage()
    await waitFor(() => expect(screen.getByText('连接失败')).toBeInTheDocument())

    // 「恢复默认地址」只在地址非空时出现——先按「连接其他面板地址」填一个（这一步即视为显式处置）
    await userEvent.click(screen.getByRole('button', { name: /尝试连接其他面板地址/ }))
    await userEvent.type(
      screen.getByLabelText('面板服务端地址（用于面板网页与服务端分开部署的场景）'),
      'http://192.168.1.100:25566',
    )
    await userEvent.click(screen.getByRole('button', { name: '恢复默认地址' }))
    await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())

    await userEvent.type(screen.getByLabelText('管理员密码'), 'correct-horse')
    await userEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())

    // 处置过 → 写回重置后的空串（同源）；若重置没生效，这里会是先前填的地址
    expect(useConnectionStore.getState().baseUrl).toBe('')

    useConnectionStore.getState().setConfig({ baseUrl: '' })
  })
})
