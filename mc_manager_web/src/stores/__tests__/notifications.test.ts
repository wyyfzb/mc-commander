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
  startNotificationStorageSync,
  useNotificationStore,
} from '../notifications'
import { useNotificationPreferenceStore } from '../notification-preferences'
import type { AppNotification } from '@/lib/notifications'

const STORAGE_KEY = 'mcs-notifications'

/** 持久化载荷（条目 + 清空时刻）：断言走它，避免逐处重复解构 */
function persistedPayload(): { items: AppNotification[]; clearedAt: number } {
  return JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
    items: AppNotification[]
    clearedAt: number
  }
}

function persistedItems(): AppNotification[] {
  return persistedPayload().items
}

/** 构造一条外部（另一标签/预置）条目 */
function foreignItem(over: Partial<AppNotification> & { id: string }): AppNotification {
  return {
    type: 'join',
    category: 'game',
    content: '另一标签的条目',
    timestamp: Date.now(),
    count: 1,
    read: false,
    ...over,
  }
}

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
  })

  it('裁剪落盘同步收缩，且下一次写回不会把裁掉的条目并回内存', () => {
    seedItems(120)
    runNotificationCleanup()
    expect(persistedItems()).toHaveLength(100)

    // 裁剪后新事件写回：若走合并语义，落盘里那 100 条之外的历史会被并回来（裁剪等于没做）
    useNotificationStore.getState().dispatchWsEvent({ type: 'playerJoin', data: { name: 'Alex' } })

    expect(useNotificationStore.getState().items).toHaveLength(101)
    expect(persistedItems()).toHaveLength(101)
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
    useNotificationStore
      .getState()
      .dispatchWsEvent({ type: 'playerChat', data: { name: 'Alex', message: 'hi' } })
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
    expect(persistedItems().find((n) => n.id === target.id)?.read).toBe(true)
  })

  it('markAllRead：全部已读 + 未读清零 + 持久化', () => {
    seedTwoUnread()
    useNotificationStore.getState().markAllRead()

    const after = useNotificationStore.getState()
    expect(after.items).toHaveLength(2)
    expect(after.items.every((n) => n.read)).toBe(true)
    expect(after.unreadCount).toBe(0)
    expect(persistedItems().every((n) => n.read)).toBe(true)
  })

  it('clearAll：清空条目/未读/告警状态 + 持久化为空并记下清空时刻', () => {
    seedTwoUnread()
    useNotificationStore.getState().dispatchPerformance({ tps: 10 })
    expect(useNotificationStore.getState().activeAlerts.size).toBe(1)

    useNotificationStore.getState().clearAll()

    const after = useNotificationStore.getState()
    expect(after.items).toEqual([])
    expect(after.unreadCount).toBe(0)
    expect(after.activeAlerts.size).toBe(0)
    // 载荷记下清空时刻：跨标签合并靠它把另一标签残留的旧副本挡在清空点之前
    const payload = persistedPayload()
    expect(payload.items).toEqual([])
    expect(payload.clearedAt).toBeGreaterThan(0)
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
    expect(s.items[0]).toMatchObject({
      type: 'lowTps',
      content: 'TPS 过低: 12.5',
      count: 1,
      read: false,
    })
    expect(s.activeAlerts.has('lowTps')).toBe(true)
    expect(s.unreadCount).toBe(1)
    expect(persistedItems()).toHaveLength(1)
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
    expect(s.items[0]).toMatchObject({
      type: 'highCpu',
      content: 'CPU 使用率过高: 91.5%（单核口径）',
    })
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

  it('合法持久化载荷 → 恢复条目并按 200 上限截断（保持存储顺序）', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: `n-${i}`,
      type: 'join',
      category: 'game',
      content: `c-${i}`,
      timestamp: 1_700_000_000_000 + i,
      count: 1,
      read: false,
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items, clearedAt: 0 }))

    const mod = await import('../notifications')
    const restored = mod.useNotificationStore.getState().items
    expect(restored).toHaveLength(200)
    expect(restored[0]?.id).toBe('n-0')
    expect(restored[199]?.id).toBe('n-199')
  })

  it('旧形状（纯数组载荷）读取兼容：条目与顺序原样恢复', async () => {
    const items = [
      foreignItem({ id: 'a', timestamp: 1_700_000_000_000 }),
      foreignItem({ id: 'b', timestamp: 1_700_000_009_000 }),
    ]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))

    const mod = await import('../notifications')
    const restored = mod.useNotificationStore.getState().items
    expect(restored.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('损坏 JSON → 回退空数组（不阻塞启动）', async () => {
    localStorage.setItem(STORAGE_KEY, '{broken')

    const mod = await import('../notifications')
    expect(mod.useNotificationStore.getState().items).toEqual([])
  })

  it('载荷结构非法（无 items 数组）→ 回退空数组（防御非法结构）', async () => {
    localStorage.setItem(STORAGE_KEY, '{"legacy":true}')

    const mod = await import('../notifications')
    expect(mod.useNotificationStore.getState().items).toEqual([])
  })

  it('持久化失败（配额超限）→ 内存态照常更新且不抛错', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(() =>
      useNotificationStore
        .getState()
        .dispatchWsEvent({ type: 'playerJoin', data: { name: 'Alex' } }),
    ).not.toThrow()
    expect(useNotificationStore.getState().items).toHaveLength(1)
    spy.mockRestore()
  })
})

