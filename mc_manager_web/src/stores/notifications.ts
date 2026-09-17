import { create } from 'zustand'
import {
  CLEANUP_TARGET,
  aggregateNotifications,
  buildAlertNotifications,
  buildNotifications,
  mergeNotifications,
  trimNotifications,
  type AlertType,
  type AppNotification,
  type WsEventInput,
} from '@/lib/notifications'
import { useNotificationPreferenceStore } from './notification-preferences'

/**
 * 通知 store（WS 事件 → 通知；聚合/未读/持久化）
 * 聚合与文案规则在 lib/notifications.ts（纯函数，单测锁定）
 * 持久化：localStorage 上限 200 条
 * 偏好过滤：类型开关关闭的 WS 通知不生成
 */

const STORAGE_KEY = 'mcs-notifications'

/**
 * 持久化载荷：条目 + 清空时刻。
 * clearedAt 是「删」的唯一载体——通知的其它变更都是单调的（新增在前、已读置位、
 * 聚合计数递增），没有它就无法区分「另一标签清空了列表」与「本地多出来的条目该保留」
 */
export interface StoredNotifications {
  items: AppNotification[]
  clearedAt: number
}

function parseStored(raw: string | null): StoredNotifications {
  try {
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      // 旧形状（纯数组载荷，无 clearedAt）：读入即归一，写入始终是新形状
      if (Array.isArray(parsed)) return { items: parsed as AppNotification[], clearedAt: 0 }
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as StoredNotifications).items)) {
        const stored = parsed as Partial<StoredNotifications>
        return { items: stored.items as AppNotification[], clearedAt: Number(stored.clearedAt) || 0 }
      }
    }
  } catch {
    // 解析失败回退空
  }
  return { items: [], clearedAt: 0 }
}

/** 启动恢复：与写回走同一套归一（排序 + 上限裁剪），避免恢复出的顺序与后续写回不一致 */
function readInitial(): AppNotification[] {
  const stored = parseStored(localStorage.getItem(STORAGE_KEY))
  return mergeNotifications(stored.items, [], stored.clearedAt)
}

interface NotificationState {
  items: AppNotification[]
  unreadCount: number
  /** 告警状态机（阈值跃迁单次通知） */
  activeAlerts: Set<AlertType>

  /** 分发 WS 事件（聚合/文案/告警状态机） */
  dispatchWsEvent: (event: WsEventInput, now?: number) => void
  /** 分发 performanceUpdate（告警状态机） */
  dispatchPerformance: (perf: {
    tps?: number | null
    cpu?: number | null
    memoryPercent?: number | null
  }) => void
  markAsRead: (id: string) => void
  markAllRead: () => void
  clearAll: () => void
}

/**
 * 清空落盘：直接写空载荷 + 清空时刻，不与存量合并——「清空」是用户显式动作，
 * 走合并会把本地刚清掉的条目按并集语义又并回来。
 * 其它标签据此（storage 事件 / 下次写回时的 clearedAt）把旧副本一并丢掉
 */
function persistClear(clearedAt: number) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ items: [], clearedAt } satisfies StoredNotifications),
    )
  } catch {
    // 忽略持久化失败
  }
}

/**
 * 写回：先读回最新副本按身份合并（另一标签刚写的新条目/已读态先收进来）再整体落盘，
 * 返回合并结果供调用方同步内存。
 * 合并是「读-合并-写」三步、非原子：两个标签恰好同时写时，后写者的合并基准可能已过期，
 * 该次写入的条目要等下一次写回或 storage 事件才收敛
 */
function persist(items: AppNotification[]): AppNotification[] {
  try {
    const stored = parseStored(localStorage.getItem(STORAGE_KEY))
    const merged = mergeNotifications(items, stored.items, stored.clearedAt)
    writePayload(merged, stored.clearedAt)
    return merged
  } catch {
    // 忽略持久化失败
    return trimNotifications(items)
  }
}

/**
 * 落盘（替换语义）：条目整体覆盖，保留既有清空时刻。
 * 用于周期性内存裁剪这类显式收缩——走合并会把刚裁掉的条目又并回内存，
 * 裁剪等于没做（持久化上限 200 仍约束裁剪之间的突发增长）
 */
function persistReplace(items: AppNotification[]) {
  try {
    writePayload(items, parseStored(localStorage.getItem(STORAGE_KEY)).clearedAt)
  } catch {
    // 忽略持久化失败
  }
}

function writePayload(items: AppNotification[], clearedAt: number) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ items, clearedAt } satisfies StoredNotifications),
  )
}

