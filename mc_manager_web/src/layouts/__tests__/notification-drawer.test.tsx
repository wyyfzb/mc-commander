/**
 * NotificationDrawer 通知条目跳转测试（issue 334）
 * - 带 instanceId 的条目：点击 → 标记已读 + 关抽屉 + navigate /instances?focus=<id>
 * - 无 instanceId 的条目：点击仅标记已读（原行为）
 * - circuitBreaker 类型渲染（severe 样式 + 图标）
 * 测试数据均为虚构（inst-1/虚构实例），无真实凭据
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useNotificationStore } from '@/stores/notifications'
import { useWorldUpgradeProgressStore } from '@/stores/world-upgrade-progress'
import type { AppNotification } from '@/lib/notifications'
import { useUiStore } from '@/stores/ui'
import { NotificationDrawer, NOTIFICATION_TONE } from '../notification-drawer'

const navigateMock = vi.fn()
vi.mock('react-router', () => ({
  useNavigate: () => navigateMock,
}))

function seedStore() {
  useNotificationStore.setState({
    items: [
      {
        id: 'n-1',
        type: 'serverCrash',
        category: 'server',
        content: '服务器意外退出',
        timestamp: Date.now(),
        count: 1,
        read: false,
        instanceId: 'inst-1',
      },
      {
        id: 'n-2',
        type: 'join',
        category: 'game',
        content: 'Steve 加入了游戏',
        timestamp: Date.now() - 1000,
        count: 1,
        read: false,
      },
    ],
    unreadCount: 2,
    activeAlerts: new Set(),
  })
}

function renderDrawer() {
  const onOpenChange = vi.fn()
  render(<NotificationDrawer open onOpenChange={onOpenChange} />)
  return { onOpenChange }
}

beforeEach(() => {
  navigateMock.mockClear()
  seedStore()
  useUiStore.setState({ notificationsOpen: true })
  useWorldUpgradeProgressStore.setState({ progress: {} })
  seq = 0 // makeItem 编号基线：每用例从「通知内容 1」重新计数
})

describe('NotificationDrawer 世界格式升级进度（就地更新的进度条）', () => {
  /** 只放一条「升级开始」，并给该实例一个可选的就地进度 */
  function seedUpgrade(percent?: number) {
    useNotificationStore.setState({
      items: [
        {
          id: 'n-up',
          type: 'worldUpgradeStart',
          category: 'server',
          content: '服务器正在升级世界存档格式，期间可能无法连接',
          timestamp: Date.now(),
          count: 1,
          read: false,
          instanceId: 'inst-1',
        },
      ],
      unreadCount: 1,
      activeAlerts: new Set(),
    })
    useWorldUpgradeProgressStore.setState({
      progress: percent === undefined ? {} : { 'inst-1': percent },
    })
  }

  it('有进度时在「升级开始」那条上就地渲染进度条与百分比', () => {
    seedUpgrade(42)
    renderDrawer()

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText('42%')).toBeInTheDocument()
    // 就地：挂在升级那条上，而不是别处
    const entry = screen.getByText('服务器正在升级世界存档格式，期间可能无法连接').closest('button')
    expect(entry).not.toBeNull()
    expect(entry).toContainElement(bar)
  })

  it('只有开始事件、进度尚未到达时不渲染进度条（不摆一个恒空的条）', () => {
    seedUpgrade(undefined)
    renderDrawer()

    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('进度不挂到别的条目上：载体是**独立的**进行中行，而不是 serverCrash 那条', () => {
    seedStore() // serverCrash（同样带 inst-1）
    useWorldUpgradeProgressStore.setState({ progress: { 'inst-1': 42 } })
    renderDrawer()

    // 载体由状态决定（见通知抽屉的 InFlightUpgradeRows）：有实时进度就有自己的行
    const live = screen.getByRole('button', { name: /升级进度 42%/ })
    expect(live).toHaveTextContent('服务器正在升级世界存档格式')
    // 同实例的崩溃条目仍不长进度条——进度不寄生在无关条目上
    expect(screen.getByRole('button', { name: /服务器意外退出/ })).not.toHaveTextContent('42%')
  })

  it('「清除全部」后进行中行仍在：进度不因通知被删而消失', () => {
    seedUpgrade(42)
    useNotificationStore.setState({ items: [], unreadCount: 0 }) // 用户点了清除全部
    renderDrawer()

    const live = screen.getByRole('button', { name: /升级进度 42%/ })
    expect(live).toBeInTheDocument()
    // 不编造开始时间：那条边沿本来就没发生在我们眼前，写一个 HH:MM 就是篡改事实
    expect(live).not.toHaveTextContent(/\d{1,2}:\d{2}/)
  })

  it('已有可见的「升级开始」行时不重复渲染进行中行', () => {
    seedUpgrade(42)
    renderDrawer()

    // 同一条升级只该有一行：既有通知行（带时间）承担显示，不再叠加一个 live 行
    expect(screen.getAllByRole('button', { name: /升级进度 42%/ })).toHaveLength(1)
    expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  })

  it('百分比取整显示（服务端给小数时不出现 42.5%）', () => {
    seedUpgrade(42.5)
    renderDrawer()

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43')
    expect(screen.getByText('43%')).toBeInTheDocument()
  })

  it('进度值进得了无障碍树：拼进该条目的 aria-label', () => {
    // 条目整体是 <button> ⇒ 子节点在无障碍树里一律 presentational，DOM 上的
    // role="progressbar" 读不到；故数值必须进 aria-label。这条按**可访问名**查，
    // 改回只挂 DOM 属性就会转红。
    seedUpgrade(42)
    renderDrawer()

    const entry = screen.getByRole('button', { name: /升级进度 42%/ })
    expect(entry).toHaveTextContent('服务器正在升级世界存档格式')
  })

  it('没有进度时 aria-label 里不出现进度（不凭空播报一个不存在的值）', () => {
    seedUpgrade(undefined)
    renderDrawer()

    expect(screen.queryByRole('button', { name: /升级进度/ })).toBeNull()
  })
})

