/**
 * 投递记录响应体摘要交互测试：
 * - truncateResponseBody 边界（null/空白/200 上限/省略号）
 * - 点击投递记录行展开响应体摘要；再点收起（aria-expanded）
 * - 无响应体提示；成功记录同样可查看
 * MSW 局部拦截，数据为虚构测试值
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
  { id: 11, webhookId: 1, eventType: 'player.join', instanceId: null, payload: null, status: 'failed', responseStatus: 500, responseBody: LONG_BODY, durationMs: 120, attempts: 3, createdAt: '2026-09-01T08:00:00Z' },
  { id: 12, webhookId: 1, eventType: 'player.leave', instanceId: null, payload: null, status: 'success', responseStatus: 200, responseBody: '{"ok":true}', durationMs: 80, attempts: 1, createdAt: '2026-09-01T07:00:00Z' },
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
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WebhookPage />
    </QueryClientProvider>,
  )
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

describe('WebhookPage 投递响应体摘要', () => {
  it('点击投递记录行展开响应体摘要（超长截断 + 省略号）', async () => {
    const user = userEvent.setup()
    renderPage()
    // 展开 Webhook 的投递日志
    await user.click(await screen.findByRole('button', { name: 'Notify 投递日志' }))
    // 点击失败投递记录行（HTTP 500）
    const row = await screen.findByRole('button', { name: /玩家加入/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
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
    await user.click(await screen.findByRole('button', { name: 'Notify 投递日志' }))
    const row = await screen.findByRole('button', { name: /玩家离开/ })
    await user.click(row)
    expect(await screen.findByTestId('delivery-response-12')).toHaveTextContent('{"ok":true}')
  })

  it('响应体为空时显示无响应体提示', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Notify 投递日志' }))
    const row = await screen.findByRole('button', { name: /Ping 测试/ })
    await user.click(row)
    expect(await screen.findByTestId('delivery-response-13')).toHaveTextContent('无响应体')
  })

  it('测试投递后历史面板即时刷新：invalidate 触发 refetch，新增 ping 记录可见（issue #356）', async () => {
    const user = userEvent.setup()
    let deliveryGetCount = 0
    server.use(
      http.get('*/api/v1/webhooks/1/deliveries', () => {
        deliveryGetCount += 1
        // 首次拉取为旧数据；invalidate 触发的二次拉取返回含新 ping 记录的列表
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
    await user.click(await screen.findByRole('button', { name: 'Notify 投递日志' }))
    // 面板展开后首次拉取完成，初始列表仅 1 条 ping 记录
    await screen.findByRole('button', { name: /玩家加入/ })
    const countAfterExpand = deliveryGetCount
    expect(countAfterExpand).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Ping 测试')).toHaveLength(1)

    // 点「测试 Notify」→ onSettled invalidate → 面板 refetch
    await user.click(screen.getByRole('button', { name: '测试 Notify' }))
    await waitFor(() => expect(deliveryGetCount).toBeGreaterThan(countAfterExpand))

    // 新 ping 记录（id 14）在面板中可见（响应体摘要默认收起）
    // 注：toast 提示依赖根布局挂载的 Toaster，本测试不渲染根布局，故不断言 toast
    await waitFor(() => expect(screen.getAllByText('Ping 测试')).toHaveLength(2))
  })
})

describe('WebhookPage 投递日志错误态', () => {
  it('投递日志查询失败 → 错误态而非「暂无投递记录」，含失败原因与重试', async () => {
    const user = userEvent.setup()
    // 局部覆盖：投递日志端点返回 500（其余 handler 沿用全局默认）
    server.use(
      http.get('*/api/v1/webhooks/1/deliveries', () => HttpResponse.json({ status: 'error', code: 500, message: 'internal error' }, { status: 500 })),
    )
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Notify 投递日志' }))
    const errorText = await screen.findByText(/投递日志加载失败/)
    expect(errorText).toBeInTheDocument()
    // 空态文案不得与错误态混淆（拉取失败 ≠ 确无投递）
    expect(screen.queryByText('暂无投递记录')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})
