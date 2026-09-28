import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { handlers, mockInstanceStatus, mockSystemStats } from '@/test/mocks/handlers'
import { DashboardPage } from '../dashboard-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useNotificationStore } from '@/stores/notifications'

/**
 * 仪表盘页横幅：两条查询各自失败都要有出口——
 * 状态失败会让卡片停在过期值，系统资源失败会让 CPU/内存行永久停在「暂无数据」；
 * 只报其一等于把另一半故障留成静默。两条都失败时合并为一条横幅、一次重试。
 * 终端子树依赖 xterm（jsdom 无 canvas），与本用例关注点无关，整体 mock 掉。
 */
vi.mock('../components/server-terminal', () => ({ ServerTerminal: () => null }))

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
afterEach(() => {
  server.resetHandlers()
  vi.restoreAllMocks()
})

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>
          <DashboardPage />
          <Toaster />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
})

describe('DashboardPage 数据获取失败横幅', () => {
  it('两类查询都成功：不渲染失败横幅', async () => {
    renderPage()
    // 等首屏数据落地（健康标签出现）再断言横幅缺席，避免「还在加载」蒙对
    expect(await screen.findByText('健康')).toBeInTheDocument()
    expect(screen.queryByText(/获取失败/)).not.toBeInTheDocument()
  })

  it('仅系统资源失败：横幅点名「系统资源」，重试后数据到达、横幅消失', async () => {
    let calls = 0
    server.use(
      http.get('*/api/v1/system-stats', () => {
        calls++
        // 首次失败、重试成功：既验证出口存在，也验证重试按钮真的重发
        return calls === 1 ? HttpResponse.error() : ok(mockSystemStats)
      }),
    )
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('系统资源获取失败')).toBeInTheDocument()
    // 状态查询正常时不该被牵连进横幅文案
    expect(screen.queryByText(/服务器状态/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.queryByText(/获取失败/)).not.toBeInTheDocument())
    expect(calls).toBe(2)
  })

  it('仅服务器状态失败：横幅点名「服务器状态」，重试不误发系统资源查询', async () => {
    let statsCalls = 0
    server.use(
      http.get('*/api/v1/instances/:id', () => HttpResponse.error()),
      http.get('*/api/v1/system-stats', () => {
        statsCalls++
        return ok(mockSystemStats)
      }),
    )
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('服务器状态获取失败')).toBeInTheDocument()
    expect(screen.queryByText(/系统资源/)).not.toBeInTheDocument()

    const before = statsCalls
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeEnabled())
    expect(statsCalls).toBe(before)
  })

  it('重试在途：横幅保留、按钮禁用（不得在整个请求窗口内毫无反馈）', async () => {
    let calls = 0
    server.use(
      http.get('*/api/v1/system-stats', () => {
        calls++
        // 首次失败、二次挂起不返回：模拟端点持续故障时的一次重试窗口
        return calls === 1 ? HttpResponse.error() : new Promise<Response>(() => {})
      }),
    )
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('系统资源获取失败')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))

    // query 在重试期间会回到 pending：若只看 isError，横幅与按钮会双双消失
    expect(screen.getByText('系统资源获取失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeDisabled()
    expect(calls).toBe(2)
  })

  it('失败的是系统资源、状态查询恰在重取：重试按钮不被无关查询连带禁用', async () => {
    // 状态已由 WS 送达（store 有值），status 查询因轮询/WS 失效而重取且未返回；
    // 它与资源侧失败无关，不该让资源侧的重试按钮变灰（灰按钮对读屏等于无理由）
    useServerStore.setState({ status: mockInstanceStatus })
    server.use(
      http.get('*/api/v1/instances/:id', () => new Promise<Response>(() => {})),
      http.get('*/api/v1/system-stats', () => HttpResponse.error()),
    )
    renderPage()

    expect(await screen.findByText('系统资源获取失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled()
  })

  it('两条都失败后重试在途：横幅不被首屏骨架吞掉（status 从未成功过）', async () => {
    let statusCalls = 0
    let statsCalls = 0
    server.use(
      http.get('*/api/v1/instances/:id', () => {
        statusCalls++
        return statusCalls === 1 ? HttpResponse.error() : new Promise<Response>(() => {})
      }),
      http.get('*/api/v1/system-stats', () => {
        statsCalls++
        return statsCalls === 1 ? HttpResponse.error() : new Promise<Response>(() => {})
      }),
    )
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('服务器状态与系统资源获取失败')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))

    // 重试在途时 status 回到 pending 且 store 里仍无状态：若据此判「首屏加载」，
    // 骨架会顶掉横幅——用户在整个请求窗口内看不到任何失败提示（该守卫是承重的）
    expect(screen.getByText('服务器状态与系统资源获取失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeDisabled()
  })

  it('两条都失败：合并为一条横幅，一次重试把两条查询都重发', async () => {
    let statusCalls = 0
    let statsCalls = 0
    server.use(
      http.get('*/api/v1/instances/:id', () => {
        statusCalls++
        return HttpResponse.error()
      }),
      http.get('*/api/v1/system-stats', () => {
        statsCalls++
        return HttpResponse.error()
      }),
    )
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('服务器状态与系统资源获取失败')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '重试' })).toHaveLength(1)

    const before = { statusCalls, statsCalls }
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => {
      expect(statusCalls).toBe(before.statusCalls + 1)
      expect(statsCalls).toBe(before.statsCalls + 1)
    })
  })
})

/**
 * 仪表盘告警条接线：把通知 store 的 activeAlerts 显示出来。
 *
 * 这条接线的存在意义就是「状态机算出的结果要有可见载体」——此前 activeAlerts 全仓零消费点
 * （算完即丢）。断言的是**接线本身**：store 里置位 → 页头出现；清空 → 消失。
 * 只测 AlertBanner 组件测不到这段（组件早已单测），删掉页面里的接线不会让任何用例变红。
 */
describe('DashboardPage 超标告警条接线', () => {
  it('activeAlerts 置位 → 页头出现告警条；清空 → 自动消失', async () => {
    renderPage()
    // 先等首屏落地，确保不是「还在加载」蒙对
    expect(await screen.findByText('健康')).toBeInTheDocument()
    expect(screen.queryByText(/服务器状态异常/)).not.toBeInTheDocument()

    // 置位（真实路径由 performanceUpdate 驱动，此处直接落到 store 的状态机产物）
    await act(async () => {
      useNotificationStore.setState({ activeAlerts: new Set(['lowTps']) })
    })
    expect(screen.getByText(/服务器状态异常/)).toBeInTheDocument()
    expect(screen.getByText(/TPS 过低/)).toBeInTheDocument()

    // 恢复 → 常驻载体必须自己撤下
    await act(async () => {
      useNotificationStore.setState({ activeAlerts: new Set() })
    })
    expect(screen.queryByText(/服务器状态异常/)).not.toBeInTheDocument()
  })

  it('查询失败与超标告警同屏时只有一个槽：失败横幅优先（可信度问题先讲）', async () => {
    server.use(http.get('*/api/v1/system-stats', () => HttpResponse.error()))
    renderPage()
    expect(await screen.findByText('系统资源获取失败')).toBeInTheDocument()

    await act(async () => {
      useNotificationStore.setState({ activeAlerts: new Set(['lowTps']) })
    })
    // 失败横幅占槽时告警条让位（PageHeader 的 banner 是单槽），且不得两条同屏
    expect(screen.getByText('系统资源获取失败')).toBeInTheDocument()
    expect(screen.queryByText(/服务器状态异常/)).not.toBeInTheDocument()
  })
})
