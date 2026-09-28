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
  seq = 0 // makeItem 编号基线：每用例从「通知内容 1」重新计数
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
  it('35 个通知类型全部归入预期档位，中性档不占语义六色', () => {
    const expected: Record<string, string[]> = {
      success: [
        'join',
        'revive',
        'serverStart',
        'backupComplete',
        'restoreComplete',
        'deployComplete',
        'upgradeComplete',
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
      ],
      warning: ['lowTps', 'highCpu', 'highMemory', 'highDisk', 'backupSkipped'],
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
    expect(Object.keys(NOTIFICATION_TONE)).toHaveLength(35)
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
