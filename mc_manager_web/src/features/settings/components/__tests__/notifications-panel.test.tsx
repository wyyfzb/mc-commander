/**
 * NotificationsPanel 测试（通知设置子页）：
 * 两组渲染/行数与类型顺序/默认全开/单行切换落 store 并持久化/组级批量开关/持久化后重载回显
 * mock 数据为虚构占位（类型 label 来自公开领域数据，无真实服务器/玩家信息）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotificationsPanel } from '../notifications-panel'
import {
  NOTIFICATION_TYPE_META,
  NOTIFICATION_TYPE_ORDER,
  type NotificationCategory,
  type NotificationType,
} from '@/lib/notifications'
import { useNotificationPreferenceStore } from '@/stores/notification-preferences'

const STORAGE_KEY = 'mcs-notification-preferences'

/** 按分类取类型（保持 NOTIFICATION_TYPE_ORDER 声明序） */
function typesOf(category: NotificationCategory): NotificationType[] {
  return NOTIFICATION_TYPE_ORDER.filter((t) => NOTIFICATION_TYPE_META[t].category === category)
}

beforeEach(() => {
  localStorage.clear()
  useNotificationPreferenceStore.setState({ prefs: {} })
})

describe('NotificationsPanel', () => {
  it('渲染顶部描述 + 实时保存提示 + 两组卡片（游戏通知/服务器通知）', () => {
    render(<NotificationsPanel />)
    expect(screen.getByText('设置各类通知的站内推送（严重度仅作展示分级）。')).toBeInTheDocument()
    expect(screen.getByText('修改即时保存')).toBeInTheDocument()
    expect(screen.getByTestId('notification-group-game')).toBeInTheDocument()
    expect(screen.getByTestId('notification-group-server')).toBeInTheDocument()
    // Web 类型体系无 management 组，不渲染
    expect(screen.getAllByTestId(/^notification-group-/)).toHaveLength(2)
    expect(screen.queryByTestId('notification-group-management')).not.toBeInTheDocument()
  })

  it('组内行数与类型顺序与 NOTIFICATION_TYPE_ORDER 一致（game 7 行 / server 15 行）', () => {
    render(<NotificationsPanel />)
    const gameTypes = typesOf('game')
    const serverTypes = typesOf('server')
    expect(gameTypes.length).toBe(7)
    expect(serverTypes.length).toBe(15)

    const gameGroup = screen.getByTestId('notification-group-game')
    const serverGroup = screen.getByTestId('notification-group-server')
    // 组内第一个 switch 为组级批量开关，其余按顺序为类型行开关
    const gameRowNames = within(gameGroup)
      .getAllByRole('switch')
      .slice(1)
      .map((s) => s.getAttribute('aria-label'))
    expect(gameRowNames).toEqual(gameTypes.map((t) => `${NOTIFICATION_TYPE_META[t].label} 开关`))
    const serverRowNames = within(serverGroup)
      .getAllByRole('switch')
      .slice(1)
      .map((s) => s.getAttribute('aria-label'))
    expect(serverRowNames).toEqual(serverTypes.map((t) => `${NOTIFICATION_TYPE_META[t].label} 开关`))
    // 组内行数 = 类型数 + 1 个组级开关
    expect(within(gameGroup).getAllByRole('switch')).toHaveLength(gameTypes.length + 1)
    expect(within(serverGroup).getAllByRole('switch')).toHaveLength(serverTypes.length + 1)
  })

  it('默认全开：全部行开关与组级开关均为 checked', () => {
    render(<NotificationsPanel />)
    const switches = screen.getAllByRole('switch')
    expect(switches.length).toBe(NOTIFICATION_TYPE_ORDER.length + 2)
    for (const s of switches) {
      expect(s).toHaveAttribute('data-state', 'checked')
    }
  })

  it('单行切换：关闭「聊天」落 store 并持久化，组级开关保持 checked（半开态显示开，P4 配置可预期）', async () => {
    const user = userEvent.setup()
    render(<NotificationsPanel />)
    await user.click(screen.getByRole('switch', { name: '聊天 开关' }))

    // store 状态：chat 关闭、其他不受影响
    expect(useNotificationPreferenceStore.getState().isEnabled('chat')).toBe(false)
    expect(useNotificationPreferenceStore.getState().isEnabled('join')).toBe(true)
    // UI 回显
    expect(screen.getByRole('switch', { name: '聊天 开关' })).toHaveAttribute('data-state', 'unchecked')
    // 持久化：仅写非默认（false）项
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, { toast: boolean }>
    expect(raw.chat?.toast).toBe(false)
    expect(raw.join).toBeUndefined()
    // 组级 checked 语义：至少一项开启 → checked，并带半开提示
    const gameGroupSwitch = screen.getByRole('switch', { name: '游戏通知 开关' })
    expect(gameGroupSwitch).toHaveAttribute('data-state', 'checked')
    expect(gameGroupSwitch).toHaveAttribute('title', '组内部分类型已关闭，点击将全部开启')
    expect(screen.getByRole('switch', { name: '服务器通知 开关' })).toHaveAttribute('data-state', 'checked')
  })

  it('组级批量开关：关闭「游戏通知」→ 组内全部关闭，server 组不受影响', async () => {
    const user = userEvent.setup()
    render(<NotificationsPanel />)
    await user.click(screen.getByRole('switch', { name: '游戏通知 开关' }))

    const store = useNotificationPreferenceStore.getState()
    for (const t of typesOf('game')) expect(store.isEnabled(t)).toBe(false)
    for (const t of typesOf('server')) expect(store.isEnabled(t)).toBe(true)
    // UI 回显：组内行开关全部关闭，server 组保持全开
    const gameGroup = screen.getByTestId('notification-group-game')
    for (const s of within(gameGroup).getAllByRole('switch').slice(1)) {
      expect(s).toHaveAttribute('data-state', 'unchecked')
    }
    expect(screen.getByRole('switch', { name: '服务器通知 开关' })).toHaveAttribute('data-state', 'checked')
  })

  it('组级批量开关：半开态点击 → 全部关闭；再点击 → 全部开启', async () => {
    const user = userEvent.setup()
    render(<NotificationsPanel />)
    // 先关一行 → 组级保持 checked（半开态）
    await user.click(screen.getByRole('switch', { name: '死亡 开关' }))
    expect(screen.getByRole('switch', { name: '游戏通知 开关' })).toHaveAttribute('data-state', 'checked')
    // 组级点击 → 全部关闭（标准 header checkbox 语义）
    await user.click(screen.getByRole('switch', { name: '游戏通知 开关' }))
    for (const t of typesOf('game')) {
      expect(useNotificationPreferenceStore.getState().isEnabled(t)).toBe(false)
    }
    expect(screen.getByRole('switch', { name: '游戏通知 开关' })).toHaveAttribute('data-state', 'unchecked')
    // 再点击 → 全部开启
    await user.click(screen.getByRole('switch', { name: '游戏通知 开关' }))
    for (const t of typesOf('game')) {
      expect(useNotificationPreferenceStore.getState().isEnabled(t)).toBe(true)
    }
    expect(screen.getByRole('switch', { name: '游戏通知 开关' })).toHaveAttribute('data-state', 'checked')
  })

  it('持久化后重载回显：localStorage 注入 → 关闭项回显关闭，其余默认开', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chat: { toast: false } }))
    // 模拟新会话：store 以持久化数据重建（等价于模块加载时 readStored）
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    useNotificationPreferenceStore.setState({ prefs: stored })

    render(<NotificationsPanel />)
    expect(screen.getByRole('switch', { name: '聊天 开关' })).toHaveAttribute('data-state', 'unchecked')
    expect(screen.getByRole('switch', { name: '进入 开关' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('switch', { name: '启动 开关' })).toHaveAttribute('data-state', 'checked')
    // 部分关闭 → 组级保持 checked（半开态显示开），server 组全开 → checked
    expect(screen.getByRole('switch', { name: '游戏通知 开关' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('switch', { name: '服务器通知 开关' })).toHaveAttribute('data-state', 'checked')
  })
})
