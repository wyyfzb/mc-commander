/**
 * 部署进度兜底与重复部署门控测试（J29）：
 * - 刷新/挂载兜底：服务端报告在途 → 恢复部署进度视图，不回落步骤①
 * - 空态收敛：服务端转为空态（部署完成/15 分钟死快照超时）→ 进度视图与轮询一起停下
 * - 重复部署门控：服务端在途 → 实例页「部署新实例」入口禁用；门控信号由
 *   HTTP 快照与 WS deployProgress 两个通道同生命周期维护（终态即释放）
 * - 断线轮询：socket 未连接且进度视图在展示时按 FALLBACK_POLL_INTERVAL_MS 轮询
 *   （冷启动从未连上也照轮询）；WS 已连接时不轮询（WS 为进度主通道）
 * - 终态保护：POST 已给出结果时，兜底快照不得把成功结果顶掉
 * MSW 拦截页面依赖的 API；兜底快照用 spy 精确控制返回值与时序。
 * 数据为结构占位虚构内容（严禁真实服务器信息/玩家数据）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { DeployDialog } from '../components/deploy-dialog'
import { InstancesPage } from '../instances-page'
import { useDeployStatusFallback } from '../hooks/use-deploy-status-fallback'
import { useConnectionStore } from '@/stores/connection'
import { useDeployStore } from '@/stores/deploy'
import { useServerStore } from '@/stores/server'
import { FALLBACK_POLL_INTERVAL_MS } from '@/api/queries'
import * as instancesApi from '@/api/instances'
import type { DeployStatusResponse } from '@/api/types'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

/** 在途快照（结构占位虚构数据） */
const IN_FLIGHT: DeployStatusResponse = {
  deploying: true,
  instanceId: 'paper-a1b2c3d4',
  instanceName: '生存服',
  type: 'paper',
  mcVersion: '1.21.4',
  stage: 'forge_install',
  percent: 0.45,
  transferred: 52_428_800,
  total: 104_857_600,
  updatedAt: Date.now(),
}

/** 兜底查询替身（默认空态；用例按需覆写返回值） */
let deployStatusImpl: () => Promise<DeployStatusResponse>

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DeployDialog open onOpenChange={vi.fn()} onDeployed={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** 实例页（含部署向导：同屏两个兜底查询观察者，共用同一条 query 缓存） */
function renderInstancesPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/instances',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <InstancesPage />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/instances'] },
  )
  render(<RouterProvider router={router} />)
  return qc
}

/**
 * 生产 QueryClient 的 queries.staleTime（src/main.tsx）——本用例组按同一取值建
 * client：兜底查询的重新挂载重取必须由它自己的 staleTime 决定，不能靠测试里
 * 恰好用了 staleTime 0 的替身 client 蒙对
 */
const GLOBAL_STALE_TIME_MS = 10_000

/** 兜底 hook 的最小宿主（无页面噪声，只观察它的查询与门控） */
function FallbackProbe() {
  useDeployStatusFallback()
  return null
}

function renderFallbackProbe(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <FallbackProbe />
    </QueryClientProvider>,
  )
}

/**
 * 推进假时钟并落定 React Query 的订阅通知：只 advance(0) 时查询结果已入缓存，
 * 但订阅者的重渲染批次不在同一个 act 内，store/DOM 断言会读到旧值
 */
async function advanceAndFlush(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await vi.advanceTimersByTimeAsync(1)
  })
}

