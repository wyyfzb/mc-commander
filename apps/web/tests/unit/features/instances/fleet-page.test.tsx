/**
 * FleetPage · 总览页结构与取数
 *
 * jsdom 不评估容器查询，故这里的容器档位只断言**类名契约**（该上列的列在哪个档上列、
 * 摘要行在哪个档隐藏）；真实阈值由 tools/e2e/fleet.spec.ts 在对应视口宽上锁住。
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers, mockInstanceStatus, mockOverview } from '@tests/support/handlers'
import { FleetPage } from '@/features/instances/fleet-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import type { InstanceStatus } from '@/api/types'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/fleet',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <FleetPage />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
      { path: '/dashboard', element: <div>仪表盘</div> },
      { path: '/instances', element: <div>实例页</div> },
    ],
    { initialEntries: ['/fleet'] },
  )
  return render(<RouterProvider router={router} />)
}

/** 用给定的实例清单替换列表端点（虚构数据） */
function useInstances(list: InstanceStatus[]) {
  server.use(http.get('*/api/v1/instances', () => okJson(list)))
}

/** 服务端信封（与 client.ts 的解析口径一致） */
function okJson(data: unknown) {
  return Response.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function status(overrides: Partial<InstanceStatus>): InstanceStatus {
  return { ...mockInstanceStatus, ...overrides }
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ instanceId: 'demo', phase: {} })
})

describe('FleetPage · 清单', () => {
  it('一屏列出全部实例：每台一行，名称可点开', async () => {
    useInstances([
      status({ id: 'alpha', name: 'Steve 的服' }),
      status({ id: 'beta', name: 'Alex 的服' }),
      status({ id: 'gamma', name: 'TEST-NET 服' }),
    ])
    renderPage()

    expect(await screen.findByRole('button', { name: '打开 Steve 的服' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开 Alex 的服' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开 TEST-NET 服' })).toBeInTheDocument()
    // 一行一实例：三个按钮分处三行（而非同一张卡里堆叠）
    expect(screen.getAllByRole('row')).toHaveLength(4) // 表头 + 3 行
  })

  it('需关注实例排在前面，并在「需关注」列给结论', async () => {
    useInstances([
      status({ id: 'ok', name: '甲 健康' }),
      status({ id: 'bad', name: '乙 熔断', circuitBreakerTripped: true, consecutiveCrashes: 5 }),
    ])
    renderPage()

    await screen.findByRole('button', { name: '打开 乙 熔断' })
    const rows = screen.getAllByRole('row')
    // 第二行（首行是表头）必须是故障那台
    expect(within(rows[1]!).getByText('乙 熔断')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('崩溃熔断')).toBeInTheDocument()
    // 健康那台给「无」而不是留空——空白格读起来像「还没算出来」
    expect(within(rows[2]!).getByText('无')).toBeInTheDocument()
  })

  it('启停中间态照实说「启动中/停止中」，不沿用旧的运行状态', async () => {
    useInstances([status({ id: 'demo', name: '演示实例', isRunning: false })])
    useServerStore.setState({ instanceId: 'demo', phase: { demo: 'starting' } })
    renderPage()

    expect(await screen.findByText('启动中')).toBeInTheDocument()
    expect(screen.queryByText('已停止')).toBeNull()
  })

  it('点击实例名切到该实例并进仪表盘', async () => {
    useInstances([status({ id: 'other', name: '另一台' })])
    renderPage()

    ;(await screen.findByRole('button', { name: '打开 另一台' })).click()
    expect(useServerStore.getState().instanceId).toBe('other')
    expect(await screen.findByText('仪表盘')).toBeInTheDocument()
  })
})

