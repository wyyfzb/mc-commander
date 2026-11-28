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
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

const TRIPPED = {
  ...mockInstanceStatus,
  isRunning: false,
  startupState: 'stopped',
  autoRestart: false,
  autoStart: true,
  circuitBreakerTripped: true,
  checkingStartupStability: false,
  consecutiveCrashes: 3,
}
const RECOVERED = { ...TRIPPED, circuitBreakerTripped: false, consecutiveCrashes: 0 }

function renderPage(initialEntry = '/instances') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/help', element: <h1>帮助中心</h1> },
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
    { initialEntries: [initialEntry] },
  )
  render(<RouterProvider router={router} />)
  return { qc, router }
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
    phase: {},
  })
  server.use(
    http.get('*/api/v1/instances', () => ok([TRIPPED])),
    http.get('*/api/v1/instances/:id', () => ok(TRIPPED)),
  )
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

describe('InstancesPage 服务器反复退出', () => {
  it('深链接等待列表后聚焦目标卡，当前实例相同时也定位', async () => {
    const { router } = renderPage('/instances?focus=demo')
    const card = await screen.findByRole('group', { name: '演示实例' })
    expect(card).toHaveFocus()
    expect(router.state.location.search).toBe('')
  })

  it('再试一次只启动目标实例，收到运行状态后确认稳定性，收到恢复状态后移除提醒', async () => {
    const user = userEvent.setup()
    const requests: string[] = []
    let detail = { ...TRIPPED, id: 'beta', name: '虚构乙服' }
    const other = { ...mockInstanceStatus, isRunning: false, startupState: 'stopped' }
    server.use(
      http.get('*/api/v1/instances', () => ok([other, detail])),
      http.get('*/api/v1/instances/:id', ({ params }) => ok(params.id === 'beta' ? detail : other)),
      http.post('*/api/v1/instances/:id/start', ({ params }) => {
        requests.push(`POST ${params.id}`)
        detail = { ...detail, isRunning: true, startupState: 'starting' }
        return ok(null)
      }),
      http.put('*/api/v1/instances/:id', ({ params }) => {
        requests.push(`PUT ${params.id}`)
        return ok(detail)
      }),
    )
    const { qc } = renderPage()
    const card = within(await screen.findByRole('group', { name: '虚构乙服' }))
    const retry = await card.findByRole('button', { name: '再试一次 虚构乙服' })
    expect(card.getByText('服务器反复退出，已暂停自动启动。')).toBeVisible()
    expect(card.queryByText('正在确认服务器能否稳定运行')).not.toBeInTheDocument()
    await user.click(retry)

    expect(await screen.findByText('启动指令已发送')).toBeInTheDocument()
    expect(await card.findByRole('button', { name: '停止 虚构乙服' })).toBeEnabled()
    expect(card.getByText('服务器反复退出，已暂停自动启动。')).toBeVisible()
    expect(card.queryByText('正在确认服务器能否稳定运行')).not.toBeInTheDocument()
    expect(requests).toEqual(['POST beta'])

    detail = { ...detail, startupState: 'ready', checkingStartupStability: true }
    void qc.invalidateQueries({ queryKey: queryKeys.instance('beta') })
    expect(await card.findByText('正在确认服务器能否稳定运行')).toBeVisible()

    detail = { ...RECOVERED, id: 'beta', name: '虚构乙服', isRunning: true, startupState: 'ready' }
    void qc.invalidateQueries({ queryKey: queryKeys.instance('beta') })
    await waitFor(() =>
      expect(card.queryByText('正在确认服务器能否稳定运行')).not.toBeInTheDocument(),
    )
    expect(card.queryByRole('link', { name: '查看原因' })).not.toBeInTheDocument()
    expect(card.getByRole('button', { name: '停止 虚构乙服' })).toBeEnabled()
  })

  it('停机卡上的查看原因直接打开该实例的帮助中心排障', async () => {
    const user = userEvent.setup()
    const { router } = renderPage()
    await user.click(await screen.findByRole('link', { name: '查看原因' }))
    expect(await screen.findByRole('heading', { name: '帮助中心' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?instance=demo')
  })
})