beforeEach(() => {
  localStorage.clear()
  deployStatusImpl = () => Promise.resolve({ deploying: false })
  vi.spyOn(instancesApi, 'apiGetDeployStatus').mockImplementation(() => deployStatusImpl())
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ socketConnected: true, hasConnectedOnce: true })
  // resetDeploy 而非逐字段 setState：门控/进度字段随实现增删，整体复位不残留上一用例
  useDeployStore.getState().resetDeploy()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('部署进度兜底（J29）', () => {
  it('刷新页面：兜底快照恢复在途进度，不回落步骤①', async () => {
    deployStatusImpl = () => Promise.resolve(IN_FLIGHT)
    renderDialog()

    // 服务端报告在途 → 进度视图（阶段中文标签），表单步骤①不可见
    expect(await screen.findByText('正在安装 Forge…')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45')
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '下一步' })).not.toBeInTheDocument()
  })

  it('服务端无在途部署：空态不产生进度视图（照常进入步骤①）', async () => {
    renderDialog()

    expect(await screen.findByRole('button', { name: '下一步' })).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('本地已有本轮结果时兜底快照不覆盖终态（成功结果不被在途快照顶掉）', () => {
    act(() => {
      useDeployStore.setState({
        deploying: false,
        progress: { stage: 'complete', percent: 1, transferred: 0, total: 0 },
        lastResult: { ok: true, instanceId: 'paper-a1b2c3d4' },
      })
    })

    act(() => {
      useDeployStore.getState().applyDeployStatus(IN_FLIGHT)
    })

    expect(useDeployStore.getState().lastResult?.ok).toBe(true)
    expect(useDeployStore.getState().deploying).toBe(false)
    expect(useDeployStore.getState().progress?.stage).toBe('complete')
  })

  it('WS 断线且服务端在途：按 FALLBACK_POLL_INTERVAL_MS 轮询；重连后停止', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(instancesApi, 'apiGetDeployStatus')
    deployStatusImpl = () => Promise.resolve(IN_FLIGHT)
    act(() => {
      useServerStore.setState({ socketConnected: false, hasConnectedOnce: true })
      useDeployStore.setState({
        deploying: true,
        progress: { stage: 'download', percent: 0.5, transferred: 1, total: 2, instanceId: 'paper-a1b2c3d4' },
      })
    })
    renderDialog()
    // 挂载查询一次（兜底基线）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const afterMount = spy.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_INTERVAL_MS)
    })
    expect(spy.mock.calls.length).toBe(afterMount + 1)

    // WS 恢复 → 停轮询（进度回主通道）
    act(() => {
      useServerStore.setState({ socketConnected: true })
    })
    const afterReconnect = spy.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_INTERVAL_MS * 2)
    })
    expect(spy.mock.calls.length).toBe(afterReconnect)
  })
  it('冷启动即断线（WS 从未连上）且在途：兜底照常轮询，进度不永久冻结', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(instancesApi, 'apiGetDeployStatus')
    deployStatusImpl = () => Promise.resolve(IN_FLIGHT)
    act(() => {
      useServerStore.setState({ socketConnected: false, hasConnectedOnce: false })
    })
    renderDialog()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const afterMount = spy.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    // 轮询不以「曾连接过」为前提：否则冷启动断线时兜底从不启动
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_INTERVAL_MS)
    })
    expect(spy.mock.calls.length).toBe(afterMount + 1)
  })

  it('WS 正常连接时兜底不轮询（无冗余请求）', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(instancesApi, 'apiGetDeployStatus')
    act(() => {
      useServerStore.setState({ socketConnected: true })
      useDeployStore.setState({ deploying: true })
    })
    renderDialog()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const afterMount = spy.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FALLBACK_POLL_INTERVAL_MS * 2)
    })
    expect(spy.mock.calls.length).toBe(afterMount)
  })

  it('在途 → 空态：进度视图回到步骤①，且轮询一并停下', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(instancesApi, 'apiGetDeployStatus')
    deployStatusImpl = () => Promise.resolve(IN_FLIGHT)
    act(() => {
      useServerStore.setState({ socketConnected: false, hasConnectedOnce: true })
    })
    renderDialog()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(useDeployStore.getState().deploying).toBe(true)

    // 服务端转为空态：断线期间部署完成，或 15 分钟死快照超时
    deployStatusImpl = () => Promise.resolve({ deploying: false })
    await advanceAndFlush(FALLBACK_POLL_INTERVAL_MS)

    expect(useDeployStore.getState().deploying).toBe(false)
    expect(useDeployStore.getState().progress).toBeNull()
    expect(screen.getByRole('button', { name: '下一步' })).toBeInTheDocument()

    const afterConverge = spy.mock.calls.length
    await advanceAndFlush(FALLBACK_POLL_INTERVAL_MS * 2)
    expect(spy.mock.calls.length).toBe(afterConverge)
  })
})

