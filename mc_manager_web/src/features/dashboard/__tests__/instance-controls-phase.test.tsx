/**
 * InstanceControls phase 中间态测试（issue 334）
 * - phase=stopping：停止按钮禁用 + spinner；启动/重启/保存按钮禁用（防连点）
 * - phase=starting：启动按钮禁用 + spinner
 * - 无 phase：运行中实例仅停止/重启/保存可用（原行为）
 * 连点保护语义：phase 置入即 disabled，后续 click 被 HTML disabled 拦截（不发新请求）
 * store 状态全部虚构（inst-1），无真实凭据
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import type { InstanceStatus } from '@/api/types'
import { InstanceControls } from '../components/instance-controls'

// apiPost 间谍：用于断言「点启动没有误发 save-all」
const apiPost = vi.fn((..._args: unknown[]) => Promise.resolve(null))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiPost: (...args: unknown[]) => apiPost(...args),
}))

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

function setStatus(running: boolean) {
  useServerStore.setState({
    instanceId: 'inst-1',
    status: { isRunning: running, players: [] } as unknown as InstanceStatus,
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
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ instanceId: 'inst-1', status: null, phase: {} })
})

// 启动不再走通用二次确认：它不破坏任何东西，而真正要看的信息（EULA 未同意）
// 由共享 hook 的对话框承担。以前先弹「确定要启动服务器吗？」，确认后才被告知
// 起不来——白问一次，且第一个框隐瞒了唯一要看的信息。
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

  it('启动不走「非确认即保存」兜底：点击不得误发 save-all', () => {
    setStatus(false)
    renderControls()
    fireEvent.click(screen.getByRole('button', { name: '启动' }))
    // 按动作分派的回归防线：以前 else 分支硬编码 save，
    // 任何新增的免确认动作都会被静默执行成「保存」
    const saveCalls = apiPost.mock.calls.filter((c) => String(c[0]).includes('/command'))
    expect(saveCalls).toHaveLength(0)
  })

  it('停止仍需确认（高危动作保留二次确认）', () => {
    setStatus(true)
    renderControls()

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(screen.getByText('关闭服务器')).toBeInTheDocument()
  })

  it('重启仍需确认（高危动作保留二次确认）', () => {
    setStatus(true)
    renderControls()

    fireEvent.click(screen.getByRole('button', { name: '重启' }))
    expect(screen.getByText('重启服务器')).toBeInTheDocument()
  })

  it('保存：无确认直接发 save-all（原行为保留）', async () => {
    setStatus(true)
    renderControls()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // mutationFn 是异步的：等它跑完再断言，否则读到的是空调用表
    await waitFor(() => {
      const saveCalls = apiPost.mock.calls.filter((c) => String(c[0]).includes('/command'))
      expect(saveCalls).toHaveLength(1)
    })
    expect(screen.queryByText(/确定要保存/)).not.toBeInTheDocument()
  })
})

describe('InstanceControls phase 中间态（issue 334）', () => {
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

  it('starting 中间态：运行中的实例停止/重启/保存仍禁用（启停互斥）', () => {
    setStatus(true)
    setPhase({ 'inst-1': 'starting' })
    renderControls()

    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重启' })).toBeDisabled()
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
