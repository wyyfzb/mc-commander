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

describe('notifications store instanceId 透传（issue 334）', () => {
  beforeEach(() => {
    useNotificationStore.setState({ items: [], unreadCount: 0, activeAlerts: new Set() })
    useNotificationPreferenceStore.setState({ prefs: {} })
  })

  it('server 类事件携带 instanceId → 通知条目透传（供跳转实例页）', () => {
    useNotificationStore.getState().dispatchWsEvent({
      type: 'status',
      data: { event: 'crash', autoRestart: false },
      instanceId: 'inst-1',
    })

    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('serverCrash')
    expect(items[0]?.instanceId).toBe('inst-1')
  })

  it('无 instanceId 的事件不写该字段', () => {
    useNotificationStore.getState().dispatchWsEvent({
      type: 'playerJoin',
      data: { name: 'Alex' },
    })

    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.instanceId).toBeUndefined()
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

describe('notifications store 生命周期（已读/全读/清空）', () => {
  /** 两条不同类型事件 → 两条未读条目（chat/join 类型不同不互聚） */
  function seedTwoUnread() {
    useNotificationStore.getState().dispatchWsEvent({ type: 'playerJoin', data: { name: 'Alex' } })
    useNotificationStore.getState().dispatchWsEvent({ type: 'playerChat', data: { name: 'Alex', message: 'hi' } })
  }

  it('markAsRead：单条已读 + 未读计数重算 + 持久化', () => {
    seedTwoUnread()
    expect(useNotificationStore.getState().unreadCount).toBe(2)

    const target = useNotificationStore.getState().items[1]!
    useNotificationStore.getState().markAsRead(target.id)

    const after = useNotificationStore.getState()
    expect(after.items[1]?.read).toBe(true)
    expect(after.items[0]?.read).toBe(false)
    expect(after.unreadCount).toBe(1)
    const persisted = JSON.parse(localStorage.getItem('mcs-notifications')!) as AppNotification[]
    expect(persisted.find((n) => n.id === target.id)?.read).toBe(true)
  })

  it('markAllRead：全部已读 + 未读清零 + 持久化', () => {
    seedTwoUnread()
    useNotificationStore.getState().markAllRead()

    const after = useNotificationStore.getState()
    expect(after.items).toHaveLength(2)
    expect(after.items.every((n) => n.read)).toBe(true)
    expect(after.unreadCount).toBe(0)
    const persisted = JSON.parse(localStorage.getItem('mcs-notifications')!) as AppNotification[]
    expect(persisted.every((n) => n.read)).toBe(true)
  })

  it('clearAll：清空条目/未读/告警状态 + 持久化为空', () => {
    seedTwoUnread()
    useNotificationStore.getState().dispatchPerformance({ tps: 10 })
    expect(useNotificationStore.getState().activeAlerts.size).toBe(1)

    useNotificationStore.getState().clearAll()

    const after = useNotificationStore.getState()
    expect(after.items).toEqual([])
    expect(after.unreadCount).toBe(0)
    expect(after.activeAlerts.size).toBe(0)
    expect(localStorage.getItem('mcs-notifications')).toBe('[]')
  })

  it('clearAll 清空聚合缓存：旧告警清除后再次越阈重新通知', () => {
    useNotificationStore.getState().dispatchPerformance({ tps: 10 })
    useNotificationStore.getState().clearAll()

    useNotificationStore.getState().dispatchPerformance({ tps: 9 })
    const after = useNotificationStore.getState()
    expect(after.items).toHaveLength(1)
    expect(after.items[0]?.type).toBe('lowTps')
    expect(after.activeAlerts.has('lowTps')).toBe(true)
  })
})

describe('notifications store 告警状态机（dispatchPerformance）', () => {
  it('TPS 低于阈值 → 生成 lowTps 告警并激活状态 + 持久化', () => {
    useNotificationStore.getState().dispatchPerformance({ tps: 12.5 })

    const s = useNotificationStore.getState()
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ type: 'lowTps', content: 'TPS 过低: 12.5', count: 1, read: false })
    expect(s.activeAlerts.has('lowTps')).toBe(true)
    expect(s.unreadCount).toBe(1)
    expect(JSON.parse(localStorage.getItem('mcs-notifications')!)).toHaveLength(1)
  })

  it('持续低 TPS → 跃迁单次：不重复生成通知', () => {
    useNotificationStore.getState().dispatchPerformance({ tps: 12 })
    useNotificationStore.getState().dispatchPerformance({ tps: 10 })

    expect(useNotificationStore.getState().items).toHaveLength(1)
  })

  it('TPS 恢复 → 告警状态清除（恢复通知与告警 30s 窗口内同实体聚合 count+1）', () => {
    useNotificationStore.getState().dispatchPerformance({ tps: 12 })
    useNotificationStore.getState().dispatchPerformance({ tps: 20 })

    const s = useNotificationStore.getState()
    expect(s.activeAlerts.size).toBe(0)
    expect(s.items).toHaveLength(1)
    expect(s.items[0]?.count).toBe(2)
  })

  it('CPU 越阈值 → highCpu；回落 → 状态清除', () => {
    useNotificationStore.getState().dispatchPerformance({ cpu: 91.5 })
    let s = useNotificationStore.getState()
    expect(s.items[0]).toMatchObject({ type: 'highCpu', content: 'CPU 使用率过高: 91.5%（单核口径）' })
    expect(s.activeAlerts.has('highCpu')).toBe(true)

    useNotificationStore.getState().dispatchPerformance({ cpu: 50 })
    s = useNotificationStore.getState()
    expect(s.activeAlerts.size).toBe(0)
    expect(s.items).toHaveLength(1)
  })

  it('内存越阈值 → highMemory', () => {
    useNotificationStore.getState().dispatchPerformance({ memoryPercent: 85.5 })

    const s = useNotificationStore.getState()
    expect(s.items[0]).toMatchObject({ type: 'highMemory', content: '内存使用率过高: 85.5%' })
    expect(s.activeAlerts.has('highMemory')).toBe(true)
  })

  it('指标缺省（全 null）→ 无通知无状态迁移', () => {
    useNotificationStore.getState().dispatchPerformance({})

    const s = useNotificationStore.getState()
    expect(s.items).toHaveLength(0)
    expect(s.activeAlerts.size).toBe(0)
    expect(s.unreadCount).toBe(0)
  })

  it('偏好关闭告警类型：状态机照常推进但不生成条目（过滤后空集早退）', () => {
    useNotificationPreferenceStore.getState().setEnabled('lowTps', false)

    useNotificationStore.getState().dispatchPerformance({ tps: 10 })
    let s = useNotificationStore.getState()
    expect(s.items).toHaveLength(0)
    expect(s.activeAlerts.has('lowTps')).toBe(true)

    useNotificationStore.getState().dispatchPerformance({ tps: 20 })
    s = useNotificationStore.getState()
    expect(s.items).toHaveLength(0)
    expect(s.activeAlerts.size).toBe(0)
  })
})

describe('notifications store 初始化恢复与持久化容错（模块重载逐态验证）', () => {
  // readInitial 仅在模块导入（store 创建期）执行一次，
  // 恢复分支须 vi.resetModules() 重建模块后逐态注入 localStorage 验证
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('合法持久化数组 → 恢复条目并按 200 上限截断', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: `n-${i}`,
      type: 'join',
      category: 'game',
      content: `c-${i}`,
      timestamp: 1_700_000_000_000 + i,
      count: 1,
      read: false,
    }))
    localStorage.setItem('mcs-notifications', JSON.stringify(items))

    const mod = await import('../notifications')
    const restored = mod.useNotificationStore.getState().items
    expect(restored).toHaveLength(200)
    expect(restored[0]?.id).toBe('n-0')
  })

  it('损坏 JSON → 回退空数组（不阻塞启动）', async () => {
    localStorage.setItem('mcs-notifications', '{broken')

    const mod = await import('../notifications')
    expect(mod.useNotificationStore.getState().items).toEqual([])
  })

  it('非数组 JSON → 回退空数组（防御非法结构）', async () => {
    localStorage.setItem('mcs-notifications', '{"legacy":true}')

    const mod = await import('../notifications')
    expect(mod.useNotificationStore.getState().items).toEqual([])
  })

  it('持久化失败（配额超限）→ 内存态照常更新且不抛错', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(() =>
      useNotificationStore.getState().dispatchWsEvent({ type: 'playerJoin', data: { name: 'Alex' } }),
    ).not.toThrow()
    expect(useNotificationStore.getState().items).toHaveLength(1)
    spy.mockRestore()
  })
})
