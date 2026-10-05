/**
 * LoginPage 第二因子（TOTP / 恢复码）行为测试：
 * - 40105（密码已通过、缺第二因子）→ 就地展开验证码输入，不跳页、已输入的密码保留
 * - 带 6 位动态口令重试 → 登录成功
 * - 恢复码路径：同一输入框粘贴恢复码即可（服务端按形状分流）；**含字母**与**全数字**
 *   两种形状各一条——只有全数字那条能抓住「长度被截断」类缺陷
 * - 错误分类：40106 与 40102/429 文案互不相同；40105 本身不产生错误播报（无「错误计数」暗示）
 * - 429 文案随阶段区分：密码步只点名密码、第二因子步同时点名验证码（两阶段各一条——
 *   服务端密码与验证码共用同一封禁计数，只能按「是否已进入第二因子」区分）
 * - 空值与形状不符的前置拦截不发请求
 * mock 数据为结构占位（虚构口令与恢复码），严禁真实凭据
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
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().clearSession()
  useConnectionStore.getState().setStatus('unconfigured')
})

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

function okEnvelope(data: unknown) {
  return HttpResponse.json({ status: 'ok', code: 0, message: 'Success', data, timestamp: '' })
}

function errorEnvelope(code: number, message: string, status: number) {
  return HttpResponse.json(
    { status: 'error', code, message, details: null, timestamp: '' },
    { status },
  )
}

const SESSION = {
  token: 'mock-session-token-0123456789abcdef',
  sessionId: 'sess-mock-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

/** 等登录模式就绪（探测完成） */
async function waitForLoginMode() {
  await waitFor(() => expect(screen.getByLabelText('管理员密码')).toBeInTheDocument())
}

/** 先输密码触发 40105，等第二因子输入框展开 */
async function reachSecondFactorStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('管理员密码'), 'demo-pass-12345')
  await user.click(screen.getByRole('button', { name: /登录/ }))
  await screen.findByLabelText('两步验证码')
}

