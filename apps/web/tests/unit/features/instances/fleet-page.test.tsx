/**
 * FleetPage · 总览页结构与取数
 *
 * jsdom 不评估容器查询，故这里的容器档位只断言**类名契约**（该上列的列在哪个档上列、
 * 摘要行在哪个档隐藏）；真实阈值由 tools/e2e/fleet.spec.ts 在对应视口宽上锁住。
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
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

function InstancePageStub() {
  const { search } = useLocation()
  return <div>实例页 {search}</div>
}

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
      { path: '/instances', element: <InstancePageStub /> },
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
  const startupState =
    overrides.startupState ?? (overrides.isRunning === false ? 'stopped' : 'ready')
  return { ...mockInstanceStatus, startupState, ...overrides }
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
      status({
        id: 'bad',
        name: '虚构乙服',
        isRunning: false,
        circuitBreakerTripped: true,
        consecutiveCrashes: 5,
      }),
    ])
    renderPage()

    await screen.findByRole('button', { name: '打开 虚构乙服' })
    const rows = screen.getAllByRole('row')
    // 第二行（首行是表头）必须是故障那台
    expect(within(rows[1]!).getByText('虚构乙服')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('反复退出')).toBeInTheDocument()
    // 健康那台给「无」而不是留空——空白格读起来像「还没算出来」
    expect(within(rows[2]!).getByText('无')).toBeInTheDocument()
  })

  it('可用键盘从反复退出标记进入对应实例卡', async () => {
    const user = userEvent.setup()
    useInstances([status({ id: 'beta:test', name: '虚构乙服', circuitBreakerTripped: true })])
    renderPage()

    const action = await screen.findByRole('button', { name: '查看 虚构乙服 反复退出的实例卡' })
    screen.getByRole('button', { name: '打开 虚构乙服' }).focus()
    await user.tab()
    expect(action).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('实例页 ?focus=beta%3Atest')).toBeInTheDocument()
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
  it('无故障告警时不报数', async () => {
    useInstances([status({ id: 'ok', name: '健康服' })])
    renderPage()
    expect(await screen.findByText('暂无故障或告警')).toBeInTheDocument()
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

  it('表格和汇总区分四态，只统计已就绪实例的在线玩家', async () => {
    useInstances([
      status({ id: 'r1', name: '已就绪服', playerCount: 3, maxMemory: '2G' }),
      status({ id: 's1', name: '已停止服', isRunning: false, playerCount: 7, maxMemory: '2G' }),
      status({
        id: 's2',
        name: '启动中服',
        startupState: 'starting',
        playerCount: 9,
        maxMemory: '1G',
        tps: 5,
      }),
      status({
        id: 'u1',
        name: '未知服',
        startupState: 'unknown',
        playerCount: 11,
        maxMemory: '1G',
        tps: 4,
      }),
    ])
    renderPage()

    const readyCard = within(screen.getByText('已就绪实例').closest('section')!)
    expect(await readyCard.findByText('1 台启动中 · 1 台就绪未知 · 1 台已停止')).toBeInTheDocument()
    expect(readyCard.getByText('1')).toBeInTheDocument()
    const playersCard = within(screen.getByText('在线玩家').closest('section')!)
    expect(playersCard.getByText('仅统计 1 台已就绪实例')).toBeInTheDocument()
    expect(playersCard.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('暂无故障或告警')).toBeInTheDocument()
    expect(screen.queryByText('全部实例健康')).not.toBeInTheDocument()

    for (const [name, label, players, tps] of [
      ['已就绪服', '已就绪', '3/20', '20.0'],
      ['已停止服', '已停止', '—', '—'],
      ['启动中服', '启动中', '—', '—'],
      ['未知服', '就绪未知', '—', '—'],
    ]) {
      const row = within(screen.getByRole('button', { name: `打开 ${name}` }).closest('tr')!)
      const cells = row.getAllByRole('cell')
      expect(cells[1]).toHaveTextContent(label!)
      expect(cells[3]).toHaveTextContent(players!)
      expect(cells[4]).toHaveTextContent(tps!)
      if (label !== '已就绪') expect(cells[0]).not.toHaveTextContent(/人在线|TPS/)
    }
    expect(screen.getByText('已分配 6 GB，可分配 14 GB')).toBeInTheDocument()
    expect(screen.getByText('8.0 GB')).toBeInTheDocument()
  })

  it('只有未知就绪实例时不把在线人数显示成零', async () => {
    useInstances([status({ id: 'u1', name: '未知服', startupState: 'unknown', playerCount: 9 })])
    renderPage()

    const playersCard = within(screen.getByText('在线玩家').closest('section')!)
    expect(await playersCard.findByText('暂无已就绪实例')).toBeInTheDocument()
    expect(playersCard.getByText('—')).toBeInTheDocument()
  })

  it('已就绪但 TPS 无样本时保留在线数，不显示默认 TPS 或健康结论', async () => {
    useInstances([status({ id: 'demo', name: '演示实例', tps: null })])
    renderPage()

    const row = within(
      (await screen.findByRole('button', { name: '打开 演示实例' })).closest('tr')!,
    )
    const cells = row.getAllByRole('cell')
    expect(cells[0]).not.toHaveTextContent('TPS')
    expect(cells[2]).toHaveTextContent('—')
    expect(cells[3]).toHaveTextContent('3/20')
    expect(cells[4]).toHaveTextContent('—')
  })

  it('整机读数缺失时不给余量数字（算不出来还报数会被当成结论）', async () => {
    useInstances([status({ id: 'a', name: '甲' })])
    server.use(
      http.get('*/api/v1/overview', () =>
        okJson({ ...mockOverview, systemMemoryTotal: 0, systemMemoryPercent: 0, totalMemory: 0 }),
      ),
    )
    renderPage()
    const memory = within(
      screen.getByRole('heading', { name: '可分配内存余量' }).closest('section')!,
    )
    expect(await memory.findByText('整机内存读数未取到')).toBeInTheDocument()
    expect(memory.getByText('—')).toBeInTheDocument()
    expect(memory.queryByText(/超出可分配量/)).not.toBeInTheDocument()
    const load = within(screen.getByRole('heading', { name: '整机负载' }).closest('section')!)
    expect(load.getByText('内存暂无数据')).toBeInTheDocument()
    expect(load.queryByText('内存 0.0%')).not.toBeInTheDocument()
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
    await screen.findByText('已就绪实例')

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
