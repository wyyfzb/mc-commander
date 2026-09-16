/**
 * ConnectionForm 测试（连接表单）：
 * - 表单初始化（store 有值回填）/ 空值校验 warning toast
 * - 测试连接：成功（请求 URL/X-API-Key 正确 + 成功 toast，不写 store）/ 失败（ApiError 友好文案、
 *   网络错误通用文案）/ 在途 loading 禁用
 * - 公网 http 明文警告：触发 ConfirmDialog、取消中止、确认后继续；内网 http 不打扰
 * - 保存：normalizeBaseUrl（无协议补 https）→ setConfig + toast + onSaved + 状态行变已连接
 * - API Key 掩码 + 明文切换
 * - onboarding variant：大标题布局、无状态行
 * - 标题层级（headingAs）：设置子页默认 h1，引导页传 h2 让位给页面级 h1
 * mock 数据为结构占位（虚构地址/密钥），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster, toast as sonnerToast } from 'sonner'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { handlers, mockOverview } from '@/test/mocks/handlers'
import { authCapabilitiesResponseSchema } from '@mc-commander/schemas'
import { useAuthStore, SESSION_EXPIRED_EVENT } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { ConnectionForm } from '../connection-form'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
// 用例级 server.use 覆写必须在每例后回收：否则前一例的「挂起/401/403」应答会漏到后一例
afterEach(() => server.resetHandlers())

function okEnvelope(data: unknown) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

/** 错误信封（code 用服务端错误码，如 40103 会话过期） */
function okEnvelopeError(code: number, message: string) {
  return HttpResponse.json(
    { status: 'error', code, message, details: null, timestamp: new Date().toISOString() },
    { status: 400 },
  )
}

/** 渲染表单；返回 QueryClient 供「探测真正落定」类断言使用（不靠固定睡眠等结果） */
function renderForm(props: {
  variant?: 'settings' | 'onboarding'
  headingAs?: 'h1' | 'h2'
  onSaved?: () => void
} = {}) {
  const onSaved = props.onSaved ?? vi.fn()
  // useUnsavedGuard 依赖 data router 上下文（useBlocker）；能力探测查询需 QueryClient
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <ConnectionForm variant={props.variant} headingAs={props.headingAs} onSaved={onSaved} />
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  )
  return { onSaved, queryClient }
}

/** 只提供能力探测的关闭态（其余端点点默认 handler） */
function useDisabledApiKeyChannel() {
  server.use(http.get('*/api/v1/auth/capabilities', () => okEnvelope({ apiKeyEnabled: false })))
}

/**
 * 等能力探测**真正落定**（请求已发出且客户端已消费响应）。
 *
 * 为什么不用固定睡眠：睡眠只是「大概等到了」，响应未返回时也会通过，是假绿。
 * 判据取 QueryClient 里**该地址那条** query 的状态（缓存里可能同时存在空地址那条
 * 「未指明面板」的禁用条目），并顺带把消费到的 data 交回调用方，使断言能证明
 * 「落定的正是那条响应」。
 */
async function waitCapabilitiesSettled(queryClient: QueryClient, baseUrl: string): Promise<unknown> {
  await waitCapabilitiesStatus(queryClient, baseUrl, 'success')
  return capabilitiesQuery(queryClient, baseUrl)?.state.data
}

/** 等能力探测**已失败落定**（40103 等）：同样以 query 状态为判据 */
async function waitCapabilitiesRejected(queryClient: QueryClient, baseUrl: string): Promise<void> {
  await waitCapabilitiesStatus(queryClient, baseUrl, 'error')
}

function capabilitiesQuery(queryClient: QueryClient, baseUrl: string) {
  return queryClient
    .getQueryCache()
    .findAll()
    .find((q) => q.queryKey[1] === 'auth-capabilities' && q.queryKey[2] === baseUrl)
}

async function waitCapabilitiesStatus(
  queryClient: QueryClient,
  baseUrl: string,
  status: 'success' | 'error',
) {
  await vi.waitFor(
    () => {
      const current = capabilitiesQuery(queryClient, baseUrl)?.state.status
      if (current !== status) {
        throw new Error(`能力探测未落定（${baseUrl}，期望 ${status}，当前 ${current ?? 'no-query'}）`)
      }
    },
    { timeout: 3000 },
  )
  // 等 React 把新状态渲染进 DOM（query 通知 → setState → 提交）
  await act(async () => {})
}