describe('NotificationDrawer 条目跳转（issue 334）', () => {
  it('带 instanceId 条目：点击 → 已读 + 关抽屉 + focus 深链接跳转', () => {
    const { onOpenChange } = renderDrawer()

    const entry = screen.getByText('服务器意外退出').closest('button')
    expect(entry).not.toBeNull()
    fireEvent.click(entry!)

    expect(useNotificationStore.getState().items.find((n) => n.id === 'n-1')?.read).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(navigateMock).toHaveBeenCalledWith('/instances?focus=inst-1')
  })

  it('无 instanceId 条目：点击仅标记已读，不跳转', () => {
    const { onOpenChange } = renderDrawer()

    const entry = screen.getByText('Steve 加入了游戏').closest('button')
    expect(entry).not.toBeNull()
    fireEvent.click(entry!)

    expect(useNotificationStore.getState().items.find((n) => n.id === 'n-2')?.read).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('带 instanceId 条目展示跳转提示（查看实例），色相点在独立左列而非 info 文字行', () => {
    renderDrawer()
    const hint = screen.getByText('查看实例')
    expect(hint).toBeInTheDocument()
    const entry = hint.closest('button')
    expect(entry).not.toBeNull()
    const dot = entry?.querySelector('[data-instance-hue]')
    expect(dot).not.toBeNull()
    // 字面量断言（不调 instanceHueFillClass 自证）：inst-1 → slot 5；改哈希或改映射都会让本用例变红
    expect(dot).toHaveClass('bg-mcs-identity-5')
    // 左列整列是装饰（色点 + 它的定位壳），都不进无障碍树
    expect(dot?.parentElement).toHaveAttribute('aria-hidden')
    // 关键结构：色点不得落在「查看实例」那行内——该行整体是 info 语义色，
    // 色点嵌在里面（同为圆点、2px 间距）会被读成 info 语义点（审查 F-M2）
    const infoRow = hint.parentElement
    expect(infoRow?.querySelector('[data-instance-hue]')).toBeNull()
    expect(dot?.closest('button')).toBe(entry)
  })

  it('无 instanceId 条目不渲染实例色相点（不与 game 条目混色）', () => {
    renderDrawer()
    const entry = screen.getByText('Steve 加入了游戏').closest('button')
    expect(entry?.querySelector('[data-instance-hue]')).toBeNull()
  })
})

// ─── 以下为组件打磨批（issue 344）补充：severity 筛选 + 清除全部确认 ───

let seq = 0
function makeItem(
  partial: Pick<AppNotification, 'type' | 'category'> & Partial<AppNotification>,
): AppNotification {
  seq += 1
  return {
    id: `n${seq}`,
    content: `通知内容 ${seq}`,
    timestamp: 1756900000000 + seq,
    count: 1,
    read: false,
    ...partial,
  }
}

describe('NotificationDrawer severity 筛选（issue 344）', () => {
  it('无通知：显示空态且不渲染筛选 chips', () => {
    useNotificationStore.setState({ items: [], unreadCount: 0, activeAlerts: new Set() })
    renderDrawer()
    expect(screen.getByText('暂无动态')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: '按严重度筛选' })).not.toBeInTheDocument()
  })

  it('有通知：渲染 4 个筛选 chip，默认「全部」展示全部条目', () => {
    useNotificationStore.setState({
      items: [
        makeItem({ type: 'serverCrash', category: 'server' }),
        makeItem({ type: 'highCpu', category: 'server' }),
        makeItem({ type: 'join', category: 'game' }),
      ],
      unreadCount: 3,
    })
    renderDrawer()
    const group = screen.getByRole('radiogroup', { name: '按严重度筛选' })
    expect(within(group).getByRole('radio', { name: '全部通知' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    for (const label of ['严重通知', '警告通知', '提示通知']) {
      expect(within(group).getByRole('radio', { name: label })).toHaveAttribute(
        'aria-checked',
        'false',
      )
    }
    expect(screen.getByText('通知内容 1')).toBeInTheDocument()
    expect(screen.getByText('通知内容 2')).toBeInTheDocument()
    expect(screen.getByText('通知内容 3')).toBeInTheDocument()
  })

  it('点「严重」chip：列表只剩 severe 类型（崩溃/熔断等）', async () => {
    const user = userEvent.setup()
    useNotificationStore.setState({
      items: [
        makeItem({ type: 'serverCrash', category: 'server' }),
        makeItem({ type: 'highCpu', category: 'server' }),
        makeItem({ type: 'join', category: 'game' }),
      ],
      unreadCount: 3,
    })
    renderDrawer()
    await user.click(screen.getByRole('radio', { name: '严重通知' }))
    expect(screen.getByText('通知内容 1')).toBeInTheDocument()
    expect(screen.queryByText('通知内容 2')).not.toBeInTheDocument()
    expect(screen.queryByText('通知内容 3')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '严重通知' })).toHaveAttribute('aria-checked', 'true')
  })

  it('筛选无结果：显示「该严重度下暂无通知」而非「暂无动态」', async () => {
    const user = userEvent.setup()
    useNotificationStore.setState({
      items: [makeItem({ type: 'join', category: 'game' })],
      unreadCount: 1,
    })
    renderDrawer()
    await user.click(screen.getByRole('radio', { name: '严重通知' }))
    expect(screen.getByText('该严重度下暂无通知')).toBeInTheDocument()
    expect(screen.queryByText('暂无动态')).not.toBeInTheDocument()
  })
})

describe('NotificationDrawer 清除全部确认（issue 344）', () => {
  it('点「清除全部」先弹确认，未确认前不清空', async () => {
    const user = userEvent.setup()
    useNotificationStore.setState({
      items: [makeItem({ type: 'join', category: 'game' })],
      unreadCount: 1,
    })
    renderDrawer()
    await user.click(screen.getByRole('button', { name: '清除全部' }))
    expect(screen.getByRole('dialog', { name: '清除全部通知' })).toBeInTheDocument()
    // 未点确认：store 未清空
    expect(useNotificationStore.getState().items).toHaveLength(1)
  })

  it('确认后清空 store 并关闭弹窗', async () => {
    const user = userEvent.setup()
    useNotificationStore.setState({
      items: [
        makeItem({ type: 'join', category: 'game' }),
        makeItem({ type: 'serverCrash', category: 'server' }),
      ],
      unreadCount: 2,
    })
    renderDrawer()
    await user.click(screen.getByRole('button', { name: '清除全部' }))
    await user.click(screen.getByRole('button', { name: '清除' }))
    expect(useNotificationStore.getState().items).toHaveLength(0)
    expect(useNotificationStore.getState().unreadCount).toBe(0)
    expect(screen.queryByRole('dialog', { name: '清除全部通知' })).not.toBeInTheDocument()
  })

  it('取消不清空', async () => {
    const user = userEvent.setup()
    useNotificationStore.setState({
      items: [makeItem({ type: 'join', category: 'game' })],
      unreadCount: 1,
    })
    renderDrawer()
    await user.click(screen.getByRole('button', { name: '清除全部' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(useNotificationStore.getState().items).toHaveLength(1)
  })
})
// ─── J5：气泡着色取自 components/mcs/tone（防止再退回「各文件手抄一份色值」） ───

describe('NotificationDrawer 语义色来源', () => {
  it('未读 game 条：底 / 描边 / 图标三处同档，中性事件不占语义六色', () => {
    useNotificationStore.setState({
      items: [
        makeItem({ type: 'join', category: 'game', content: '甲玩家加入了游戏' }),
        makeItem({ type: 'leave', category: 'game', content: '乙玩家离开了游戏' }),
      ],
      unreadCount: 2,
    })
    renderDrawer()

    const joinBtn = screen.getByText('甲玩家加入了游戏').closest('button')
    expect(joinBtn).not.toBeNull()
    expect(joinBtn!.className).toContain('bg-mcs-success-bg-subtle')
    expect(joinBtn!.className).toContain('border-mcs-success-border')
    expect(joinBtn!.querySelector('svg')?.getAttribute('class')).toContain('text-mcs-success-fg')

    // 离开无成败含义 → 中性档（次级底 + 默认描边 + 弱前景）
    const leaveBtn = screen.getByText('乙玩家离开了游戏').closest('button')
    expect(leaveBtn).not.toBeNull()
    expect(leaveBtn!.className).toContain('bg-mcs-bg-secondary')
    expect(leaveBtn!.className).toContain('border-mcs-border-default')
    expect(leaveBtn!.querySelector('svg')?.getAttribute('class')).toContain('text-mcs-text-muted')
  })
})

// ─── J5：类型 → 语义档的完整映射（改错档位必须变红） ───

describe('NOTIFICATION_TONE 类型 → 语义档', () => {
  it('38 个通知类型全部归入预期档位，中性档不占语义六色', () => {
    const expected: Record<string, string[]> = {
      success: [
        'join',
        'revive',
        'serverStart',
        'backupComplete',
        'restoreComplete',
        'deployComplete',
        'upgradeComplete',
        'worldUpgradeComplete',
      ],
      error: [
        'death',
        'serverCrash',
        'circuitBreaker',
        'backupFailed',
        'restoreFailed',
        'taskFailed',
        'webhookFailed',
        'deployFailed',
        'upgradeFailed',
        'criticalDisk',
        'worldUpgradeFailed',
      ],
      warning: [
        'lowTps',
        'highCpu',
        'highMemory',
        'highDisk',
        'backupSkipped',
        'worldUpgradeStart',
      ],
      info: ['chat', 'sleep', 'save', 'weatherChange', 'backupStart', 'restoreStart'],
      purple: ['achievement'],
      neutral: [
        'leave',
        'serverStop',
        'backupCancelled',
        'restoreCancelled',
        'deployCancelled',
        'upgradeCancelled',
      ],
    }
    for (const [tone, types] of Object.entries(expected)) {
      const actual = Object.entries(NOTIFICATION_TONE)
        .filter(([, t]) => t === tone)
        .map(([type]) => type)
        .sort()
      expect(actual, `档位 ${tone}`).toEqual([...types].sort())
    }
    // 全量覆盖：不多不少（新增通知类型忘了归档会被这条拦下）
    expect(Object.keys(NOTIFICATION_TONE)).toHaveLength(38)
  })

  describe('NotificationDrawer 严重度单选组键盘模型', () => {
    it('方向键在严重度筛选内移动即选中且焦点跟随', () => {
      useNotificationStore.setState({
        items: [makeItem({ type: 'serverCrash', category: 'server' })],
        unreadCount: 1,
      })
      renderDrawer()
      const group = screen.getByRole('radiogroup', { name: '按严重度筛选' })
      const chips = within(group).getAllByRole('radio')
      expect(chips[0]).toHaveAttribute('aria-checked', 'true') // 默认「全部」

      fireEvent.keyDown(group, { key: 'ArrowRight' })
      expect(chips[1]).toHaveAttribute('aria-checked', 'true')
      expect(chips[0]).toHaveAttribute('aria-checked', 'false')
      expect(document.activeElement).toBe(chips[1])
    })
  })
})