describe('LoginPage 第二因子', () => {
  it('40105 → 就地展开验证码输入，密码保留且停在登录页，且不播报错误', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        calls += 1
        const body = (await request.json()) as { password: string; totpCode?: string }
        expect(body.password).toBe('demo-pass-12345')
        if (!body.totpCode) return errorEnvelope(40105, '需要两步验证码', 401)
        return okEnvelope(SESSION)
      }),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()

    await user.type(screen.getByLabelText('管理员密码'), 'demo-pass-12345')
    await user.click(screen.getByRole('button', { name: /登录/ }))

    // 输入框就地出现，仍在 /login（未跳页），密码原样保留
    const codeInput = await screen.findByLabelText('两步验证码')
    expect(screen.getByLabelText('管理员密码')).toHaveValue('demo-pass-12345')
    expect(screen.getByRole('heading', { name: '两步验证' })).toBeInTheDocument()
    // 引导文案在卡片说明与 NOTICE 两处都点名「认证器中的 6 位验证码」（至少一处即足够，不锁死份数）
    expect(screen.getAllByText(/认证器中的 6 位验证码/).length).toBeGreaterThan(0)
    // 40105 是流程下一步而非失败：不出现错误播报（role=alert），也不出现「错误计数」类暗示
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/错误次数/)).not.toBeInTheDocument()
    // 输入习惯：数字键盘 + 一次性验证码自动填充语义
    expect(codeInput).toHaveAttribute('inputmode', 'numeric')
    expect(codeInput).toHaveAttribute('autocomplete', 'one-time-code')
    expect(calls).toBe(1)
    expect(useAuthStore.getState().session).toBeNull()
  })

  it('补 6 位动态口令重试 → 登录成功进入面板，且请求体带 totpCode', async () => {
    const seen: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        seen.push(body)
        if (!body.totpCode) return errorEnvelope(40105, '需要两步验证码', 401)
        return okEnvelope(SESSION)
      }),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()
    await reachSecondFactorStep(user)

    await user.type(screen.getByLabelText('两步验证码'), '123456')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))

    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
    expect(seen).toEqual([
      { password: 'demo-pass-12345' },
      { password: 'demo-pass-12345', totpCode: '123456' },
    ])
    expect(useAuthStore.getState().session?.sessionId).toBe('sess-mock-1')
  })

  it('恢复码路径：粘贴恢复码走同一输入框与同一字段（含字母的码）', async () => {
    const seen: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        seen.push(body)
        if (!body.totpCode) return errorEnvelope(40105, '需要两步验证码', 401)
        return okEnvelope(SESSION)
      }),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()
    await reachSecondFactorStep(user)

    // 恢复码常带分隔符：清洗后原样提交
    await user.type(screen.getByLabelText('两步验证码'), 'ABCDE-FGH-JK')
    expect(screen.getByLabelText('两步验证码')).toHaveValue('ABCDEFGHJK')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))

    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
    expect(seen[1]).toEqual({ password: 'demo-pass-12345', totpCode: 'ABCDEFGHJK' })
  })

  /**
   * 承重点：**全数字**的 10 位恢复码。
   * 含字母的码绕开了「纯数字就截到 6 位」那条分支，因此单靠上一个用例，
   * 长度截断类缺陷可以静默通过（假阳性覆盖）。服务端字母表含 2–9，纯数字码合法。
   */
  it('全数字 10 位恢复码：输入框与请求体都保留全文（不被截成 6 位）', async () => {
    const seen: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        seen.push(body)
        if (!body.totpCode) return errorEnvelope(40105, '需要两步验证码', 401)
        return okEnvelope(SESSION)
      }),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()
    await reachSecondFactorStep(user)

    await user.type(screen.getByLabelText('两步验证码'), '23456-78923')
    // 用户必须看得见自己粘的完整码（截断发生在 onChange 时，用户无从诊断）
    expect(screen.getByLabelText('两步验证码')).toHaveValue('2345678923')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))

    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
    expect(seen[1]).toEqual({ password: 'demo-pass-12345', totpCode: '2345678923' })
  })

  it('第二因子错误（40106）→ 区分于密码错误的文案，清空已提交的码并可重试', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        calls += 1
        const body = (await request.json()) as { totpCode?: string }
        if (!body.totpCode) return errorEnvelope(40105, '需要两步验证码', 401)
        if (calls === 2) return errorEnvelope(40106, '两步验证码或恢复码错误', 401)
        return okEnvelope(SESSION)
      }),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()
    await reachSecondFactorStep(user)

    await user.type(screen.getByLabelText('两步验证码'), '000000')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('两步验证码或恢复码错误')
    // 与密码错误文案不同（分类可辨）
    expect(screen.getByRole('alert')).not.toHaveTextContent('^密码错误$')
    // 错误后清空，避免原样重提
    expect(screen.getByLabelText('两步验证码')).toHaveValue('')
    expect(useAuthStore.getState().session).toBeNull()

    // 重新输入正确码即成功
    await user.type(screen.getByLabelText('两步验证码'), '123456')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))
    await waitFor(() => expect(screen.getByText('dashboard-reached')).toBeInTheDocument())
  })

  it('密码错误（40102）→ 提示密码错误，且不展开第二因子', async () => {
    server.use(http.post('*/api/v1/auth/login', () => errorEnvelope(40102, '密码错误', 401)))
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()

    await user.type(screen.getByLabelText('管理员密码'), 'wrong-pass')
    await user.click(screen.getByRole('button', { name: /登录/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('密码错误')
    expect(screen.queryByLabelText('两步验证码')).not.toBeInTheDocument()
  })

  it('429 封禁 → 提示等待时长；已进入第二因子时文案同时点名密码与验证码', async () => {
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        const body = (await request.json()) as { totpCode?: string }
        if (!body.totpCode) return errorEnvelope(40105, '需要两步验证码', 401)
        return errorEnvelope(42901, '登录失败次数过多，请稍后再试', 429)
      }),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()
    await reachSecondFactorStep(user)

    await user.type(screen.getByLabelText('两步验证码'), '000000')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('密码或验证码错误次数过多')
    expect(alert).toHaveTextContent('暂时锁定')
    expect(alert).toHaveTextContent(/5 分钟/)
  })

  it('429 封禁在密码步：文案只点名密码，不把验证码扯进来', async () => {
    server.use(
      http.post('*/api/v1/auth/login', () =>
        errorEnvelope(42901, '登录失败次数过多，请稍后再试', 429),
      ),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()

    await user.type(screen.getByLabelText('管理员密码'), 'demo-pass-12345')
    await user.click(screen.getByRole('button', { name: /登录/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('密码错误次数过多')
    // 未进入第二因子：提「验证码」会让用户去查一个与本次失败无关的东西
    expect(alert).not.toHaveTextContent('验证码')
  })

  it('42900 通用洪泛限流：不给封禁文案（那会把它谎报成密码错误次数过多）', async () => {
    server.use(
      http.post('*/api/v1/auth/login', () =>
        errorEnvelope(42900, 'Too many requests, please try again after 42 seconds', 429),
      ),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()

    await user.type(screen.getByLabelText('管理员密码'), 'demo-pass-12345')
    await user.click(screen.getByRole('button', { name: /登录/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('提交过于频繁')
    expect(alert).toHaveTextContent('与密码是否正确无关')
    // 限流与凭据无关：不得出现封禁语义的文案
    expect(alert).not.toHaveTextContent('错误次数过多')
    expect(alert).not.toHaveTextContent('锁定')
  })

  it('前置拦截：空值与形状不符都不发请求', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/auth/login', async ({ request }) => {
        calls += 1
        const body = (await request.json()) as { totpCode?: string }
        if (!body.totpCode) return errorEnvelope(40105, '需要两步验证码', 401)
        return okEnvelope(SESSION)
      }),
    )
    const user = userEvent.setup()
    renderLoginPage()
    await waitForLoginMode()
    await reachSecondFactorStep(user)

    // 空值
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入认证器中的 6 位验证码')
    expect(calls).toBe(1)

    // 形状不符（位数不足的纯数字）
    await user.type(screen.getByLabelText('两步验证码'), '123')
    await user.click(screen.getByRole('button', { name: /验证并登录/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('验证码为 6 位数字')
    expect(calls).toBe(1)
  })
})
