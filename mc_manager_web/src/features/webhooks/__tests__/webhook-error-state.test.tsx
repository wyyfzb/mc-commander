/**
 * 列表加载失败态优先于空态（防退化）：
 * 查询报错时必须展示「加载失败」+ 重试入口，不得落进「暂无 Webhook」空态——
 * 空态 CTA「新建 Webhook」会把「服务端有问题」误导向「再建一个」。
 * 判定分支被重排（空态前置）即本文件红。
 * MSW 局部拦截，数据为虚构测试值
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import WebhookPage from '../webhook-page'
import { useConnectionStore } from '@/stores/connection'

const server = setupServer(
  http.get('*/api/v1/webhooks', () =>
    HttpResponse.json(
      {
        status: 'error',
        code: 50000,
        message: 'mock 内部错误',
        details: null,
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    ),
  ),
  // 页面加载即拉事件类型（表单依赖）：本文件只拦错列表，event-types 返回空集保拦截面完整
  http.get('*/api/v1/webhooks/event-types', () =>
    HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Success',
      data: [],
      timestamp: new Date().toISOString(),
    }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  localStorage.clear()
  // 占位凭据动态生成（MSW 不校验值，仅满足连接就绪门槛），避免测试源码出现凭据字面量
  useConnectionStore.setState({
    baseUrl: '',
    apiKey: `msw-test-${crypto.randomUUID()}`,
    status: 'ready',
  })
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <WebhookPage />
    </QueryClientProvider>,
  )
}

describe('Webhook 列表错误态', () => {
  it('查询失败：展示加载失败态与重试入口，不落空态', async () => {
    renderPage()
    expect(await screen.findByText('加载失败')).toBeInTheDocument()
    expect(screen.getByText(/无法获取 Webhook 列表/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText('暂无 Webhook')).not.toBeInTheDocument()
  })
})
