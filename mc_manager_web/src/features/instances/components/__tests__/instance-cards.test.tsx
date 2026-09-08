/**
 * InstanceCards 测试：
 * 卡片渲染（名称/状态文本/版本 mono 徽章）/ 状态点 token / 当前徽章 + 无切换按钮 /
 * 切换·启动配置·卸载回调 / 卸载中禁用（他卡不受影响）/ 详情加载骨架 / 空态 + 部署入口
 * mock 数据为结构占位虚构（虚构实例名/版本），严禁真实服务器信息
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { InstanceCards, type InstanceCardsProps } from '../instance-cards'
import { mockInstanceStatus } from '@/test/mocks/handlers'
import { useUpgradeStore } from '@/stores/upgrade'
import type { InstanceSummary } from '@/api/types'

// ── 虚构占位数据（虚构实例名，非真实服务器）──────────────────

const alpha: InstanceSummary = { id: 'alpha', name: '虚构甲服', isRunning: true, playerCount: 3 }
const beta: InstanceSummary = { id: 'beta', name: '虚构乙服', isRunning: false, playerCount: 0 }

function baseProps(overrides: Partial<InstanceCardsProps> = {}): InstanceCardsProps {
  return {
    instances: [alpha, beta],
    currentId: null,
    detailStatuses: {
      alpha: { ...mockInstanceStatus, id: 'alpha', name: '虚构甲服', mcVersion: '1.21.4' },
    },
    loadingIds: new Set<string>(),
    uninstallingId: null,
    onSwitch: vi.fn(),
    onOpenSettings: vi.fn(),
    onUpgrade: vi.fn(),
    onUninstall: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    busyId: null,
    phaseById: {},
    onDeploy: vi.fn(),
    ...overrides,
  }
}

// ── 卡片渲染 ──────────────────────────────────────────────────────

describe('InstanceCards', () => {
  beforeEach(() => {
    useUpgradeStore.setState({ progress: {} })
  })

  afterEach(() => {
    useUpgradeStore.setState({ progress: {} })
  })

  it('渲染实例卡：名称 + 状态文本（运行中 · N 人在线 / 已停止）', () => {
    render(<InstanceCards {...baseProps()} />)

    expect(screen.getByText('虚构甲服')).toBeInTheDocument()
    expect(screen.getByText('虚构乙服')).toBeInTheDocument()
    expect(screen.getByText('运行中 · 3 人在线')).toBeInTheDocument()
    expect(screen.getByText('已停止')).toBeInTheDocument()
  })

  it('世界指标走 formatWorldSize 统一格式化（mock worldSize=1.2GB 字符串 → 1.2 GB）', () => {
    render(<InstanceCards {...baseProps()} />)
    // 有详情的卡显示格式化值；无详情卡显示 —（数量随 fixture detailStatuses 覆盖度变化，≥1 即证明格式化生效）
    expect(screen.getAllByText('1.2 GB').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('1.2GB')).not.toBeInTheDocument()
  })

  it('升级中徽标：store 有非终态进度时显示（issue 352）', () => {
    act(() => {
      useUpgradeStore.setState({
        progress: { alpha: { instanceId: 'alpha', stage: 'download', percent: 40, detail: '', timestamp: 1 } },
      })
    })
    render(<InstanceCards {...baseProps()} />)

    // 仅甲服有升级进度，徽标唯一
    expect(screen.getAllByText('升级中')).toHaveLength(1)
  })

  it('升级终态残留不误显示升级中徽标', () => {
    act(() => {
      useUpgradeStore.setState({
        progress: { alpha: { instanceId: 'alpha', stage: 'completed', percent: 100, detail: '', timestamp: 1 } },
      })
    })
    render(<InstanceCards {...baseProps()} />)

    expect(screen.queryByText('升级中')).not.toBeInTheDocument()
  })

  it('版本徽章：detailStatuses 有 mcVersion 显示 mono 徽章，缺失不显示', () => {
    const { container } = render(<InstanceCards {...baseProps()} />)

    // alpha 有详情 → 显示版本徽章（mono）
    expect(screen.getByText('1.21.4')).toBeInTheDocument()
    const badge = container.querySelector('[data-instance-id="alpha"] .font-mono') as HTMLElement
    expect(badge).not.toBeNull()
    expect(badge?.classList.contains('font-mono')).toBe(true)
    // beta 无详情 → 无版本徽章
    const betaCard = container.querySelector('[data-instance-id="beta"]') as HTMLElement
    expect(betaCard?.querySelector('.font-mono')).toBeNull()
  })

  it('状态点：运行中 success token / 停止 muted token', () => {
    const { container } = render(<InstanceCards {...baseProps()} />)
    const runningDot = container.querySelector('[data-instance-status="running"]') as HTMLElement
    expect(runningDot.classList.contains('bg-mcs-success-fg')).toBe(true)
    const stoppedDot = container.querySelector('[data-instance-status="stopped"]') as HTMLElement
    expect(stoppedDot.classList.contains('bg-mcs-text-muted')).toBe(true)
  })

  it('详情加载中：仅该卡版本徽章位置显示骨架占位（他卡不受影响）', () => {
    const { container } = render(<InstanceCards {...baseProps({ loadingIds: new Set(['alpha']) })} />)
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(1)
    expect(screen.queryByText('1.21.4')).not.toBeInTheDocument()
    // beta 卡无骨架（详情未在途）
    const betaCard = container.querySelector('[data-instance-id="beta"]') as HTMLElement
    expect(betaCard?.querySelector('[data-slot="skeleton"]')).toBeNull()
  })

  it('当前实例：accent 徽章显示「当前」，且无切换按钮；其他实例有切换按钮', () => {
    render(<InstanceCards {...baseProps({ currentId: 'alpha' })} />)

    expect(screen.getByText('当前')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '切换到 虚构甲服' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换到 虚构乙服' })).toBeInTheDocument()
  })

  it('点击「切换」回调 onSwitch 并携带该实例', () => {
    const onSwitch = vi.fn()
    render(<InstanceCards {...baseProps({ onSwitch })} />)

    fireEvent.click(screen.getByRole('button', { name: '切换到 虚构乙服' }))
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(onSwitch).toHaveBeenCalledWith(beta)
  })

  it('点击「启动配置」回调 onOpenSettings 并携带该实例', () => {
    const onOpenSettings = vi.fn()
    render(<InstanceCards {...baseProps({ onOpenSettings })} />)

    fireEvent.click(screen.getByRole('button', { name: '虚构甲服 启动配置' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenCalledWith(alpha)
  })

  it('点击「卸载」回调 onUninstall 并携带该实例', () => {
    const onUninstall = vi.fn()
    render(<InstanceCards {...baseProps({ onUninstall })} />)

    fireEvent.click(screen.getByRole('button', { name: '卸载 虚构甲服' }))
    expect(onUninstall).toHaveBeenCalledTimes(1)
    expect(onUninstall).toHaveBeenCalledWith(alpha)
  })

  it('卸载中：对应卡按钮禁用 + 「卸载中」，点击不触发；其他卡不受影响', () => {
    const onUninstall = vi.fn()
    render(<InstanceCards {...baseProps({ uninstallingId: 'alpha', onUninstall })} />)

    const uninstallAlpha = screen.getByRole('button', { name: '卸载 虚构甲服' })
    expect(uninstallAlpha).toBeDisabled()
    expect(uninstallAlpha).toHaveTextContent('卸载中')
    fireEvent.click(uninstallAlpha)
    expect(onUninstall).not.toHaveBeenCalled()

    // beta 卸载按钮仍可用
    const uninstallBeta = screen.getByRole('button', { name: '卸载 虚构乙服' })
    expect(uninstallBeta).not.toBeDisabled()
    expect(uninstallBeta).toHaveTextContent('卸载')
    fireEvent.click(uninstallBeta)
    expect(onUninstall).toHaveBeenCalledTimes(1)
    expect(onUninstall).toHaveBeenCalledWith(beta)
  })

  it('空态：提示文案 + 「部署新实例」按钮触发 onDeploy', () => {
    const onDeploy = vi.fn()
    render(<InstanceCards {...baseProps({ instances: [], onDeploy })} />)

    expect(screen.getByText('暂无已安装的实例')).toBeInTheDocument()
    expect(screen.getByText('使用部署向导创建第一个实例')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '部署新实例' }))
    expect(onDeploy).toHaveBeenCalledTimes(1)
  })

  it('「当前」徽章只出现在当前实例卡内', () => {
    const { container } = render(<InstanceCards {...baseProps({ currentId: 'beta' })} />)

    const alphaCard = container.querySelector('[data-instance-id="alpha"]') as HTMLElement
    expect(within(alphaCard).queryByText('当前')).not.toBeInTheDocument()
    const betaCard = container.querySelector('[data-instance-id="beta"]') as HTMLElement
    expect(within(betaCard).getByText('当前')).toBeInTheDocument()
  })
})