beforeEach(() => {
  localStorage.clear()
  sonnerToast.dismiss()
  useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
  // 会话是第二条款凭据：逐个用例显式设置，避免上一例的会话泄漏（内存态不随 localStorage.clear 复位）
  useAuthStore.setState({ session: null })
})

/** 造一个未过期的登录会话（结构占位，非真实凭据）；不写签发面板 = 旧会话口径（按适用处理） */
function setSession(token = 'sess-token-abc') {
  useAuthStore.setState({
    session: { token, sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  })
}

/** 造一个绑定到指定面板的登录会话（结构占位，非真实凭据） */
function setBoundSession(issuedFor: string, token = 'sess-token-abc') {
  useAuthStore.setState({
    session: {
      token,
      sessionId: 'sess-mock-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedFor,
    },
  })
}

describe('ConnectionForm 渲染', () => {
  it('表单初始化：store 有值 → 地址与 API Key 回填', () => {
    useConnectionStore.setState({
      baseUrl: 'https://192.168.1.100:25566',
      apiKey: 'demo-key-123',
      status: 'ready',
    })
    renderForm()
    expect(screen.getByLabelText('面板地址')).toHaveValue('https://192.168.1.100:25566')
    expect(screen.getByLabelText('API Key')).toHaveValue('demo-key-123')
  })

  it('地址输入下方显示协议说明辅助文案', () => {
    renderForm()
    expect(screen.getByText('支持 http/https 协议；局域网自建服务器推荐内网地址')).toBeInTheDocument()
  })

  it('settings variant：状态行跟随 store（ready=已连接 / 否则未连接）', () => {
    useConnectionStore.setState({ baseUrl: 'https://192.168.1.100:25566', apiKey: 'k', status: 'ready' })
    renderForm({ variant: 'settings' })
    expect(screen.getByText('已连接')).toBeInTheDocument()

    act(() => {
      useConnectionStore.setState({ status: 'unconfigured' })
    })
    expect(screen.getByText('未连接')).toBeInTheDocument()
  })

  it('onboarding variant：大标题 + 副标题，无状态行，保存按钮文案对齐进入面板行为', () => {
    useConnectionStore.setState({ baseUrl: 'https://192.168.1.100:25566', apiKey: 'k', status: 'ready' })
    renderForm({ variant: 'onboarding' })
    expect(screen.getByRole('heading', { name: '连接你的服务器' })).toBeInTheDocument()
    expect(screen.queryByText('已连接')).not.toBeInTheDocument()
    expect(screen.queryByText('未连接')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '连接并进入面板' })).toBeInTheDocument()
  })

  it('标题层级：默认 h1（设置子页里它就是该页主标题），headingAs="h2" 时降为二级标题', () => {
    renderForm({ variant: 'onboarding' })
    expect(screen.getByRole('heading', { level: 1, name: '连接你的服务器' })).toBeInTheDocument()
    cleanup()

    // 引导页另有页面级 h1（欢迎区），表单标题必须能让位——否则同屏两个 h1
    renderForm({ variant: 'onboarding', headingAs: 'h2' })
    expect(screen.getByRole('heading', { level: 2, name: '连接你的服务器' })).toBeInTheDocument()
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0)
  })

  it('API Key 默认掩码（password），眼睛按钮切换明文', async () => {
    const user = userEvent.setup()
    renderForm()
    const keyInput = screen.getByLabelText('API Key')
    expect(keyInput).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: '显示 API Key' }))
    expect(keyInput).toHaveAttribute('type', 'text')

    await user.click(screen.getByRole('button', { name: '隐藏 API Key' }))
    expect(keyInput).toHaveAttribute('type', 'password')
  })
})

describe('ConnectionForm 校验', () => {
  it('空值：地址或 key 为空 → 行内错误提示，不弹警告、不发起请求', async () => {
    let requested = 0
    server.use(
      http.get('*/api/v1/overview', () => {
        requested += 1
        return okEnvelope(mockOverview)
      }),
    )
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('button', { name: '测试连接' }))
    expect(screen.getByText('请填写服务器地址')).toBeInTheDocument()
    expect(screen.getByText('请填写 API Key')).toBeInTheDocument()
    expect(requested).toBe(0)

    // 仅填地址仍视为空
    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    expect(screen.queryByText('请填写服务器地址')).not.toBeInTheDocument()
    expect(screen.getByText('请填写 API Key')).toBeInTheDocument()
    expect(requested).toBe(0)

    await user.click(screen.getByRole('button', { name: '保存连接' }))
    expect(screen.queryByText('请填写服务器地址')).not.toBeInTheDocument()
    expect(screen.getByText('请填写 API Key')).toBeInTheDocument()
    expect(useConnectionStore.getState().apiKey).toBe('')
  })
})