describe('FleetPage · 页头与汇总', () => {
  it('页头描述按需关注条数分档，健康时不报数', async () => {
    useInstances([status({ id: 'ok', name: '健康服' })])
    renderPage()
    expect(await screen.findByText('全部实例健康')).toBeInTheDocument()
  })

  it('有故障实例时页头同时给出故障台数与需关注台数', async () => {
    useInstances([
      status({ id: 'e1', name: '甲', circuitBreakerTripped: true, consecutiveCrashes: 3 }),
      status({ id: 'w1', name: '乙', tps: 16 }),
      status({ id: 'ok1', name: '丙' }),
    ])
    renderPage()
    expect(await screen.findByText('1 台故障')).toBeInTheDocument()
    expect(screen.getByText('2 台需关注')).toBeInTheDocument()
  })

  it('汇总卡给运行台数与在线玩家，并按整机可分配量算余量', async () => {
    useInstances([
      status({ id: 'r1', name: '运行服', isRunning: true, playerCount: 3, maxMemory: '2G' }),
      // 停服后 playerCount 可能残留上一次的人数：把它算进「在线玩家」就是虚报
      status({ id: 's1', name: '停着的服', isRunning: false, playerCount: 7, maxMemory: '4G' }),
    ])
    renderPage()

    // 运行中 1 台，另有 1 台已停止
    expect(await screen.findByText('另有 1 台已停止')).toBeInTheDocument()
    // 在线玩家只累加运行中的实例：停服残留的 playerCount 不该计入
    expect(screen.getByText('分布在 1 台运行中的实例')).toBeInTheDocument()
    // 数值本身也要断言：停着那台残留 7 人，累加进来会显示 10
    const playersCard = screen.getByText('在线玩家').closest('section')!
    expect(within(playersCard).getByText('3')).toBeInTheDocument()
    expect(within(playersCard).queryByText('10')).toBeNull()
    // mockOverview 整机 16 GB → 可分配 14 GB（扣 15% 系统保留后向下取半档），已分配 2+4=6 GB
    expect(screen.getByText('已分配 6 GB，可分配 14 GB')).toBeInTheDocument()
    expect(screen.getByText('8.0 GB')).toBeInTheDocument()
  })

  it('整机读数缺失时不给余量数字（算不出来还报数会被当成结论）', async () => {
    useInstances([status({ id: 'a', name: '甲' })])
    server.use(
      http.get('*/api/v1/overview', () =>
        okJson({ ...mockOverview, systemMemoryTotal: 0, totalMemory: 0 }),
      ),
    )
    renderPage()
    expect(await screen.findByText('整机内存读数未取到')).toBeInTheDocument()
  })
})

describe('FleetPage · 容器档位（类名契约）', () => {
  it('四项运行指标按容器档 @2xl 上列，版本列按 @3xl 上列', async () => {
    useInstances([status({ id: 'demo', name: '演示实例' })])
    renderPage()

    const players = await screen.findByRole('columnheader', { name: '在线' })
    // 容器档而非视口档：侧栏折叠/抽屉化/主从页借宽下视口断点判不准
    expect(players.className).toContain('@2xl:table-cell')
    expect(players.className).toContain('hidden')
    // 视口档前缀（`md:`）不得出现在这里——`@2xl:` 里也含 xl 子串，用词边界判
    expect(/(?:^|\s)md:/.test(players.className)).toBe(false)

    const version = screen.getByRole('columnheader', { name: '版本' })
    expect(version.className).toContain('@3xl:table-cell')
  })

  it('摘要行与指标列同一档开关：窄容器才显示', async () => {
    useInstances([status({ id: 'demo', name: '演示实例', playerCount: 3, tps: 19.96 })])
    renderPage()

    const summary = await screen.findByText('3 人在线 · TPS 20.0 · 内存 3.2 GB')
    // 必须与指标列同档（都 @2xl）：错开会出现「摘要已隐藏、列还没上」的宽度窗口，
    // 那一段里这台实例的四项指标凭空消失
    expect(summary.className).toContain('@2xl:hidden')
  })

  it('汇总卡最窄档就两列（单列四张会把清单挤出首屏）', async () => {
    useInstances([status({ id: 'demo', name: '演示实例' })])
    const { container } = renderPage()
    await screen.findByText('运行中')

    const grid = container.querySelector('.grid.shrink-0')
    expect(grid).not.toBeNull()
    // 最窄档必须两列：375 视口实测四卡竖排占掉约 45% 屏高，清单要滚动才看得见，
    // 而「一眼看清全部实例」正是这一页存在的理由
    expect(grid!.className).toContain('grid-cols-2')
    expect(grid!.className).not.toContain('grid-cols-1')
    expect(grid!.className).toContain('@5xl:grid-cols-4')
  })

  it('页根声明 @container（列档按这块实宽切，不按视口）', async () => {
    useInstances([status({ id: 'demo', name: '演示实例' })])
    const { container } = renderPage()
    await screen.findByRole('columnheader', { name: '在线' })
    expect(container.firstElementChild?.className).toContain('@container')
  })
})

describe('FleetPage · 空态与失败', () => {
  it('无实例时给空态与去部署的入口', async () => {
    useInstances([])
    renderPage()
    expect(await screen.findByText('暂无已安装的实例')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去实例页部署' })).toBeInTheDocument()
  })

  it('列表失败且无旧值：清单给错误态而非空态（空态会被读成「没有实例」）', async () => {
    server.use(
      http.get('*/api/v1/instances', () =>
        Response.json(
          { status: 'error', code: 50001, message: '服务端错误', details: null },
          { status: 500 },
        ),
      ),
    )
    renderPage()
    expect(await screen.findByText(/加载失败/)).toBeInTheDocument()
    expect(screen.queryByText('暂无已安装的实例')).toBeNull()
  })
})