describe('notifications store 跨标签同步（多标签写竞争）', () => {
  it('写回前先合并另一标签已写入的条目（并集，不整量覆盖）', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        items: [foreignItem({ id: 'remote-1', timestamp: 1_700_000_001_000 })],
        clearedAt: 0,
      }),
    )

    useNotificationStore.getState().dispatchWsEvent({ type: 'playerJoin', data: { name: 'Steve' } })

    const items = useNotificationStore.getState().items
    expect(items.map((n) => n.id)).toContain('remote-1')
    expect(items.some((n) => n.content === 'Steve 加入了游戏')).toBe(true)
    // 合并结果落盘：另一标签的条目不会被本标签的整量写回抹掉
    expect(persistedItems().map((n) => n.id)).toContain('remote-1')
  })

  it('已读不回退：另一标签的旧副本（read=false）改不回已读条目', () => {
    useNotificationStore.getState().dispatchWsEvent({ type: 'playerJoin', data: { name: 'Alex' } })
    const target = useNotificationStore.getState().items[0]!
    useNotificationStore.getState().markAsRead(target.id)

    // 另一标签写回它持有的清空/已读之前的副本
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ items: [{ ...target, read: false }], clearedAt: 0 }),
    )

    useNotificationStore
      .getState()
      .dispatchWsEvent({ type: 'playerChat', data: { name: 'Alex', message: 'hi' } })

    expect(useNotificationStore.getState().items.find((n) => n.id === target.id)?.read).toBe(true)
    expect(persistedItems().find((n) => n.id === target.id)?.read).toBe(true)
  })

  it('清空不被另一标签的旧副本复活（清空时刻之前的条目一律不并回）', () => {
    // 陈旧条目取显式旧时间戳：不靠用例内的真实时序，避免与「清空同毫秒」耦合
    const stale = foreignItem({ id: 'stale-1', timestamp: 1_000 })
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: [stale], clearedAt: 0 }))
    useNotificationStore.setState({ items: [stale] })

    useNotificationStore.getState().clearAll()
    const { clearedAt } = persistedPayload()
    expect(clearedAt).toBeGreaterThan(1_000)

    // 另一标签写回它手里的旧副本（沿用自己读到的清空时刻）
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: [stale], clearedAt }))
    useNotificationStore
      .getState()
      .dispatchWsEvent({ type: 'playerChat', data: { name: 'Alex', message: 'hi' } })

    const items = useNotificationStore.getState().items
    expect(items.some((n) => n.id === 'stale-1')).toBe(false)
    expect(items).toHaveLength(1)
  })

  it('同一服务端事件在两个标签各生成一份：合并后只留一条（靠信封 eventId 认身份）', () => {
    // 标签 A：收到 eventId=42 的事件并落盘，随后把该条标记为已读
    useNotificationStore
      .getState()
      .dispatchWsEvent(
        { type: 'playerJoin', data: { name: 'Alex' }, instanceId: 's1', eventId: 42 },
        1_700_000_000_000,
      )
    const aItem = useNotificationStore.getState().items[0]!
    useNotificationStore.getState().markAsRead(aItem.id)

    // 标签 B：同一事件（各标签的条目 id 是各自 randomUUID），合并时认成同一条
    useNotificationStore.setState({ items: [] })
    useNotificationStore
      .getState()
      .dispatchWsEvent(
        { type: 'playerJoin', data: { name: 'Alex' }, instanceId: 's1', eventId: 42 },
        1_700_000_000_000,
      )

    const items = useNotificationStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]?.eventKey).toBe('evt-42-0')
    // 已读态取并集：B 自己那份未读不会把 A 的已读改回去
    expect(items[0]?.read).toBe(true)
    expect(useNotificationStore.getState().unreadCount).toBe(0)
  })

  it('清空后同毫秒内产生的通知保留（清空点只剔除严格更早的条目）', () => {
    const items = [foreignItem({ id: 'before', timestamp: 1_000 })]
    useNotificationStore.setState({ items })
    useNotificationStore.getState().clearAll()
    const { clearedAt } = persistedPayload()

    // 伪造另一标签在「清空同一毫秒」写回的一条新条目
    const sameMs = foreignItem({ id: 'same-ms', timestamp: clearedAt })
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: [sameMs], clearedAt }))
    useNotificationStore
      .getState()
      .dispatchWsEvent({ type: 'playerChat', data: { name: 'Alex', message: 'hi' } })

    expect(useNotificationStore.getState().items.map((n) => n.id)).toContain('same-ms')
  })

  it('storage 事件：合并另一标签的新条目与该条目的新已读态', () => {
    const stop = startNotificationStorageSync()
    try {
      useNotificationStore
        .getState()
        .dispatchWsEvent({ type: 'playerJoin', data: { name: 'Alex' } })
      const mine = useNotificationStore.getState().items[0]!

      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEY,
          newValue: JSON.stringify({
            items: [foreignItem({ id: 'remote-9' }), { ...mine, read: true }],
            clearedAt: 0,
          }),
        }),
      )

      const items = useNotificationStore.getState().items
      expect(items.map((n) => n.id)).toContain('remote-9')
      expect(items.find((n) => n.id === mine.id)?.read).toBe(true)
      expect(useNotificationStore.getState().unreadCount).toBe(1)
    } finally {
      stop()
    }
  })

  it('storage 事件：另一标签清空后本标签内存同步清空（不靠整量替换也能收敛）', () => {
    const stop = startNotificationStorageSync()
    try {
      useNotificationStore
        .getState()
        .dispatchWsEvent({ type: 'playerJoin', data: { name: 'Alex' } })

      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEY,
          newValue: JSON.stringify({ items: [], clearedAt: Date.now() + 1 }),
        }),
      )

      expect(useNotificationStore.getState().items).toEqual([])
      expect(useNotificationStore.getState().unreadCount).toBe(0)
    } finally {
      stop()
    }
  })

  it('storage 事件：非本键的写入被忽略（不误伤其它本地状态）', () => {
    const stop = startNotificationStorageSync()
    try {
      useNotificationStore
        .getState()
        .dispatchWsEvent({ type: 'playerJoin', data: { name: 'Alex' } })

      window.dispatchEvent(new StorageEvent('storage', { key: 'mcs-theme', newValue: '"light"' }))

      expect(useNotificationStore.getState().items).toHaveLength(1)
    } finally {
      stop()
    }
  })
})
