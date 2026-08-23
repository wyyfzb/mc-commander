import { create } from 'zustand'
import {
  CLEANUP_TARGET,
  aggregateNotifications,
  buildAlertNotifications,
  buildNotifications,
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

function readInitial(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppNotification[]
      if (Array.isArray(parsed)) return parsed.slice(0, 200)
    }
  } catch {
    // 解析失败回退空
  }
  return []
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

function persist(items: AppNotification[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimNotifications(items)))
  } catch {
    // 忽略持久化失败
  }
}

/**
 * 内存裁剪周期：持久化上限 200（dispatch 即时裁剪），
 * 内存长期留存到 100 条的周期收敛——5 分钟执行一次
 */
export const NOTIFICATION_CLEANUP_INTERVAL_MS = 5 * 60_000

/**
 * 裁剪到最近 CLEANUP_TARGET 条（仅内存，不写 localStorage）。
 * 未读计数按裁剪后剩余条目重算：只移除旧条目，不篡改剩余条目的 read 状态
 */
export function runNotificationCleanup() {
  useNotificationStore.setState((s) => {
    if (s.items.length <= CLEANUP_TARGET) return s
    const items = s.items.slice(0, CLEANUP_TARGET)
    return { items, unreadCount: items.filter((i) => !i.read).length }
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
    const built = buildNotifications(event).filter((n) =>
      // 偏好过滤：该类型开关关闭则通知不生成（getState 直读，无 React 依赖）
      useNotificationPreferenceStore.getState().isEnabled(n.type),
    )
    if (built.length === 0) return
    set((s) => {
      let items = s.items
      for (const n of built) {
        items = aggregateNotifications(items, n, now)
      }
      items = trimNotifications(items)
      persist(items)
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
      items = trimNotifications(items)
      persist(items)
      return {
        items,
        activeAlerts,
        unreadCount: items.filter((i) => !i.read).length,
      }
    })
  },

  markAsRead: (id) =>
    set((s) => {
      const items = s.items.map((n) => (n.id === id ? { ...n, read: true } : n))
      persist(items)
      return { items, unreadCount: items.filter((i) => !i.read).length }
    }),

  markAllRead: () =>
    set((s) => {
      const items = s.items.map((n) => ({ ...n, read: true }))
      persist(items)
      return { items, unreadCount: 0 }
    }),

  clearAll: () =>
    set(() => {
      persist([])
      // 清空聚合缓存：避免旧键残留导致后续错误聚合
      return { items: [], unreadCount: 0, activeAlerts: new Set() }
    }),
}))
