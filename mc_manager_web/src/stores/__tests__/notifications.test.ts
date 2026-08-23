/**
 * notifications store 单测：偏好过滤接入
 * 类型开关关闭的 WS 事件不生成通知
 * 5 分钟周期裁剪到 100 条（内存）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFICATION_CLEANUP_INTERVAL_MS,
  runNotificationCleanup,
  startNotificationCleanupTimer,
  useNotificationStore,
} from '../notifications'
import { useNotificationPreferenceStore } from '../notification-preferences'
import type { AppNotification } from '@/lib/notifications'

beforeEach(() => {
  localStorage.clear()
  useNotificationStore.setState({ items: [], unreadCount: 0, activeAlerts: new Set() })
  useNotificationPreferenceStore.setState({ prefs: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('notifications store 偏好过滤', () => {
  it('默认（偏好全开）：playerJoin 事件生成通知', () => {
    useNotificationStore.getState().dispatchWsEvent({
      type: 'playerJoin',
      data: { name: 'Alex' },
    })

    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('join')
    expect(items[0]?.content).toBe('Alex 加入了游戏')
  })

  it('类型开关关闭：事件不生成通知', () => {
    useNotificationPreferenceStore.getState().setEnabled('join', false)

    useNotificationStore.getState().dispatchWsEvent({
      type: 'playerJoin',
      data: { name: 'Alex' },
    })

    expect(useNotificationStore.getState().items).toHaveLength(0)
  })

  it('其他类型开关不受影响（关闭 join 后 chat 正常生成）', () => {
    useNotificationPreferenceStore.getState().setEnabled('join', false)

    useNotificationStore.getState().dispatchWsEvent({
      type: 'playerChat',
      data: { name: 'Alex', message: 'hi' },
    })

    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('chat')
  })

  it('备份类通知也走过滤（server 类）', () => {
    useNotificationPreferenceStore.getState().setEnabled('backupComplete', false)

    useNotificationStore.getState().dispatchWsEvent({
      type: 'backupComplete',
      data: { id: 1 },
    })

    expect(useNotificationStore.getState().items).toHaveLength(0)
  })
})

describe('notifications store 定时清理', () => {
  /** 构造 N 条占位通知（最新在前；id=0 最新），read 按 i%2 交替 */
  function seedItems(count: number) {
    const items: AppNotification[] = Array.from({ length: count }, (_, i) => ({
      id: String(i),
      type: 'join',
      category: 'game',
      content: `测试玩家${i}`,
      timestamp: 1_700_000_000_000 - i,
      count: 1,
      read: i % 2 === 0,
    }))
    useNotificationStore.setState({
      items,
      unreadCount: items.filter((n) => !n.read).length,
    })
  }

  it('超过 100 条：裁剪至最近 100 条，未读计数按剩余重算', () => {
    seedItems(120)
    expect(useNotificationStore.getState().items).toHaveLength(120)

    runNotificationCleanup()

    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(100)
    // 保留最新（id=0 最新在前）
    expect(items[0]?.id).toBe('0')
    expect(items[99]?.id).toBe('99')
    // 未读语义不篡改：剩余条目 read 状态原样，未读计数 = 剩余未读数
    expect(useNotificationStore.getState().unreadCount).toBe(50)
    // 不写 localStorage（仅内存裁剪）
    expect(localStorage.getItem('mcs-notifications')).toBeNull()
  })

  it('不超过 100 条：不裁剪', () => {
    seedItems(80)
    runNotificationCleanup()
    expect(useNotificationStore.getState().items).toHaveLength(80)
  })

  it('5 分钟周期触发裁剪', () => {
    vi.useFakeTimers()
    startNotificationCleanupTimer()
    seedItems(150)

    vi.advanceTimersByTime(NOTIFICATION_CLEANUP_INTERVAL_MS - 1)
    expect(useNotificationStore.getState().items).toHaveLength(150)

    vi.advanceTimersByTime(1)
    expect(useNotificationStore.getState().items).toHaveLength(100)
  })
})