describe('ConnectionForm 测试连接', () => {
  it('成功：GET /overview 用表单值临时构造 config（URL 与 X-API-Key 正确）+ 成功 toast，不写 store', async () => {
    let capturedUrl = ''
    let capturedKey: string | null = null
    server.use(
      http.get('*/api/v1/overview', ({ request }) => {
        capturedUrl = request.url
        capturedKey = request.headers.get('X-API-Key')
        return okEnvelope(mockOverview)
      }),
    )
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'test-key-abc')
    await user.click(screen.getByRole('button', { name: '测试连接' }))

    expect(await screen.findByText('连接成功')).toBeInTheDocument()
    expect(capturedUrl).toBe('https://192.168.1.100:25566/api/v1/overview')
    expect(capturedKey).toBe('test-key-abc')
    // 测试不持久化配置
    expect(useConnectionStore.getState().baseUrl).toBe('')
    expect(useConnectionStore.getState().apiKey).toBe('')
  })

  it('失败（服务端错误信封）：toast 友好错误文案（getFriendlyErrorText）', async () => {
    server.use(
      http.get('*/api/v1/overview', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40101,
            message: 'Invalid or expired API Key',
            details: null,
            timestamp: new Date().toISOString(),
          },
          { status: 401 },
        ),
      ),
    )
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'wrong-key')
    await user.click(screen.getByRole('button', { name: '测试连接' }))

    expect(await screen.findByText(/API Key 无效或已过期/)).toBeInTheDocument()
  })

  it('失败（网络错误）：toast「连接失败，请检查配置」', async () => {
    server.use(
      http.get('*/api/v1/overview', () => HttpResponse.error()),
    )
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'test-key-abc')
    await user.click(screen.getByRole('button', { name: '测试连接' }))

    expect(await screen.findByText(/连接测试失败：连接失败，请检查配置/)).toBeInTheDocument()
  })

  it('在途：测试按钮 loading + 禁用，完成后恢复', async () => {
    let release!: (res: Response) => void
    server.use(
      http.get('*/api/v1/overview', () => new Promise<Response>((resolve) => (release = resolve))),
    )
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'test-key-abc')
    await user.click(screen.getByRole('button', { name: '测试连接' }))

    const loadingBtn = await screen.findByRole('button', { name: '测试中...' })
    expect(loadingBtn).toBeDisabled()
    // 保存按钮同样禁用（保存前强制测试，防并发双请求）
    expect(screen.getByRole('button', { name: '保存连接' })).toBeDisabled()

    await act(async () => {
      release(okEnvelope(mockOverview))
    })
    expect(await screen.findByText('连接成功')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '保存连接' })).toBeEnabled()
  })
})

describe('ConnectionForm 明文传输警告', () => {
  it('公网 http 测试：触发确认 → 取消中止（无请求）；再次确认后继续', async () => {
    let requested = 0
    server.use(
      http.get('*/api/v1/overview', () => {
        requested += 1
        return okEnvelope(mockOverview)
      }),
    )
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText('面板地址'), 'http://example.com:25566')
    await user.type(screen.getByLabelText('API Key'), 'test-key-abc')

    await user.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText('明文传输警告')).toBeInTheDocument()
    expect(
      screen.getByText(/您正在通过 HTTP（非加密）连接公网服务器/),
    ).toBeInTheDocument()

    // 取消 → 中止：弹窗关闭、无请求、无 toast
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText('明文传输警告')).not.toBeInTheDocument()
    expect(requested).toBe(0)

    // 再次触发 → 仍然继续 → 请求放行
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await user.click(await screen.findByRole('button', { name: '仍然继续' }))
    expect(await screen.findByText('连接成功')).toBeInTheDocument()
    expect(requested).toBe(1)
  })

  it('公网 http 保存：取消不写 store；确认后仍保存 + onSaved', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderForm({ variant: 'settings' })
    await user.type(screen.getByLabelText('面板地址'), 'http://example.com:25566')
    await user.type(screen.getByLabelText('API Key'), 'test-key-abc')

    await user.click(screen.getByRole('button', { name: '保存连接' }))
    expect(await screen.findByText('明文传输警告')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(useConnectionStore.getState().baseUrl).toBe('')
    expect(onSaved).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '保存连接' }))
    await user.click(await screen.findByRole('button', { name: '仍然继续' }))
    expect(await screen.findByText('连接配置已保存')).toBeInTheDocument()
    expect(useConnectionStore.getState().baseUrl).toBe('http://example.com:25566')
    expect(useConnectionStore.getState().apiKey).toBe('test-key-abc')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('内网 http 不触发警告：直接测试', async () => {
    let requested = 0
    server.use(
      http.get('*/api/v1/overview', () => {
        requested += 1
        return okEnvelope(mockOverview)
      }),
    )
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText('面板地址'), 'http://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'test-key-abc')
    await user.click(screen.getByRole('button', { name: '测试连接' }))

    expect(await screen.findByText('连接成功')).toBeInTheDocument()
    expect(requested).toBe(1)
    expect(screen.queryByText('明文传输警告')).not.toBeInTheDocument()
  })
})

