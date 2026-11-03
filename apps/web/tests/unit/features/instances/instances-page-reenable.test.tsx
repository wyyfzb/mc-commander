/**
 * InstancesPage 熔断复位：写接口与回执由页面持有（卡片只把实例 id 交上来）。
 * 本组锁页面这一侧——载荷只带 autoRestart、成功有回执、失败有错误文案、
 * 在途时该卡按钮禁用。
 * MSW 拦截：PUT 由用例内 server.use 覆盖；其余端点走共享 handlers（虚构占位数据）。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster, toast as sonnerToast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers, mockInstanceStatus } from '@tests/support/handlers'
import { InstancesPage } from '@/features/instances/instances-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

/** 熔断态详情：连崩 3 次、自动重启已被服务端关掉 */
const TRIPPED = {
  ...mockInstanceStatus,
  autoRestart: false,
  circuitBreakerTripped: true,
  consecutiveCrashes: 3,
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/instances',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <InstancesPage />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/instances'] },
  )
  return render(<RouterProvider router={router} />)
}

/** 等详情落地并取到熔断卡（详情是独立查询，首帧卡片上还没有熔断行） */
async function trippedCard() {
  const button = await screen.findByRole('button', { name: '重新启用自动重启' })
  return button.closest('[data-instance-id]') as HTMLElement
}

beforeEach(() => {
  localStorage.clear()
  sonnerToast.dismiss()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
  server.use(http.get('*/api/v1/instances/:id', () => ok(TRIPPED)))
})

function ok(data: unknown) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

describe('InstancesPage 熔断复位', () => {
  it('点「重新启用自动重启」发 PUT，载荷只有 autoRestart（不覆盖内存/JVM）', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    server.use(
      http.put('*/api/v1/instances/:id', async ({ request }) => {
        bodies.push(await request.json())
        return ok({ ...TRIPPED, autoRestart: true, circuitBreakerTripped: false })
      }),
    )
    renderPage()
    const card = await trippedCard()

    await user.click(within(card).getByRole('button', { name: '重新启用自动重启' }))

    await waitFor(() => expect(bodies).toEqual([{ autoRestart: true }]))
  })

  it('成功回执点名第二重后果（崩溃计数已清零），不说成只有「已启用」', async () => {
    const user = userEvent.setup()
    server.use(
      http.put('*/api/v1/instances/:id', () =>
        ok({ ...TRIPPED, autoRestart: true, circuitBreakerTripped: false }),
      ),
    )
    renderPage()
    const card = await trippedCard()

    await user.click(within(card).getByRole('button', { name: '重新启用自动重启' }))

    expect(await screen.findByText('自动重启已重新启用，崩溃计数已清零')).toBeInTheDocument()
  })

  it('失败：错误 toast 说明没成，按钮回到可点（不吞掉失败也不卡在加载态）', async () => {
    const user = userEvent.setup()
    server.use(
      http.put('*/api/v1/instances/:id', () =>
        HttpResponse.json(
          { status: 'error', code: 50000, message: 'internal error', details: null, timestamp: '' },
          { status: 500 },
        ),
      ),
    )
    renderPage()
    const card = await trippedCard()
    const button = within(card).getByRole('button', { name: '重新启用自动重启' })

    await user.click(button)

    expect(
      await screen.findByText('重新启用自动重启失败：服务器内部错误，请稍后重试'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: '重新启用自动重启' })).toBeEnabled(),
    )
    expect(screen.queryByText('自动重启已重新启用，崩溃计数已清零')).not.toBeInTheDocument()
  })

  it('在途：按钮转「重新启用中」并禁用（请求挂住时锁住二次点击）', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.put('*/api/v1/instances/:id', async () => {
        await gate
        return ok({ ...TRIPPED, autoRestart: true, circuitBreakerTripped: false })
      }),
    )
    renderPage()
    const card = await trippedCard()

    await user.click(within(card).getByRole('button', { name: '重新启用自动重启' }))

    const pendingBtn = await within(card).findByRole('button', { name: /重新启用中/ })
    expect(pendingBtn).toBeDisabled()
    release?.()
  })
})
