/**
 * InstanceCards 测试：
 * 卡片渲染（名称/状态文本/版本 mono 徽章）/ 状态点 token / 当前徽章 + 无切换按钮 /
 * 操作行收敛（主操作两个 + 操作菜单）/ 切换·启动配置·升级·卸载回调 /
 * 卸载中禁用（他卡不受影响）/ 详情加载骨架 / 空态 + 部署入口
 * mock 数据为结构占位虚构（虚构实例名/版本），严禁真实服务器信息
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InstanceCards, type InstanceCardsProps } from '../instance-cards'
import { mockInstanceStatus } from '@/test/mocks/handlers'
import { useUpgradeStore } from '@/stores/upgrade'
import type { InstanceSummary } from '@/api/types'

// ── 虚构占位数据（虚构实例名，非真实服务器）──────────────────

const alpha: InstanceSummary = { id: 'alpha', name: '虚构甲服', isRunning: true, playerCount: 3 }
const beta: InstanceSummary = { id: 'beta', name: '虚构乙服', isRunning: false, playerCount: 0 }

/** 打开某张卡的「操作菜单」（radix 触发器吃 pointerdown，须走 userEvent） */
async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `${name} 操作菜单` }))
}

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

  it('内存指标带 GB 单位，与同行「世界」口径一致（标签不写「JVM 堆」：字段实为进程内存）', () => {
    render(<InstanceCards {...baseProps()} />)
    expect(screen.getAllByText('3.2 GB').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('3.2G')).not.toBeInTheDocument()
    expect(screen.queryByText('JVM 堆')).not.toBeInTheDocument()
  })

  it('统计未就绪（memoryUsage=0）时内存显示 —，不报「0 GB」', () => {
    // 只渲染甲服：乙服无详情也会渲染一枚「内存」标签，两枚会让 getByText 歧义
    render(
      <InstanceCards
        {...baseProps({
          instances: [alpha],
          detailStatuses: {
            alpha: { ...mockInstanceStatus, id: 'alpha', name: '虚构甲服', memoryUsage: 0 },
          },
        })}
      />,
    )
    // 运行中却显示 0 GB 会被读成「内存耗光」；世界大小同行的缺省写法就是 —
    expect(screen.queryByText('0 GB')).not.toBeInTheDocument()
    expect(screen.getByText('内存').parentElement).toHaveTextContent('—')
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

  it('取消终态同样算终态：不残留升级中徽标（判据与弹窗/WS 同源）', () => {
    act(() => {
      useUpgradeStore.setState({
        progress: { alpha: { instanceId: 'alpha', stage: 'cancelled', percent: 0, detail: '已取消，实例保持 1.21.1', timestamp: 1 } },
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

  it('实例固定色相标识：左缘色条逐卡按 id 取槽（类名钉死，映射漂移即红）', () => {
    const { container } = render(<InstanceCards {...baseProps()} />)
    const alphaCard = container.querySelector('[data-instance-id="alpha"]') as HTMLElement
    const betaCard = container.querySelector('[data-instance-id="beta"]') as HTMLElement
    // 色条与状态点是两个不同来源：色条只回答「哪个实例」，状态点回答「运行/停止」
    const alphaBar = alphaCard.querySelector('[data-instance-hue]')
    const betaBar = betaCard.querySelector('[data-instance-hue]')
    // 字面量断言（不调 instanceHueFillClass 自证）：alpha → slot 4、beta → slot 6
    expect(alphaBar).toHaveClass('bg-mcs-identity-4')
    expect(betaBar).toHaveClass('bg-mcs-identity-6')
    expect(alphaBar).toHaveAttribute('aria-hidden')
    // 不得与语义色混淆：色条不携带 success/error 状态类（语义色声明源只有 tone.ts）
    expect(alphaBar).not.toHaveClass('bg-mcs-success-fg')
    expect(alphaBar).not.toHaveClass('bg-mcs-error-fg')
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

  // ── 操作行收敛────────────────────────────────────────────

  it('行内最多两个主操作：启停 + 切换（非当前实例）+ 一个操作菜单触发器', () => {
    const { container } = render(<InstanceCards {...baseProps()} />)
    const card = (id: string) => container.querySelector(`[data-instance-id="${id}"]`) as HTMLElement

    // 卡片内除操作行外无其他按钮，故按钮集合即操作行
    const labels = (id: string) =>
      within(card(id))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
    expect(labels('alpha')).toEqual(['停止 虚构甲服', '切换到 虚构甲服', '虚构甲服 操作菜单'])
    expect(labels('beta')).toEqual(['启动 虚构乙服', '切换到 虚构乙服', '虚构乙服 操作菜单'])
  })

  it('当前实例只剩启停 + 操作菜单（无切换主操作）', () => {
    const { container } = render(<InstanceCards {...baseProps({ currentId: 'alpha' })} />)
    const card = container.querySelector('[data-instance-id="alpha"]') as HTMLElement

    expect(within(card).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      '停止 虚构甲服',
      '虚构甲服 操作菜单',
    ])
  })

  it('操作菜单：启动配置 / 升级版本 / 卸载实例三项，卸载为破坏性样式且与安全项分隔', async () => {
    const user = userEvent.setup()
    render(<InstanceCards {...baseProps()} />)
    await openMenu(user, '虚构乙服')

    expect(await screen.findByRole('menuitem', { name: '启动配置' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '升级版本' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '卸载实例' })).toHaveAttribute('data-variant', 'destructive')
    // 破坏性项与安全项之间的视觉分组（收编前二者分属不同按钮，无此分组）；菜单挂在 body 上的 portal 里
    expect(document.querySelectorAll('[data-slot="dropdown-menu-separator"]')).toHaveLength(1)
  })

  it('运行中实例的菜单不含「升级版本」（升级要求先停止）', async () => {
    const user = userEvent.setup()
    render(<InstanceCards {...baseProps()} />)
    await openMenu(user, '虚构甲服')

    expect(await screen.findByRole('menuitem', { name: '启动配置' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '升级版本' })).not.toBeInTheDocument()
  })

  it('菜单「启动配置」回调 onOpenSettings 并携带该实例', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    render(<InstanceCards {...baseProps({ onOpenSettings })} />)

    await openMenu(user, '虚构甲服')
    await user.click(await screen.findByRole('menuitem', { name: '启动配置' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenCalledWith(alpha)
  })

  it('菜单「升级版本」回调 onUpgrade 并携带该实例', async () => {
    const user = userEvent.setup()
    const onUpgrade = vi.fn()
    render(<InstanceCards {...baseProps({ onUpgrade })} />)

    await openMenu(user, '虚构乙服')
    await user.click(await screen.findByRole('menuitem', { name: '升级版本' }))
    expect(onUpgrade).toHaveBeenCalledTimes(1)
    expect(onUpgrade).toHaveBeenCalledWith(beta)
  })

  it('菜单「卸载实例」回调 onUninstall 并携带该实例', async () => {
    const user = userEvent.setup()
    const onUninstall = vi.fn()
    render(<InstanceCards {...baseProps({ onUninstall })} />)

    await openMenu(user, '虚构甲服')
    await user.click(await screen.findByRole('menuitem', { name: '卸载实例' }))
    expect(onUninstall).toHaveBeenCalledTimes(1)
    expect(onUninstall).toHaveBeenCalledWith(alpha)
  })

  it('卸载中：对应卡菜单项禁用 + 「卸载中」，点击不触发；其他卡不受影响', async () => {
    const user = userEvent.setup()
    const onUninstall = vi.fn()
    render(<InstanceCards {...baseProps({ uninstallingId: 'alpha', onUninstall })} />)

    // 卡片面承接在途信号（卸载反馈原挂在行内按钮上，收进菜单后靠触发器 spinner）
    expect(screen.getByRole('button', { name: '虚构甲服 操作菜单' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '虚构乙服 操作菜单' })).not.toHaveAttribute('aria-busy', 'true')

    await openMenu(user, '虚构甲服')
    // 卸载中：文案切换为「卸载中」（可访问名随内容变化）
    const uninstallAlpha = await screen.findByRole('menuitem', { name: '卸载中' })
    // radix DropdownMenuItem 的 disabled 是 aria-disabled（div 非原生 button）
    expect(uninstallAlpha).toHaveAttribute('aria-disabled', 'true')
    await user.click(uninstallAlpha)
    expect(onUninstall).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')

    // beta 菜单项仍可用
    await openMenu(user, '虚构乙服')
    const uninstallBeta = await screen.findByRole('menuitem', { name: '卸载实例' })
    expect(uninstallBeta).not.toHaveAttribute('aria-disabled', 'true')
    expect(uninstallBeta).toHaveTextContent('卸载实例')
    await user.click(uninstallBeta)
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