describe('ConnectionForm 保存', () => {
  it('保存：normalizeBaseUrl（无协议补 https + 去尾斜杠）→ 先测试通过 → setConfig + toast + onSaved + 状态行已连接', async () => {
    const user = userEvent.setup()
    const { onSaved } = renderForm({ variant: 'settings' })
    expect(screen.getByText('未连接')).toBeInTheDocument()

    await user.type(screen.getByLabelText('面板地址'), '192.168.1.100:25566/')
    await user.type(screen.getByLabelText('API Key'), 'test-key-abc')
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    expect(await screen.findByText('连接配置已保存')).toBeInTheDocument()
    const s = useConnectionStore.getState()
    expect(s.baseUrl).toBe('https://192.168.1.100:25566')
    expect(s.apiKey).toBe('test-key-abc')
    expect(s.status).toBe('ready')
    expect(onSaved).toHaveBeenCalledTimes(1)
    // 状态行联动：保存后 store ready → 已连接
    expect(screen.getByText('已连接')).toBeInTheDocument()
  })

  it('保存前强制测试：连接失败 → toast 包含具体错误原因且不写 store、不 onSaved', async () => {
    server.use(http.get('*/api/v1/overview', () => HttpResponse.error()))
    const user = userEvent.setup()
    const { onSaved } = renderForm({ variant: 'settings' })

    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'test-key-abc')
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    // 保存失败 toast 应包含具体错误原因（网络错误时为通用提示）
    expect(await screen.findByText(/保存失败：连接失败，请检查配置/)).toBeInTheDocument()
    // 未写入：store 保持未配置，onSaved 未调用（杜绝「告知失败但已生效」）
    const s = useConnectionStore.getState()
    expect(s.baseUrl).toBe('')
    expect(s.apiKey).toBe('')
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByText('未连接')).toBeInTheDocument()
  })
})