/**
 * 内存裁剪周期：持久化上限 200（dispatch 即时裁剪），
 * 内存长期留存到 100 条的周期收敛——5 分钟执行一次
 */
export const NOTIFICATION_CLEANUP_INTERVAL_MS = 5 * 60_000

/**
 * 裁剪到最近 CLEANUP_TARGET 条（内存与落盘同步收缩）。
 * 未读计数按裁剪后剩余条目重算：只移除旧条目，不篡改剩余条目的 read 状态
 */
export function runNotificationCleanup() {
  const { items } = useNotificationStore.getState()
  if (items.length <= CLEANUP_TARGET) return
  const trimmed = items.slice(0, CLEANUP_TARGET)
  persistReplace(trimmed)
  useNotificationStore.setState({
    items: trimmed,
    unreadCount: trimmed.filter((i) => !i.read).length,
  })
}

/** 启动 5 分钟周期清理（应用入口调用一次；导出便于测试注入 fake timers） */
export function startNotificationCleanupTimer(): number {
  return window.setInterval(runNotificationCleanup, NOTIFICATION_CLEANUP_INTERVAL_MS)
}

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  items: readInitial(),
  unreadCount: 0,
  activeAlerts: new Set(),

  dispatchWsEvent: (event, now = Date.now()) => {
    // instanceId 透传：server 类事件关联实例（通知条目据此跳转实例页，issue 334）
    // eventKey 透传：服务端事件身份（信封 eventId + 事件内序号）——同一条事件在
    // 多个标签页各生成一份条目，跨标签合并靠它去重（见 lib/notifications 的 merge）
    const built = buildNotifications(event)
      .map((n, i) => ({
        ...n,
        ...(event.instanceId ? { instanceId: event.instanceId } : {}),
        ...(event.eventId != null ? { eventKey: `evt-${event.eventId}-${i}` } : {}),
      }))
      .filter((n) =>
        // 偏好过滤：该类型开关关闭则通知不生成（getState 直读，无 React 依赖）
        useNotificationPreferenceStore.getState().isEnabled(n.type),
      )
    if (built.length === 0) return
    set((s) => {
      let items = s.items
      for (const n of built) {
        items = aggregateNotifications(items, n, now)
      }
      items = persist(items)
      return { items, unreadCount: items.filter((i) => !i.read).length }
    })
  },

  dispatchPerformance: (perf) => {
    const { notifications, activeAlerts } = buildAlertNotifications(
      perf,
      undefined,
      get().activeAlerts,
    )
    const enabled = notifications.filter((n) =>
      useNotificationPreferenceStore.getState().isEnabled(n.type),
    )
    if (enabled.length === 0) {
      set({ activeAlerts })
      return
    }
    set((s) => {
      let items = s.items
      for (const n of enabled) {
        items = aggregateNotifications(items, n, Date.now())
      }
      items = persist(items)
      return {
        items,
        activeAlerts,
        unreadCount: items.filter((i) => !i.read).length,
      }
    })
  },

  markAsRead: (id) =>
    set((s) => {
      const items = persist(s.items.map((n) => (n.id === id ? { ...n, read: true } : n)))
      return { items, unreadCount: items.filter((i) => !i.read).length }
    }),

  markAllRead: () =>
    set((s) => {
      const items = persist(s.items.map((n) => ({ ...n, read: true })))
      return { items, unreadCount: 0 }
    }),

  clearAll: () =>
    set(() => {
      // 清空是唯一的删除语义：落盘空载荷 + 清空时刻作墓碑，另一标签既会随
      // storage 事件同步清空，也不会在它下次写回时把已清空的列表复活
      persistClear(Date.now())
      // 清空聚合缓存：避免旧键残留导致后续错误聚合
      return { items: [], unreadCount: 0, activeAlerts: new Set() }
    }),
}))

/**
 * 跨标签同步：其它标签写入后把最新副本合并进内存（按 id 取并集、已读不回退），
 * 而非整量替换——整量替换会把本标签在收到事件前刚产生的条目一并丢弃。
 * 本标签自己的写入不触发本标签的 storage 事件，故与 persist 不构成自激。
 * 应用入口调用一次；返回解绑函数（用例可显式清理监听）
 */
export function startNotificationStorageSync(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return
    const { items: remote, clearedAt } = parseStored(e.newValue)
    useNotificationStore.setState((s) => {
      const items = mergeNotifications(s.items, remote, clearedAt)
      return { items, unreadCount: items.filter((i) => !i.read).length }
    })
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
