import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render as rtlRender, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { PerfSnapshotResponse } from '@mc-commander/schemas'
import { AlertBanner } from '@/features/dashboard/components/alert-banner'
import { PerfSheet } from '@/features/diagnostics/perf-sheet'
import type { AlertType } from '@/lib/notifications'
import { useUiStore } from '@/stores/ui'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { ErrorCode } from '@/api/errors'
import { mockInstanceStatus } from '@tests/support/handlers'

/**
 * 三入口 + Sheet 的接线测试。
 *
 * 承重点：入口点的判断与它作用的对象在同一个可测单元里——
 * 告警条「磁盘告警不给性能入口」这条如果只测常量集合，把页面接成恒 true 也不会红。
 */

/** Sheet 内的采集走 useMutation、运行态走 useQuery：两者都需要 provider */
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function makeSnapshot(over: Partial<PerfSnapshotResponse> = {}): PerfSnapshotResponse {
  return {
    kind: 'perf',
    collectedAt: '2026-11-01T06:43:50.000Z',
    windowMs: 10013,
    verdict: {
      level: 'healthy',
      headline: '没发现瓶颈：耗时与内存都还有余量',
      detail: '单刻平均耗时 0.1 ms（预算 50 ms）。',
      findings: [{ label: '单刻平均耗时', value: '0.1 ms', hint: null }],
    },
    perf: {
      mcVersion: '26.3',
      javaVersion: '25.0.5',
      cpus: 4,
      processCpuPercent: 17.55,
      tick: {
        averageMs: 0.129312,
        p99Ms: 0.2,
        maxMs: 0.25,
        samples: 100,
        tickSpan: 201,
        timeSpanMs: 10013,
        ticksPerSecond: 20.07,
      },
      heap: {
        usedPeakMiB: 197.01,
        usedStartMiB: 194.91,
        usedEndMiB: 197.01,
        maxMiB: 1024,
        usedPeakPercent: 19.24,
        samples: 201,
      },
      hotspots: [{ name: 'unspecified', sharePercent: 93.66 }],
      dimensions: [{ name: 'overworld', chunks: 12, entities: 140 }],
    },
    jfr: null,
    archivePath: 'debug/profiling/2026-11-01_14_43_13-world-26_3.zip',
    parseWarnings: [],
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({
    baseUrl: '',
    apiKey: `test-key-${crypto.randomUUID()}`,
    status: 'ready',
  })
  useServerStore.setState({
    status: mockInstanceStatus,
    instanceId: 'demo',
    systemStats: null,
    socketConnected: true,
    lastStatusEvent: null,
  })
  useUiStore.setState({ perfSheetInstanceId: null, lastOutputInstanceId: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 拦 fetch 并给出 perf 端点的响应；其它请求（实例状态）回一份可解析的最小体 */
function stubPerfFetch(
  handler: (init?: RequestInit) => Response,
  status: typeof mockInstanceStatus = mockInstanceStatus,
) {
  const fetchMock = vi.fn((url: string | URL) => {
    const u = String(url)
    if (u.includes('/perf/snapshot')) return Promise.resolve(handler())
    if (/\/api\/v1\/instances\/[^/]+$/.test(u)) {
      return Promise.resolve(
        new Response(JSON.stringify(okEnvelope(status)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify(okEnvelope(null)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 实例状态端点回 500：Sheet 读不到运行态，但 perf 端点仍可调 */
function stubStatusFailure() {
  const fetchMock = vi.fn((url: string | URL) => {
    const u = String(url)
    if (u.includes('/perf/snapshot')) return Promise.resolve(okResponse(makeSnapshot()))
    if (/\/api\/v1\/instances\/[^/]+$/.test(u)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'error',
            code: 50000,
            message: 'internal error',
            details: null,
            timestamp: '',
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify(okEnvelope(null)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * 成功信封。`message` 与 `timestamp` 是契约必填项：前端在请求边界会做信封
 * 结构校验，缺字段的响应会被判成「结构不符合契约」并抛网络错误——
 * 夹具少写这两个键时，失败会以「网络错误」的形式出现，与真实原因相距很远。
 */
function okEnvelope(data: unknown) {
  return { status: 'ok', code: 0, message: 'ok', data, timestamp: new Date().toISOString() }
}

function okResponse(data: PerfSnapshotResponse) {
  return new Response(JSON.stringify(okEnvelope(data)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(code: number, message: string) {
  return new Response(
    JSON.stringify({ status: 'error', code, message, details: null, timestamp: '' }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
}

describe('AlertBanner：按告警类型决定是否给性能入口', () => {
  const renderBanner = (types: AlertType[]) => render(<AlertBanner alerts={new Set(types)} />)

  it('TPS 告警 → 给「查是否性能导致」', () => {
    renderBanner(['lowTps'])
    expect(screen.getByRole('button', { name: '查是否性能导致' })).toBeInTheDocument()
  })

  it('CPU / 内存告警 → 都给入口（都与性能快照的指标同域）', () => {
    renderBanner(['highCpu'])
    expect(screen.getByRole('button', { name: '查是否性能导致' })).toBeInTheDocument()
  })

  it('纯磁盘告警 → 不给入口（性能快照里没有磁盘指标）', () => {
    renderBanner(['highDisk'])
    expect(screen.queryByRole('button', { name: '查是否性能导致' })).not.toBeInTheDocument()
  })

  it('严重磁盘告警 → 同样不给入口', () => {
    renderBanner(['criticalDisk'])
    expect(screen.queryByRole('button', { name: '查是否性能导致' })).not.toBeInTheDocument()
  })

  it('磁盘与 TPS 同时告警 → 给入口（只要有一条相关就该能查）', () => {
    renderBanner(['highDisk', 'lowTps'])
    expect(screen.getByRole('button', { name: '查是否性能导致' })).toBeInTheDocument()
  })

  it('点入口把当前实例 id 写进 store（不是别的实例）', async () => {
    renderBanner(['lowTps'])
    await userEvent.click(screen.getByRole('button', { name: '查是否性能导致' }))
    expect(useUiStore.getState().perfSheetInstanceId).toBe('demo')
  })

  it('无告警时整条不渲染', () => {
    const { container } = renderBanner([])
    expect(container).toBeEmptyDOMElement()
  })
})

describe('PerfSheet：态覆盖', () => {
  it('未打开时不渲染内容', () => {
    stubPerfFetch(() => okResponse(makeSnapshot()))
    render(<PerfSheet />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('打开即空态：给采集按钮与「这是一次取样」的说明', async () => {
    stubPerfFetch(() => okResponse(makeSnapshot()))
    useUiStore.setState({ perfSheetInstanceId: 'demo' })
    render(<PerfSheet />)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /取一次快照/ })).toBeInTheDocument()
    expect(screen.getByText(/还没有取过快照/)).toBeInTheDocument()
  })

  it('采集成功 → 出结论与取样窗口声明', async () => {
    stubPerfFetch(() => okResponse(makeSnapshot()))
    useUiStore.setState({ perfSheetInstanceId: 'demo' })
    render(<PerfSheet />)

    await userEvent.click(await screen.findByRole('button', { name: /取一次快照/ }))

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: '没发现瓶颈：耗时与内存都还有余量' }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByTestId('perf-window')).toHaveTextContent('不会自动更新')
  })

  it('采集失败 → 出错误横幅 + 重试按钮', async () => {
    stubPerfFetch(() => errorResponse(ErrorCode.SERVER_ERROR, '等待性能快照包超时'))
    useUiStore.setState({ perfSheetInstanceId: 'demo' })
    render(<PerfSheet />)

    await userEvent.click(await screen.findByRole('button', { name: /取一次快照/ }))

    await waitFor(() => expect(screen.getByText(/没取到快照/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument()
  })

  it('版本不支持 → 错误横幅在，但**没有**重试按钮', async () => {
    stubPerfFetch(() =>
      errorResponse(ErrorCode.PERF_UNSUPPORTED, '该服务端版本不支持性能快照（/perf）'),
    )
    useUiStore.setState({ perfSheetInstanceId: 'demo' })
    render(<PerfSheet />)

    await userEvent.click(await screen.findByRole('button', { name: /取一次快照/ }))

    await waitFor(() => expect(screen.getByText(/没取到快照/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /重试/ })).not.toBeInTheDocument()
  })

  it('实例未运行 → 采集按钮禁用，并说明原因', async () => {
    stubPerfFetch(() => okResponse(makeSnapshot()), {
      ...mockInstanceStatus,
      isRunning: false,
    })
    useServerStore.setState({
      status: { ...mockInstanceStatus, isRunning: false },
      instanceId: 'demo',
    })
    useUiStore.setState({ perfSheetInstanceId: 'demo' })
    render(<PerfSheet />)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    // 运行态来自实例状态查询，需等它落定后横幅才出现
    expect(await screen.findByText(/服务器未在运行/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /取一次快照/ })).toBeDisabled()
  })

  /* 读不到运行态 ≠ 已停止：前者我们不知道它到底在不在跑，把它当成「已停止」禁用按钮，
     会让「服务器卡了」这个最需要诊断的时刻点不动。放行 + 说明比静默禁用诚实 */
  it('运行状态读失败 → 按钮仍可点，并交代读不到与点了会怎样', async () => {
    stubStatusFailure()
    useUiStore.setState({ perfSheetInstanceId: 'demo' })
    render(<PerfSheet />)

    expect(await screen.findByText(/读不到实例运行状态/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /取一次快照/ })).toBeEnabled()
    // 反向锚点：「已停止」是另一条事实，读失败时不得说成它
    expect(screen.queryByText(/服务器未在运行/)).not.toBeInTheDocument()
  })

  /* 采集会往 debug/ 写文件：文件页与实例详情的磁盘占用读同一份数据。
     不失效就会把「采集前的旧值」当成采集后的结果展示 */
  it('采集成功 → 失效发起采集那台实例的详情（不是当前选中实例）', async () => {
    const fetchMock = stubPerfFetch(() => okResponse(makeSnapshot()))
    useServerStore.setState({ status: mockInstanceStatus, instanceId: 'instance-b' })
    useUiStore.setState({ perfSheetInstanceId: 'instance-a' })
    render(<PerfSheet />)

    await userEvent.click(await screen.findByRole('button', { name: /取一次快照/ }))
    await screen.findByText(/没发现瓶颈/)

    // 失效会触发详情重取：看实例状态端点被再打一次，且打的是 A
    await waitFor(() => {
      const statusCalls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => /\/api\/v1\/instances\/[^/]+$/.test(u))
      expect(statusCalls.filter((u) => u.endsWith('/instance-a')).length).toBeGreaterThan(1)
      expect(statusCalls.some((u) => u.endsWith('/instance-b'))).toBe(false)
    })
  })

  it('关闭 Sheet 把 store 里的实例 id 清掉', async () => {
    stubPerfFetch(() => okResponse(makeSnapshot()))
    useUiStore.setState({ perfSheetInstanceId: 'demo' })
    render(<PerfSheet />)

    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(useUiStore.getState().perfSheetInstanceId).toBeNull())
  })
})

describe('多实例：诊断目标跟随入口而非当前选中实例', () => {
  it('从 A 的入口打开时请求打的是 A（当前选中是 B）', async () => {
    const fetchMock = stubPerfFetch(() => okResponse(makeSnapshot()))
    useServerStore.setState({ status: mockInstanceStatus, instanceId: 'instance-b' })
    useUiStore.setState({ perfSheetInstanceId: 'instance-a' })
    render(<PerfSheet />)

    await userEvent.click(await screen.findByRole('button', { name: /取一次快照/ }))

    await waitFor(() => {
      const called = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(called.some((u) => u.includes('/instances/instance-a/perf/snapshot'))).toBe(true)
      expect(called.some((u) => u.includes('/instances/instance-b/perf/snapshot'))).toBe(false)
    })
  })
})

describe('换实例必须清掉上一台的结果', () => {
  /* 这个组件在 AppShell 里只挂一次，mutation 的 data 不随 store 里的 instanceId 变化而清空。
     不清的话，B 的标题下会显示 A 的结论，而「下载产物」用当前 instanceId 拼路径 ⇒
     请求打到 B 上 A 的路径。断言必须落在「同一挂载内换 id」上：重挂载会重建 mutation，
     正好把缺陷掩盖掉 */
  it('同一挂载内从 A 换到 B：A 的结论不再显示', async () => {
    stubPerfFetch(() => okResponse(makeSnapshot()))
    useUiStore.setState({ perfSheetInstanceId: 'instance-a' })
    render(<PerfSheet />)

    await userEvent.click(await screen.findByRole('button', { name: /取一次快照/ }))
    await screen.findByText(/没发现瓶颈/)

    act(() => useUiStore.setState({ perfSheetInstanceId: 'instance-b' }))

    await waitFor(() => expect(screen.queryByText(/没发现瓶颈/)).not.toBeInTheDocument())
    // 换到 B 后回到未采集态，而不是空白
    expect(await screen.findByRole('button', { name: /取一次快照/ })).toBeInTheDocument()
  })

  it('关掉再打开同一台：结果仍在（关闭不等于作废）', async () => {
    stubPerfFetch(() => okResponse(makeSnapshot()))
    useUiStore.setState({ perfSheetInstanceId: 'instance-a' })
    render(<PerfSheet />)

    await userEvent.click(await screen.findByRole('button', { name: /取一次快照/ }))
    await screen.findByText(/没发现瓶颈/)

    act(() => useUiStore.setState({ perfSheetInstanceId: null }))
    act(() => useUiStore.setState({ perfSheetInstanceId: 'instance-a' }))

    expect(await screen.findByText(/没发现瓶颈/)).toBeInTheDocument()
  })
})
