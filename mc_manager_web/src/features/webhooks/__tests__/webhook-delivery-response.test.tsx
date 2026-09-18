/**
 * 投递记录弹窗交互测试（第 5 项重组后）：
 * - 列表行仅剩启用开关 + 「设置」入口（行主体按钮）
 * - 设置弹窗内：投递日志每条展开显示「发送内容」（事件 payload）与「响应内容」（截断摘要）
 * - truncateResponseBody 边界（null/空白/200 上限/省略号）
 * - 测试投递 invalidate → 日志即时刷新；日志加载失败错误态
 * MSW 局部拦截，数据为虚构测试值
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import WebhookPage, { truncateResponseBody } from '../webhook-page'
import { useConnectionStore } from '@/stores/connection'

const LONG_BODY = 'x'.repeat(250)

const mockWebhook = {
  id: 1, name: 'Notify', url: 'https://example.com/hook', secret: null,
  events: ['player.join'], instanceId: null, isEnabled: true,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}

const mockDeliveries = [
  { id: 11, webhookId: 1, eventType: 'player.join', instanceId: null, payload: { event: 'player.join', player: 'Steve' }, status: 'failed', responseStatus: 500, responseBody: LONG_BODY, durationMs: 120, attempts: 3, createdAt: '2026-09-01T08:00:00Z' },
  { id: 12, webhookId: 1, eventType: 'player.leave', instanceId: null, payload: { event: 'player.leave', player: 'Alex' }, status: 'success', responseStatus: 200, responseBody: '{"ok":true}', durationMs: 80, attempts: 1, createdAt: '2026-09-01T07:00:00Z' },
  { id: 13, webhookId: 1, eventType: 'ping', instanceId: null, payload: null, status: 'failed', responseStatus: null, responseBody: null, durationMs: null, attempts: 1, createdAt: '2026-09-01T06:00:00Z' },
]

function envelope<T>(data: T) {
  return HttpResponse.json({
    status: 'ok', code: 0, message: 'Success', data,
    pagination: { total: Array.isArray(data) ? data.length : 1, page: 1, pageSize: 20, totalPages: 1 },
    timestamp: new Date().toISOString(),
  })
}

const server = setupServer(
  http.get('*/api/v1/webhooks', () => envelope([mockWebhook])),
  http.get('*/api/v1/webhooks/event-types', () => envelope(['player.join', 'player.leave', 'ping'])),
  http.get('*/api/v1/webhooks/1/deliveries', () => envelope(mockDeliveries)),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  localStorage.clear()
  // 占位凭据动态生成（MSW 不校验值，仅满足连接就绪门槛），避免测试源码出现凭据字面量
  useConnectionStore.setState({ baseUrl: '', apiKey: `msw-test-${crypto.randomUUID()}`, status: 'ready' })
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WebhookPage />
    </QueryClientProvider>,
  )
}

/** 打开 Notify 设置弹窗（列表行主体=「设置 Notify」按钮） */
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '设置 Notify' }))
  return screen.findByRole('dialog')
}

/** 弹窗内投递日志行按钮（expanded=false 排除表单事件过滤的同名按钮） */
function deliveryRow(dialog: HTMLElement, evt: RegExp) {
  return within(dialog).getByRole('button', { name: evt, expanded: false })
}

describe('truncateResponseBody', () => {
  it('null/undefined/空串/纯空白 → null', () => {
    expect(truncateResponseBody(null)).toBeNull()
    expect(truncateResponseBody(undefined)).toBeNull()
    expect(truncateResponseBody('')).toBeNull()
    expect(truncateResponseBody('   ')).toBeNull()
  })

  it('不超过上限原样返回', () => {
    expect(truncateResponseBody('abc')).toBe('abc')
    expect(truncateResponseBody('x'.repeat(200))).toBe('x'.repeat(200))
  })

  it('超限截断至 200 字符并追加省略号', () => {
    const out = truncateResponseBody(LONG_BODY)
    expect(out).toHaveLength(201)
    expect(out!.startsWith('x'.repeat(200))).toBe(true)
    expect(out!.endsWith('…')).toBe(true)
  })
})

describe('列表行形态（重组）', () => {
  it('行内仅剩启用开关：无 测试/日志/编辑/删除 图标按钮', async () => {
    userEvent.setup()
    renderPage()
    await screen.findByRole('button', { name: '设置 Notify' })
    expect(screen.queryByRole('button', { name: '测试 Notify' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Notify 投递日志' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '编辑 Notify' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除 Notify' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '禁用 Notify' })).toBeInTheDocument()
  })

  it('启用开关点击发 PUT（仅 isEnabled）', async () => {
    const user = userEvent.setup()
    let putBody: Record<string, unknown> | null = null
    server.use(
      http.put('*/api/v1/webhooks/1', async ({ request }) => {
        putBody = await request.json() as Record<string, unknown>
        return envelope({ ...mockWebhook, isEnabled: false })
      }),
    )
    renderPage()
    await user.click(await screen.findByRole('switch', { name: '禁用 Notify' }))
    await waitFor(() => expect(putBody).toEqual({ isEnabled: false }))
  })
})

