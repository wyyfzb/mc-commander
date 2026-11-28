import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { toast } from 'sonner'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import type { InstanceStatus } from '@/api/types'
import { mockInstanceStatus } from '@tests/support/handlers'
import { InstanceControls } from '@/features/dashboard/components/instance-controls'

const apiGet = vi.fn()
const apiPost = vi.fn((..._args: unknown[]) => Promise.resolve(null))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// 启动共享 hook 桩（phase 置入逻辑在其内部，此处只验证消费端禁用行为）
const startInstance = vi.fn((..._args: unknown[]) => undefined)
vi.mock('@/hooks/use-start-instance-with-eula', () => ({
  useStartInstanceWithEula: () => ({
    startInstance,
    startPending: false,
    pendingStartId: null,
    eulaBusy: false,
    eulaDialog: null,
  }),
}))

const stopMutate = vi.fn()
vi.mock('@/hooks/use-instance-stop', () => ({
  useStopInstance: () => ({ mutate: stopMutate, isPending: false, variables: null }),
}))

function setStatus(
  running: boolean,
  startupState: InstanceStatus['startupState'] = running ? 'ready' : 'stopped',
) {
  useServerStore.setState({
    instanceId: 'inst-1',
    status: { ...mockInstanceStatus, id: 'inst-1', isRunning: running, startupState, players: [] },
  })
}

function setPhase(phase: Record<string, 'starting' | 'stopping'>) {
  useServerStore.setState({ phase })
}

function renderControls() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <InstanceControls />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  stopMutate.mockClear()
  startInstance.mockClear()
  apiPost.mockClear()
  apiGet.mockReset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ instanceId: 'inst-1', status: null, phase: {} })
})

// 启动不走通用二次确认：它不破坏任何东西，而真正要看的信息（EULA 未同意）
// 由共享 hook 的对话框承担——先弹一次「确定要启动服务器吗？」才告知起不来
// 是白问一次，且第一个框隐瞒了唯一要看的信息。
describe('InstanceControls 启动确认（EULA 前置条件前移）', () => {
  it('启动：不弹通用确认框，直接发令（不再先问一次再报 EULA）', () => {
    setStatus(false) // 未运行 → 启动可用
    renderControls()

    expect(screen.queryByText('确定要启动服务器吗？')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '启动' }))

    // 直接调 startInstance：确认框不该出现（EULA 对话框由该 hook 内部分支决定）
    expect(startInstance).toHaveBeenCalledTimes(1)
    expect(startInstance.mock.calls[0]?.[0]).toBe('inst-1')
    expect(screen.queryByText('确定要启动服务器吗？')).not.toBeInTheDocument()
  })

  it('启动只回执发令，不因进程存在而提示成功或发起专用轮询', async () => {
    vi.useFakeTimers()
    try {
      setStatus(false)
      apiGet.mockResolvedValue({ isRunning: true, startupState: 'starting' })
      renderControls()
      fireEvent.click(screen.getByRole('button', { name: '启动' }))
      const callbacks = startInstance.mock.calls[0]?.[1] as { onStarted: () => void }
      act(() => {
        setStatus(true, 'starting')
        callbacks.onStarted()
      })

      expect(toast.success).toHaveBeenCalledExactlyOnceWith('启动指令已发送')
      await act(() => vi.advanceTimersByTimeAsync(60_000))
      expect(apiGet).not.toHaveBeenCalled()
      expect(toast.success).toHaveBeenCalledTimes(1)
      expect(toast.error).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('启动不走「非确认即保存」兜底：点击不得误发 save-all', () => {
    setStatus(false)
    renderControls()
    fireEvent.click(screen.getByRole('button', { name: '启动' }))
    // 按动作分派的回归防线：以前 else 分支硬编码 save，
    // 任何新增的免确认动作都会被静默执行成「保存」
    const saveCalls = apiPost.mock.calls.filter((c) => String(c[0]).endsWith('/save'))
    expect(saveCalls).toHaveLength(0)
  })

  it('停止仍需确认（高危动作保留二次确认）', () => {
    setStatus(true)
    renderControls()

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(screen.getByText('关闭服务器')).toBeInTheDocument()
  })

  it('重启经确认发起，收到新进程启动回执才提示', async () => {
    let resolveRequest!: (value: null) => void
    apiPost.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveRequest = resolve
      }),
    )
    setStatus(true)
    renderControls()

    fireEvent.click(screen.getByRole('button', { name: '重启' }))
    expect(screen.getByText('重启服务器')).toBeInTheDocument()
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '重启服务器' })).getByRole('button', {
        name: '重启',
      }),
    )
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/v1/instances/inst-1/restart',
        expect.anything(),
        undefined,
        { timeoutMs: 20_000 },
      ),
    )
    expect(toast.success).not.toHaveBeenCalled()
    resolveRequest(null)
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('新进程已启动，游戏就绪状态待确认'),
    )
  })

  it('保存：无确认调用专用存档接口', async () => {
    setStatus(true)
    renderControls()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // mutationFn 是异步的：等它跑完再断言，否则读到的是空调用表
    await waitFor(() => {
      const saveCalls = apiPost.mock.calls.filter((c) => String(c[0]).endsWith('/save'))
      expect(saveCalls).toHaveLength(1)
    })
    expect(screen.queryByText(/确定要保存/)).not.toBeInTheDocument()
  })
})

describe('InstanceControls phase 中间态', () => {
  it('stopping 中间态：停止按钮禁用 + spinner，其余操作全部禁用', () => {
    setStatus(true)
    setPhase({ 'inst-1': 'stopping' })
    renderControls()

    const stop = screen.getByRole('button', { name: '停止' })
    expect(stop).toBeDisabled()
    expect(stop.querySelector('.animate-spin')).not.toBeNull()

    expect(screen.getByRole('button', { name: '启动' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重启' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

    // 连点保护：disabled 按钮的 click 不触发新请求
    fireEvent.click(stop)
    expect(stopMutate).not.toHaveBeenCalled()
  })

  it('启动中允许停止和重启，暂不允许重复启动或保存', () => {
    setStatus(true, 'starting')
    setPhase({ 'inst-1': 'starting' })
    renderControls()

    const start = screen.getByRole('button', { name: '启动' })
    expect(start).toBeDisabled()
    expect(start.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByRole('button', { name: '重启' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '停止' }))
    expect(stopMutate).toHaveBeenCalledWith('inst-1')
  })

  it('进程就绪未确认时仍可停止、重启和发送保存指令', () => {
    setStatus(true, 'unknown')
    renderControls()

    for (const name of ['停止', '重启', '保存']) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
    expect(screen.getByRole('button', { name: '启动' })).toBeDisabled()
  })

  it('无 phase（原行为）：运行中实例停止可用且可触发确认', () => {
    setStatus(true)
    renderControls()

    const stop = screen.getByRole('button', { name: '停止' })
    expect(stop).toBeEnabled()
    // 停止经确认弹窗（不直接 mutate）；取消后不调用
    fireEvent.click(stop)
    expect(stopMutate).not.toHaveBeenCalled()
  })

  it('非当前实例的 phase 不影响当前实例按钮（多实例隔离）', () => {
    setStatus(true)
    setPhase({ 'inst-other': 'stopping' })
    renderControls()

    expect(screen.getByRole('button', { name: '停止' })).toBeEnabled()
  })
})