describe('重复部署门控（J29）', () => {
  it('实例页：服务端报告在途 → 「部署新实例」入口禁用，向导不再可打开', async () => {
    deployStatusImpl = () => Promise.resolve(IN_FLIGHT)
    renderInstancesPage()

    const blocked = await screen.findByRole('button', { name: '已有部署在进行中' })
    expect(blocked).toBeDisabled()
    // 同屏可见恢复后的进度横幅（服务端真值，不是回落空态）
    expect(await screen.findByText(/有实例正在部署/)).toBeInTheDocument()
  })

  it('本地本轮尚未结束时（新会话）：兜底快照直接进入进度视图，无部署入口', async () => {
    deployStatusImpl = () => Promise.resolve(IN_FLIGHT)
    renderDialog()

    expect(await screen.findByText('正在安装 Forge…')).toBeInTheDocument()
    // 无「发起部署」入口（向导被进度视图替代），此刻唯一出口是取消在途部署
    expect(screen.queryByRole('button', { name: '下一步' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /仅部署|部署并启动/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消部署' })).toBeInTheDocument()
  })

  it('仅由 WS 观察到的在途部署也禁用入口（门控不依赖 HTTP 快照）', async () => {
    const spy = vi.spyOn(instancesApi, 'apiGetDeployStatus')
    renderInstancesPage()
    // 先让挂载兜底快照（空态）落定：此后只有 WS 报在途
    await waitFor(() => expect(spy).toHaveBeenCalled())
    await act(async () => {})
    expect(await screen.findByRole('button', { name: '部署新实例' })).toBeEnabled()

    act(() => {
      useDeployStore.getState().applyDeployProgress({
        stage: 'download',
        percent: 0.2,
        transferred: 1,
        total: 2,
        instanceName: '生存服',
      })
    })

    expect(screen.getByRole('button', { name: '已有部署在进行中' })).toBeDisabled()
  })

  it('WS 报终态即释放门控：横幅消失后入口恢复可用（状态不误报）', async () => {
    const spy = vi.spyOn(instancesApi, 'apiGetDeployStatus')
    renderInstancesPage()
    await waitFor(() => expect(spy).toHaveBeenCalled())
    await act(async () => {})

    act(() => {
      useDeployStore.getState().applyDeployProgress({
        stage: 'forge_install',
        percent: 0.45,
        transferred: 1,
        total: 2,
        instanceName: '生存服',
      })
    })
    expect(screen.getByRole('button', { name: '已有部署在进行中' })).toBeDisabled()

    act(() => {
      useDeployStore.getState().applyDeployProgress({
        stage: 'complete',
        percent: 1,
        transferred: 0,
        total: 0,
        instanceName: '生存服',
      })
    })

    expect(screen.getByRole('button', { name: '部署新实例' })).toBeEnabled()
    expect(screen.queryByText(/有实例正在部署/)).not.toBeInTheDocument()
  })

  it('本页自己的部署结束（POST 已响应）后门控解除，服务端残留快照不会永久禁用入口', async () => {
    renderDialog()
    // 本页发起部署并在途
    act(() => {
      useDeployStore.getState().startDeploy()
      useDeployStore.getState().applyDeployStatus(IN_FLIGHT)
    })
    expect(useDeployStore.getState().deployInFlight).toBe(true)

    // POST 响应落定 → 在途标记清除（服务端快照可能仍是最后一条在途记录）
    act(() => {
      useDeployStore.getState().finishDeploy({ ok: true, instanceId: 'paper-a1b2c3d4' })
    })
    expect(useDeployStore.getState().deployInFlight).toBe(false)

    // 残留快照再到（兜底轮询）也不夺回门控：结果已终态
    act(() => {
      useDeployStore.getState().applyDeployStatus(IN_FLIGHT)
    })
    expect(useDeployStore.getState().deployInFlight).toBe(false)
    expect(useDeployStore.getState().lastResult?.ok).toBe(true)
  })
})

/**
 * 兜底查询自身的新鲜度策略：它每次挂载都要问一次服务端真值（刷新页面、从别的
 * 路由切回实例页），吃全局 10s staleTime 会让「切走再切回」在新鲜期内复用缓存、
 * 拿不到这期间变化的在途状态。此组用与生产同值的 client，锁住该查询 staleTime 0。
 */
describe('兜底查询新鲜度（J29）', () => {
  /** 生产同值 QueryClient：全局 staleTime 非 0，避免替身 client 把结论架空 */
  function newClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: GLOBAL_STALE_TIME_MS } } })
  }

  it('新鲜期内重新挂载（切走再切回）仍重取服务端真值', async () => {
    const qc = newClient()
    const spy = vi.spyOn(instancesApi, 'apiGetDeployStatus')
    const { unmount } = renderFallbackProbe(qc)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))

    // 立刻卸载再挂载：全局 staleTime 内（数据新鲜）也不得复用缓存
    unmount()
    renderFallbackProbe(qc)

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
  })
})

/**
 * 兜底快照守卫顺序（F2）：本页已有终态回执时，门控仍可能被非终态 WS 事件占回
 * （并发的另一次部署）。此时到达的空态快照必须优先于「终态回执」守卫被处理——
 * 否则这次释放被整体吞掉，入口停在「部署中」直到刷新。此处锁「空态释放门控」
 * 与「终态回执原样保留」两件事同时成立。
 */
describe('兜底快照守卫顺序（F2）', () => {
  it('终态回执后门控被 WS 占回：空态快照仍须释放门控，且不抹掉终态回执', () => {
    act(() => {
      useDeployStore.getState().finishDeploy({ ok: true, instanceId: 'paper-a1b2c3d4' })
    })
    const receipt = useDeployStore.getState().lastResult
    // 非终态 WS 事件（此处代表并发的另一次部署）重新占据门控
    act(() => {
      useDeployStore.getState().applyDeployProgress({
        stage: 'download',
        percent: 0.1,
        transferred: 1,
        total: 10,
        instanceName: '他端部署',
      })
    })
    expect(useDeployStore.getState().deployInFlight).toBe(true)

    // 守卫若整体前置到空态分支之前，这次空态被 return 吞掉，门控与进度视图都不收敛
    act(() => {
      useDeployStore.getState().applyDeployStatus({ deploying: false })
    })

    const s = useDeployStore.getState()
    expect(s.deployInFlight).toBe(false)
    expect(s.deploying).toBe(false)
    expect(s.progress).toBeNull()
    expect(s.lastResult).toBe(receipt)
  })
})