describe('ConnectionForm 登录会话凭据（有会话时 API Key 可空）', () => {
  it('无会话：Key 提示「必须填写」', () => {
    renderForm()
    expect(screen.getByText('当前地址没有可用的登录会话：必须填写 API Key 才能连接。')).toBeInTheDocument()
  })

  it('有会话：Key 提示「可留空」（会话优先于 Key）+ 机器凭据定位说明', () => {
    setSession()
    renderForm()
    expect(
      screen.getByText('已登录：浏览器用登录会话鉴权，此处可留空。'),
    ).toBeInTheDocument()
    // 定位说明与代码实际行为逐条对应：单例全局 / 无过期 / 权限等同管理员 / 可整体关闭
    const model = screen.getByText(/API Key 是没有登录会话的客户端/)
    expect(model).toHaveTextContent('单例全局')
    expect(model).toHaveTextContent('无过期')
    expect(model).toHaveTextContent('权限等同于管理员（可访问全部接口）')
    expect(model).toHaveTextContent('API_KEY_ENABLED=false 可整体关闭该通道')
  })

  it('有会话 + Key 留空：保存放行，请求走 Bearer 且不带 X-API-Key，写入地址且不误存空 Key', async () => {
    setSession()
    let capturedAuth: string | null = null
    let capturedKey: string | null = null
    server.use(
      http.get('*/api/v1/overview', ({ request }) => {
        capturedAuth = request.headers.get('Authorization')
        capturedKey = request.headers.get('X-API-Key')
        return okEnvelope(mockOverview)
      }),
    )
    const user = userEvent.setup()
    const { onSaved } = renderForm({ variant: 'settings' })

    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    expect(await screen.findByText('连接配置已保存')).toBeInTheDocument()
    expect(screen.queryByText('请填写 API Key')).not.toBeInTheDocument()
    expect(capturedAuth).toBe('Bearer sess-token-abc')
    expect(capturedKey).toBeNull()
    const s = useConnectionStore.getState()
    expect(s.baseUrl).toBe('https://192.168.1.100:25566')
    expect(s.apiKey).toBe('')
    // 会话即凭据：状态行进位到已连接
    expect(s.status).toBe('ready')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('无会话 + Key 留空：仍拦截（回归防线，空 Key 不得放行）', async () => {
    let requested = 0
    server.use(
      http.get('*/api/v1/overview', () => {
        requested += 1
        return okEnvelope(mockOverview)
      }),
    )
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    expect(screen.getByText('请填写 API Key')).toBeInTheDocument()
    expect(requested).toBe(0)
    expect(useConnectionStore.getState().baseUrl).toBe('')
  })

  it('测试连接命中 40103：提示可兑现的出路且不拆本机会话（会话保留、无全局登出）', async () => {
    setSession()
    server.use(
      http.get('*/api/v1/overview', () =>
        HttpResponse.json(
          { status: 'error', code: 40103, message: '会话不存在或已登出，请重新登录', details: null, timestamp: new Date().toISOString() },
          { status: 401 },
        ),
      ),
    )
    const expiredListener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expiredListener)
    try {
      const user = userEvent.setup()
      renderForm()
      await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
      await user.click(screen.getByRole('button', { name: '测试连接' }))

      expect(await screen.findByText(/当前地址的登录会话已过期/)).toBeInTheDocument()
      // 会话适用于本地址时才可能收到 40103；此时填 Key 也没用（有可用会话时只发 Bearer），
      // 故提示里不得出现「填 API Key / 清空 Key」这类本界面做不到的动作
      expect(screen.getByText(/退出登录后重新登录该面板/)).toBeInTheDocument()
      expect(screen.queryByText(/(填写|清空|清除).*API Key/)).not.toBeInTheDocument()
      expect(expiredListener).not.toHaveBeenCalled()
      expect(useAuthStore.getState().session?.token).toBe('sess-token-abc')
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expiredListener)
    }
  })

  it('会话属于别的面板：地址下方提示本地址将改用 API Key（并给出退出登录后重新登录的出路）', () => {
    setBoundSession('https://panel-a.example.com')
    renderForm()
    expect(screen.getByText(/当前登录会话属于/)).toBeInTheDocument()
    expect(screen.getByText('https://panel-a.example.com')).toBeInTheDocument()
    // 本地址没有可用会话 → Key 必填
    expect(screen.getByText('当前地址没有可用的登录会话：必须填写 API Key 才能连接。')).toBeInTheDocument()
  })

  it('会话属于本地址（含旧会话）：不显示异面板提示', () => {
    setBoundSession(window.location.origin)
    renderForm()
    expect(screen.queryByText(/当前登录会话属于/)).not.toBeInTheDocument()
    expect(screen.getByText(/已登录：浏览器用登录会话鉴权/)).toBeInTheDocument()
  })

  it('会话属于别的面板：测试连接改用本地址的 X-API-Key，不拿 A 的令牌换 40103（也不被踢下线）', async () => {
    setBoundSession('https://panel-a.example.com')
    let capturedAuth: string | null = null
    let capturedKey: string | null = null
    server.use(
      http.get('*/api/v1/overview', ({ request }) => {
        capturedAuth = request.headers.get('Authorization')
        capturedKey = request.headers.get('X-API-Key')
        return okEnvelope(mockOverview)
      }),
    )
    const expiredListener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expiredListener)
    try {
      const user = userEvent.setup()
      renderForm()
      await user.type(screen.getByLabelText('面板地址'), 'https://panel-b.example.com')
      await user.type(screen.getByLabelText('API Key'), 'key-b')
      await user.click(screen.getByRole('button', { name: '测试连接' }))

      expect(await screen.findByText('连接成功')).toBeInTheDocument()
      expect(capturedAuth).toBeNull()
      expect(capturedKey).toBe('key-b')
      expect(expiredListener).not.toHaveBeenCalled()
      expect(useAuthStore.getState().session?.token).toBe('sess-token-abc')
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expiredListener)
    }
  })
})

