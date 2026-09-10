/**
 * ConnectionForm 测试（连接表单）：
 * - 表单初始化（store 有值回填）/ 空值校验 warning toast
 * - 测试连接：成功（请求 URL/X-API-Key 正确 + 成功 toast，不写 store）/ 失败（ApiError 友好文案、
 *   网络错误通用文案）/ 在途 loading 禁用
 * - 公网 http 明文警告：触发 ConfirmDialog、取消中止、确认后继续；内网 http 不打扰
 * - 保存：normalizeBaseUrl（无协议补 https）→ setConfig + toast + onSaved + 状态行变已连接
 * - API Key 掩码 + 明文切换
 * - onboarding variant：大标题布局、无状态行
 * mock 数据为结构占位（虚构地址/密钥），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster, toast as sonnerToast } from 'sonner'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { handlers, mockOverview } from '@/test/mocks/handlers'
import { useAuthStore, SESSION_EXPIRED_EVENT } from '@/stores/auth'
import { useConnectionStore } from '@/stores/connection'
import { ConnectionForm } from '../connection-form'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

function okEnvelope(data: unknown) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function renderForm(props: { variant?: 'settings' | 'onboarding'; onSaved?: () => void } = {}) {
  const onSaved = props.onSaved ?? vi.fn()
  // useUnsavedGuard 依赖 data router 上下文（useBlocker）
  const router = createMemoryRouter(
    [{ path: '/', element: <ConnectionForm variant={props.variant} onSaved={onSaved} /> }],
    { initialEntries: ['/'] },
  )
  render(
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>,
  )
  return { onSaved }
}

beforeEach(() => {
  localStorage.clear()
  sonnerToast.dismiss()
  useConnectionStore.setState({ baseUrl: '', apiKey: '', status: 'unconfigured' })
  // 会话是第二条款凭据：逐个用例显式设置，避免上一例的会话泄漏（内存态不随 localStorage.clear 复位）
  useAuthStore.setState({ session: null })
})

/** 造一个未过期的登录会话（结构占位，非真实凭据） */
function setSession(token = 'sess-token-abc') {
  useAuthStore.setState({
    session: { token, sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
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
    expect(screen.getByText('当前无登录会话：必须填写 API Key 才能连接')).toBeInTheDocument()
  })

  it('有会话：Key 提示「可留空」（会话优先于 Key）', () => {
    setSession()
    renderForm()
    expect(
      screen.getByText(
        '已登录：浏览器用登录会话鉴权，此处可留空；API Key 是无登录会话的客户端（自动化脚本等）用的凭据',
      ),
    ).toBeInTheDocument()
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

      expect(await screen.findByText(/目标地址不接受当前登录会话/)).toBeInTheDocument()
      // 有会话时客户端只发 Bearer、Key 不进请求——提示不得让用户去「填 API Key」
      expect(screen.getByText(/重新登录/)).toBeInTheDocument()
      expect(screen.queryByText(/填写.*API Key/)).not.toBeInTheDocument()
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
})
