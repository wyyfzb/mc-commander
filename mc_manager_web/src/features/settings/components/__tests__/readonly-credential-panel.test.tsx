/**
 * ReadonlyCredentialPanel（设置页只读监控凭据）测试（清单 #23）：
 * - 未创建态：入口文案是「生成只读凭据」（不是「重新生成」）
 * - 已配置态：入口是「重新生成」，点它先弹二次确认（旧凭据立即失效）
 * - 通道关闭态（READONLY_API_KEY_ENABLED=false）：入口禁用 + 说明恢复方法，不发写请求
 * - 生成成功：明文一次性展示 + 复制；「收起」后不再渲染明文，且不落任何缓存/localStorage
 * - 状态读取失败：给错误文案与重试，不静默
 * - 未认证（无会话也无 API Key）：只给说明，不发请求
 * 凭据为虚构占位串，严禁真实凭据
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { Toaster } from 'sonner'
import { handlers } from '@/test/mocks/handlers'
import { ReadonlyCredentialPanel } from '../readonly-credential-panel'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** 虚构只读凭据（与服务端 generateApiKey 同构：mcro- 前缀 + 8 组 8 位 hex） */
const ISSUED_KEY = 'mcro-11111111-22222222-33333333-44444444-55555555-66666666-77777777-88888888'

function ok(data: unknown) {
  return HttpResponse.json({ status: 'ok', code: 0, message: 'Success', data, timestamp: '' })
}

function capabilities(readonlyApiKeyEnabled: boolean, readonlyApiKeyConfigured: boolean) {
  server.use(
    http.get('*/api/v1/auth/capabilities', () =>
      ok({ apiKeyEnabled: true, readonlyApiKeyEnabled, readonlyApiKeyConfigured }),
    ),
  )
}