describe('ConnectionForm 重新生成 API Key', () => {
  it('轮换成功：调 rotate-key → 表单值/状态行更新 + 立即写入 store（新 key 生效）', async () => {
    const user = userEvent.setup()
    renderForm({ variant: 'settings' })

    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'old-key-abc')
    await user.click(screen.getByRole('button', { name: '重新生成' }))

    expect(await screen.findByText('新 API Key 已生成并启用，旧 Key 已失效')).toBeInTheDocument()
    // 输入框回填新 key
    expect(screen.getByLabelText('API Key')).toHaveValue('mcck-mock-0000-0000-0000-0001')
    // store 立即更新（旧 key 已失效，必须同步否则后续请求 401）
    const s = useConnectionStore.getState()
    expect(s.apiKey).toBe('mcck-mock-0000-0000-0000-0001')
    expect(s.status).toBe('ready')
  })

  it('轮换失败（401）：错误 toast + 表单与 store 不变', async () => {
    server.use(http.post('*/api/v1/rotate-key', () => HttpResponse.json({
      status: 'error', code: 40101, message: 'Invalid API Key', details: null,
      timestamp: new Date().toISOString(),
    }, { status: 401 })))
    const user = userEvent.setup()
    renderForm({ variant: 'settings' })

    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'bad-key')
    await user.click(screen.getByRole('button', { name: '重新生成' }))

    expect(await screen.findByText(/API Key 无效/)).toBeInTheDocument()
    expect(screen.getByLabelText('API Key')).toHaveValue('bad-key')
    expect(useConnectionStore.getState().apiKey).toBe('')
  })

  /**
   * 40303 的兜底：能力查询已经把入口藏掉了，但「未知态保持可见」策略下入口仍可能
   * 被点到（查询失败/超时）——那时必须点名原因，且不写 store。
   * 用「能力探测不可达」构造未知态（不是关闭态），才是这条路径的真实形态。
   */
  it('能力未知（探测失败）+ 轮换 40303：错误文案点名通道已关闭，且不写 store', async () => {
    server.use(
      http.get('*/api/v1/auth/capabilities', () =>
        HttpResponse.json({ status: 'error', code: 50000, message: '服务器内部错误', details: null, timestamp: new Date().toISOString() }, { status: 500 }),
      ),
      http.post('*/api/v1/rotate-key', () => HttpResponse.json({
        status: 'error', code: 40303, message: 'API Key 通道已关闭，无法轮换；如需自动化凭据请先启用该通道', details: null,
        timestamp: new Date().toISOString(),
      }, { status: 403 })),
    )
    const user = userEvent.setup()
    renderForm({ variant: 'settings' })

    await user.type(screen.getByLabelText('面板地址'), 'https://192.168.1.100:25566')
    await user.type(screen.getByLabelText('API Key'), 'old-key-abc')
    // 未知态（探测失败）不隐藏入口：隐藏是不可自证的，误隐藏无从恢复
    const rotate = await screen.findByRole('button', { name: '重新生成' })
    expect(rotate).toBeEnabled()

    await user.click(rotate)

    expect(await screen.findByText(/API Key 通道已关闭/)).toBeInTheDocument()
    expect(screen.getByLabelText('API Key')).toHaveValue('old-key-abc')
    expect(useConnectionStore.getState().apiKey).toBe('')
  })
})

/**
 * 轮换入口的可见性由服务端能力探测（GET /auth/capabilities）驱动。
 *
 * 为什么不能省掉这次探测：API_KEY_ENABLED 只存在于服务端部署配置，客户端无法推断。
 * 曾被考虑的替代信号是「用 API Key 握手成功」，但通道关闭时 fail-closed 只拒绝
 * **携带 Key** 的请求（不携带 Key 的公开端点照常 200），它证明的只是「地址可达」，
 * 据此隐藏会得到一个在真实部署里随机消失的入口——那是把不确定当确定。
 */