describe('设置弹窗：投递日志（发送内容 + 响应内容）', () => {
  it('展开记录行：发送内容为 payload JSON，响应体超长截断；再点收起', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openSettings(user)
    const row = await waitFor(() => deliveryRow(dialog, /玩家加入/))
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    // 发送内容=事件 payload（pretty JSON 含字段值）
    const payloadOut = await screen.findByTestId('delivery-payload-11')
    expect(payloadOut.textContent).toContain('player.join')
    expect(payloadOut.textContent).toContain('Steve')
    // 响应内容=截断摘要（200+省略号）
    const out = await screen.findByTestId('delivery-response-11')
    expect(out.textContent).toHaveLength(201)
    expect(out.textContent!.endsWith('…')).toBe(true)
    // 再点收起
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('delivery-response-11')).not.toBeInTheDocument()
  })

  it('成功投递记录同样可查看响应体', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openSettings(user)
    const row = await waitFor(() => deliveryRow(dialog, /玩家离开/))
    await user.click(row)
    expect(await screen.findByTestId('delivery-response-12')).toHaveTextContent('{"ok":true}')
  })

  it('payload 为 null → 无发送内容；响应体为空 → 无响应体提示', async () => {
    const user = userEvent.setup()
    renderPage()
    const dialog = await openSettings(user)
    const row = await waitFor(() => deliveryRow(dialog, /Ping 测试/))
    await user.click(row)
    expect(await screen.findByTestId('delivery-payload-13')).toHaveTextContent('无发送内容')
    expect(await screen.findByTestId('delivery-response-13')).toHaveTextContent('无响应体')
  })

  it('弹窗内含测试投递与删除入口；测试后 invalidate 触发日志刷新', async () => {
    const user = userEvent.setup()
    let deliveryGetCount = 0
    server.use(
      http.get('*/api/v1/webhooks/1/deliveries', () => {
        deliveryGetCount += 1
        const rows =
          deliveryGetCount >= 2
            ? [
                { id: 14, webhookId: 1, eventType: 'ping', instanceId: null, payload: null, status: 'success', responseStatus: 200, responseBody: 'ok', durationMs: 42, attempts: 1, createdAt: '2026-09-01T09:00:00Z' },
                ...mockDeliveries,
              ]
            : mockDeliveries
        return envelope(rows)
      }),
      http.post('*/api/v1/webhooks/1/test', () =>
        envelope({ success: true, statusCode: 200, body: 'ok' }),
      ),
    )

    renderPage()
    const dialog = await openSettings(user)
    await waitFor(() => deliveryRow(dialog, /玩家加入/))
    const countAfterOpen = deliveryGetCount
    expect(countAfterOpen).toBeGreaterThanOrEqual(1)
    // 日志行中的 Ping 记录计数（expanded 过滤排除表单事件过滤按钮）
    const pingRows = () => within(dialog).queryAllByRole('button', { name: /Ping 测试/, expanded: false }).length
    expect(pingRows()).toBe(1)

    await user.click(within(dialog).getByRole('button', { name: '测试投递' }))
    await waitFor(() => expect(deliveryGetCount).toBeGreaterThan(countAfterOpen))
    await waitFor(() => expect(pingRows()).toBe(2))
    // 删除入口（危险样式按钮）位于弹窗操作区
    expect(within(dialog).getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('弹窗不再含启用开关（启用状态由列表行承载）', async () => {
    const user = userEvent.setup()
    renderPage()
    await openSettings(user)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('启用')).not.toBeInTheDocument()
  })
})

describe('WebhookPage 投递日志错误态', () => {
  it('投递日志查询失败 → 错误态而非「暂无投递记录」，含失败原因与重试', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/api/v1/webhooks/1/deliveries', () => HttpResponse.json({ status: 'error', code: 500, message: 'internal error' }, { status: 500 })),
    )
    renderPage()
    await openSettings(user)
    const errorText = await screen.findByText(/投递日志加载失败/)
    expect(errorText).toBeInTheDocument()
    // 空态文案不得与错误态混淆（拉取失败 ≠ 确无投递）
    expect(screen.queryByText('暂无投递记录')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