function renderPanel(props?: { authed?: boolean; queryClient?: QueryClient }) {
  const qc = props?.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ReadonlyCredentialPanel
        baseUrl="https://192.168.1.100:25566"
        apiKey="demo-key-123"
        authed={props?.authed ?? true}
      />
      <Toaster />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('ReadonlyCredentialPanel 状态呈现', () => {
  it('尚未创建：显示「尚未创建」与「生成只读凭据」', async () => {
    capabilities(true, false)
    renderPanel()

    expect(await screen.findByText('尚未创建')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /生成只读凭据/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重新生成只读凭据/ })).not.toBeInTheDocument()
  })

  it('已配置：显示「已配置」与「重新生成」，且给出能力边界说明', async () => {
    capabilities(true, true)
    renderPanel()

    expect(await screen.findByText('已配置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新生成只读凭据/ })).toBeInTheDocument()
    // 能力边界是使用该凭据的前提（只读白名单 + 字段裁剪），必须在界面可见
    expect(screen.getByText(/仅能访问 5 个读数端点/)).toBeInTheDocument()
  })

  it('通道关闭：入口禁用并说明恢复方法（不是凭空消失）', async () => {
    capabilities(false, true)
    renderPanel()

    expect(await screen.findByText('通道已关闭')).toBeInTheDocument()
    expect(screen.getByText(/READONLY_API_KEY_ENABLED=false/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新生成只读凭据/ })).toBeDisabled()
  })

  it('状态读取失败（未知态）：给出错误文案与重试，但**保留入口**且强制二次确认', async () => {
    const user = userEvent.setup()
    let rotateCalls = 0
    server.use(
      http.get('*/api/v1/auth/capabilities', () =>
        HttpResponse.json(
          { status: 'error', code: 50000, message: 'boom', details: null, timestamp: '' },
          { status: 500 },
        ),
      ),
      http.post('*/api/v1/rotate-readonly-key', () => {
        rotateCalls += 1
        return ok({ apiKey: ISSUED_KEY })
      }),
    )
    renderPanel()

    expect(await screen.findByText(/凭据状态读取失败/)).toBeInTheDocument()
    // 未知态不猜：入口仍可用（误隐藏比误显示糟）
    const entry = screen.getByRole('button', { name: '生成只读凭据' })
    await user.click(entry)
    // 但必须先确认——不知道是否已配置，不能假定「首次生成」而省掉「旧凭据立即失效」的告知
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/旧凭据将立即失效/)).toBeInTheDocument()
    expect(rotateCalls).toBe(0)
  })

  it('状态读取失败：给出错误文案与重试入口', async () => {
    server.use(
      http.get('*/api/v1/auth/capabilities', () =>
        HttpResponse.json(
          { status: 'error', code: 50000, message: 'boom', details: null, timestamp: '' },
          { status: 500 },
        ),
      ),
    )
    renderPanel()

    expect(await screen.findByText(/凭据状态读取失败/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('未认证：只给说明，且**零请求**（用计数 handler 断言，不靠 MSW 的告警）', async () => {
    let capabilityCalls = 0
    server.use(
      http.get('*/api/v1/auth/capabilities', () => {
        capabilityCalls += 1
        return ok({ apiKeyEnabled: true, readonlyApiKeyEnabled: true, readonlyApiKeyConfigured: false })
      }),
    )
    renderPanel({ authed: false })

    expect(await screen.findByText(/需要登录会话或 API Key 才能管理/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /只读凭据/ })).not.toBeInTheDocument()
    expect(capabilityCalls).toBe(0)
  })
})

describe('ReadonlyCredentialPanel 生成与明文一次性展示', () => {
  it('首次生成：无需二次确认；成功后明文仅展示一次，收起后不再渲染且不落缓存', async () => {
    const user = userEvent.setup()
    capabilities(true, false)
    server.use(http.post('*/api/v1/rotate-readonly-key', () => ok({ apiKey: ISSUED_KEY })))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderPanel({ queryClient: qc })

    await user.click(await screen.findByRole('button', { name: /生成只读凭据/ }))

    const keyBlock = await screen.findByText(ISSUED_KEY)
    expect(keyBlock).toBeInTheDocument()
    expect(screen.getByText(/只显示这一次/)).toBeInTheDocument()
    // 一次性明文块是可访问性可见的 live region（读屏用户也要能取到）
    expect(screen.getByRole('status')).toHaveTextContent(ISSUED_KEY)
    // 明文只存在于组件 state：localStorage / sessionStorage / query 缓存都不得出现
    expect(JSON.stringify(localStorage)).not.toContain('mcro-')
    expect(JSON.stringify(sessionStorage)).not.toContain('mcro-')
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('mcro-')

    await user.click(screen.getByRole('button', { name: /我已保存，收起/ }))
    expect(screen.queryByText(ISSUED_KEY)).not.toBeInTheDocument()
  })

  it('已配置时重新生成：先二次确认（旧凭据立即失效），取消则不发生成动作', async () => {
    const user = userEvent.setup()
    let rotateCalls = 0
    capabilities(true, true)
    server.use(
      http.post('*/api/v1/rotate-readonly-key', () => {
        rotateCalls += 1
        return ok({ apiKey: ISSUED_KEY })
      }),
    )
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /重新生成只读凭据/ }))

    // 二次确认弹窗：说明旧凭据失效的后果
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/旧凭据立即失效/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(rotateCalls).toBe(0)

    // 确认后才真正调用，并展示明文
    await user.click(screen.getByRole('button', { name: /重新生成只读凭据/ }))
    const dialog2 = await screen.findByRole('dialog')
    await user.click(within(dialog2).getByRole('button', { name: '重新生成' }))
    expect(await screen.findByText(ISSUED_KEY)).toBeInTheDocument()
    expect(rotateCalls).toBe(1)
  })

  it('生成失败（404 语义：只读 Key 不可自我轮换）：提示失败且不展示明文', async () => {
    const user = userEvent.setup()
    capabilities(true, false)
    server.use(
      http.post('*/api/v1/rotate-readonly-key', () =>
        HttpResponse.json(
          { status: 'error', code: 40305, message: 'forbidden', details: null, timestamp: '' },
          { status: 403 },
        ),
      ),
    )
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /生成只读凭据/ }))

    expect(await screen.findByText(/生成失败/)).toBeInTheDocument()
    expect(screen.queryByText(ISSUED_KEY)).not.toBeInTheDocument()
  })
})