describe('ConnectionForm API Key 轮换入口的可见性', () => {
  it('能力开启（默认）：入口可见可点', async () => {
    useConnectionStore.setState({
      baseUrl: 'https://192.168.1.100:25566',
      apiKey: 'demo-key-123',
      status: 'ready',
    })
    renderForm({ variant: 'settings' })

    expect(await screen.findByRole('button', { name: '重新生成' })).toBeEnabled()
    // 开启态保留凭据定位说明（机器凭据 / 无过期 / 等同管理员）
    expect(screen.getByText(/权限等同于管理员/)).toBeInTheDocument()
  })

  it('能力关闭（apiKeyEnabled=false）：入口不可见，且给出关闭原因；凭据输入框仍在', async () => {
    useDisabledApiKeyChannel()
    useConnectionStore.setState({
      baseUrl: 'https://192.168.1.100:25566',
      apiKey: 'demo-key-123',
      status: 'ready',
    })
    renderForm({ variant: 'settings' })

    expect(await screen.findByText(/部署配置已关闭 API Key 通道/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()
    // 通道关闭不影响已有 Key 的粘贴与保存（Key 仍可按原样留存），只藏「生成新 Key」
    expect(screen.getByLabelText('API Key')).toBeInTheDocument()
  })

  it('能力未知（探测挂起）：入口保持可见（不隐藏是不可自证的保守选择）', async () => {
    server.use(http.get('*/api/v1/auth/capabilities', () => new Promise<never>(() => {})))
    // 用会话（而非 Key）让探测起飞：beforeEach 会清空 Key，会话是本文件的第二条款凭据
    useConnectionStore.setState({ baseUrl: 'https://192.168.1.100:25566', status: 'ready' })
    setSession()

    const { queryClient } = renderForm({ variant: 'settings' })

    expect(screen.getByRole('button', { name: '重新生成' })).toBeEnabled()
    expect(screen.queryByText(/部署配置已关闭 API Key 通道/)).not.toBeInTheDocument()
    // 把「未知态来自挂起的探测」变成可证事实：只看按钮可见会连「探测根本没起飞」也放过
    expect(capabilitiesQuery(queryClient, 'https://192.168.1.100:25566')?.state.fetchStatus).toBe(
      'fetching',
    )
  })

  it('onboarding 语境：入口不出现（与粘贴一次性 Key 的流程相邻，误触即作废）', async () => {
    // 不种凭据：无凭据时探测不可能起飞，而未知态一律保持可见（同一规则，见上一例的结论）——
    // 故本例里入口缺席只可能来自语境门，而非能力态
    renderForm({ variant: 'onboarding' })

    expect(await screen.findByLabelText('API Key')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()
  })

  it('切换面板地址：按新面板能力重新判定（能力属于面板，不属于本机）', async () => {
    server.use(
      http.get('*/api/v1/auth/capabilities', ({ request }) => {
        const host = new URL(request.url).host
        return okEnvelope({ apiKeyEnabled: host !== 'panel-b.example.com' })
      }),
    )
    useConnectionStore.setState({
      baseUrl: 'https://panel-a.example.com',
      apiKey: 'demo-key-123',
      status: 'ready',
    })
    const user = userEvent.setup()
    renderForm({ variant: 'settings' })

    // A 面板：入口可见
    expect(await screen.findByRole('button', { name: '重新生成' })).toBeEnabled()

    // 改到关闭了通道的 B 面板 → 入口随之隐藏
    const urlInput = screen.getByLabelText('面板地址')
    await user.clear(urlInput)
    await user.type(urlInput, 'https://panel-b.example.com')
    expect(await screen.findByText(/部署配置已关闭 API Key 通道/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument()
  })

  /**
   * 「成功但不可判读」这一档：200 且 status=ok，但 data 读不出布尔值。
   * 判定必须是 `=== false`，不能是「探测成功即视为关闭」，也不能把 `!== false` 当真值校验。
   * 三档形状一起锁，防「信任成功状态」与「拿非布尔当真值」两类实现。
   */
  it.each([
    ['data 为 null', null],
    ['data 缺字段', {}],
    ['apiKeyEnabled 非布尔', { apiKeyEnabled: 'yes' }],
  ])('能力响应畸形成功（%s）：不判为关闭，入口保持可见可操作', async (_label, data) => {
    // 「何为畸形」的判据来自契约本身而非本用例的臆断：这三档都过不了
    // authCapabilitiesResponseSchema，故客户端只能按「不可判读」保守处理
    expect(authCapabilitiesResponseSchema.safeParse(data).success).toBe(false)
    server.use(http.get('*/api/v1/auth/capabilities', () => okEnvelope(data)))
    useConnectionStore.setState({
      baseUrl: 'https://192.168.1.100:25566',
      apiKey: 'demo-key-123',
      status: 'ready',
    })
    const user = userEvent.setup()
    const { queryClient } = renderForm({ variant: 'settings' })

    // 等探测真正落定，并确认落定的就是那条畸形响应（睡眠等待会对「未返回」假绿）
    expect(await waitCapabilitiesSettled(queryClient, 'https://192.168.1.100:25566')).toEqual(data)

    expect(screen.queryByText(/部署配置已关闭 API Key 通道/)).not.toBeInTheDocument()
    const rotate = screen.getByRole('button', { name: '重新生成' })
    expect(rotate).toBeEnabled()
    // 「可操作」：入口不只是画出来，点下去仍走真实轮换链路
    await user.click(rotate)
    expect(await screen.findByText('新 API Key 已生成并启用，旧 Key 已失效')).toBeInTheDocument()
  })
})

/**
 * 能力探测与登录态的关系（探测地址是用户**刚输入、尚未验证**的面板）。
 *
 * 探测沿用双通道凭据注入，因此它同时是一次「凭据归属判定」：命中 40103 时若不显式豁免，
 * `client.ts` 的默认处置是**全局登出**——用户只是改了个地址填 Key，就被从连接表单弹到登录页。
 * 连接测试早已为同一形态传 `ignoreSessionExpiry`；探测必须同取舍。
 */
describe('ConnectionForm 能力探测不得改变本机登录态', () => {
  /** 记录探测请求实际携带的凭据头，并按给定应答返回（同一 handler，避免相互覆盖） */
  function mockCapabilities(response: () => Response) {
    const captured: { auth: string | null; key: string | null } = { auth: null, key: null }
    server.use(
      http.get('*/api/v1/auth/capabilities', ({ request }) => {
        captured.auth = request.headers.get('Authorization')
        captured.key = request.headers.get('X-API-Key')
        return response()
      }),
    )
    return captured
  }

  const okCapabilities = () => okEnvelope({ apiKeyEnabled: true })
  const sessionExpired = () =>
    okEnvelopeError(40103, '会话不存在或已登出，请重新登录')

  it('旧会话（无签发面板）+ 改到别的地址 + 目标回 40103：本机会话必须保留、不得出现登出事件', async () => {
    // 旧会话口径：令牌未记签发面板 ⇒ 对任何地址都按适用处理，Bearer 会发到刚输入的地址
    setSession()
    const captured = mockCapabilities(sessionExpired)
    const expiredListener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expiredListener)
    try {
      const user = userEvent.setup()
      const { queryClient } = renderForm({ variant: 'settings' })
      await user.type(screen.getByLabelText('面板地址'), 'https://panel-b.example.com')
      await waitCapabilitiesRejected(queryClient, 'https://panel-b.example.com')

      expect(captured.auth).toBe('Bearer sess-token-abc')
      expect(expiredListener).not.toHaveBeenCalled()
      expect(useAuthStore.getState().session?.token).toBe('sess-token-abc')
      // 探测失败属未知态：入口保持可见（不得因失败把能力判成关闭）
      expect(screen.getByRole('button', { name: '重新生成' })).toBeEnabled()
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expiredListener)
    }
  })

  it('会话绑定到 A 面板 + 探测 B 面板：不发 Bearer（J38 规则在探测路径上同样成立）', async () => {
    setBoundSession('https://panel-a.example.com')
    const captured = mockCapabilities(okCapabilities)
    const user = userEvent.setup()
    const { queryClient } = renderForm({ variant: 'settings' })

    await user.type(screen.getByLabelText('面板地址'), 'https://panel-b.example.com')
    await waitCapabilitiesSettled(queryClient, 'https://panel-b.example.com')

    // 令牌只发签发它的面板：异地址回落 API Key 通道（此处无 Key ⇒ 不带认证头）
    expect(captured.auth).toBeNull()
    expect(captured.key).toBeNull()
    expect(useAuthStore.getState().session?.token).toBe('sess-token-abc')
  })

  it('会话绑定到本地址 + 探测本地址：发 Bearer（合法路径）', async () => {
    setBoundSession('https://panel-a.example.com')
    const captured = mockCapabilities(okCapabilities)
    const user = userEvent.setup()
    const { queryClient } = renderForm({ variant: 'settings' })

    await user.type(screen.getByLabelText('面板地址'), 'https://panel-a.example.com')
    await waitCapabilitiesSettled(queryClient, 'https://panel-a.example.com')

    expect(captured.auth).toBe('Bearer sess-token-abc')
    expect(useAuthStore.getState().session?.token).toBe('sess-token-abc')
  })
})
