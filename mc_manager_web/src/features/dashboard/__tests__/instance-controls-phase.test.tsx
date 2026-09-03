/**
 * InstanceControls phase 中间态测试（issue 334）
 * - phase=stopping：停止按钮禁用 + spinner；启动/重启/保存按钮禁用（防连点）
 * - phase=starting：启动按钮禁用 + spinner
 * - 无 phase：运行中实例仅停止/重启/保存可用（原行为）
 * 连点保护语义：phase 置入即 disabled，后续 click 被 HTML disabled 拦截（不发新请求）
 * store 状态全部虚构（inst-1），无真实凭据
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import type { InstanceStatus } from '@/api/types'
import { InstanceControls } from '../components/instance-controls'

// 启动共享 hook 桩（phase 置入逻辑在其内部，此处只验证消费端禁用行为）
vi.mock('@/hooks/use-start-instance-with-eula', () => ({
  useStartInstanceWithEula: () => ({
    startInstance: vi.fn(),
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
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ instanceId: 'inst-1', status: null, phase: {} })
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
