import { create } from 'zustand'
import {
  NOTIFICATION_TYPE_META,
  NOTIFICATION_TYPE_ORDER,
  type NotificationCategory,
  type NotificationType,
} from '@/lib/notifications'

/**
 * 通知偏好 store
 * - 每类型单渠道开关（Web 通知唯一可见渠道为通知面板，单开关默认开）
 * - 游戏/服务器类默认开（服务端事件兜底可见）
 * - 类级批量开关
 * - localStorage 持久化：仅存非默认值（false 项）
 * - 过滤接入：notifications store 的 dispatchWsEvent 逐条检查 isEnabled（getState 直读，无 React 依赖）
 */

const STORAGE_KEY = 'mcs-notification-preferences'

/** 持久化格式：{ [typeName]: { toast: boolean } } */
type StoredPrefs = Partial<Record<NotificationType, { toast: boolean }>>

function readStored(): StoredPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as StoredPrefs
  } catch {
    return {}
  }
}

/** 读取单类型开关（无配置时默认开） */
export function isToastEnabledRaw(stored: StoredPrefs, type: NotificationType): boolean {
  return stored[type]?.toast ?? true
}

interface NotificationPreferenceState {
  /** 仅持久化非默认（false）项；读取时兜底 true */
  prefs: StoredPrefs

  /** 单类型开关是否开启 */
  isEnabled: (type: NotificationType) => boolean
  /** 设置单类型开关 */
  setEnabled: (type: NotificationType, enabled: boolean) => void
  /** 类级批量开关 */
  setCategoryEnabled: (category: NotificationCategory, enabled: boolean) => void
}

function persist(prefs: StoredPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 忽略持久化失败
  }
}

export const useNotificationPreferenceStore = create<NotificationPreferenceState>()((set, get) => ({
  prefs: readStored(),

  isEnabled: (type) => isToastEnabledRaw(get().prefs, type),

  setEnabled: (type, enabled) => {
    set((s) => {
      const prefs = { ...s.prefs, [type]: { toast: enabled } }
      persist(prefs)
      return { prefs }
    })
  },

  setCategoryEnabled: (category, enabled) => {
    set((s) => {
      const prefs = { ...s.prefs }
      for (const type of NOTIFICATION_TYPE_ORDER) {
        if (NOTIFICATION_TYPE_META[type].category === category) {
          prefs[type] = { toast: enabled }
        }
      }
      persist(prefs)
      return { prefs }
    })
  },
}))
