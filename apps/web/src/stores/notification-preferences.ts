import { create } from 'zustand'
import {
  NOTIFICATION_TYPE_META,
  NOTIFICATION_TYPE_ORDER,
  type NotificationCategory,
  type NotificationType,
} from '@/lib/notifications'
import { usePanelPreferencesStore } from './panel-preferences'

/**
 * 通知偏好 store
 * - 每类型单渠道开关（Web 通知唯一可见渠道为通知面板，单开关默认开）
 * - 游戏/服务器类默认开（服务端事件兜底可见）
 * - 类级批量开关
 * - 落点：服务端偏好台账（换设备/换浏览器一致），仅存非默认值（false 项）
 * - 过滤接入：notifications store 的 dispatchWsEvent 逐条检查 isEnabled（getState 直读，无 React 依赖）
 */

/** 持久化格式：{ [typeName]: { toast: boolean } } */
type StoredPrefs = Partial<Record<NotificationType, { toast: boolean }>>

/** 读取单类型开关（无配置时默认开） */
export function isToastEnabledRaw(stored: StoredPrefs, type: NotificationType): boolean {
  return stored[type]?.toast ?? true
}

interface NotificationPreferenceState {
  /** 仅保存非默认（false）项；读取时兜底 true */
  prefs: StoredPrefs

  /** 单类型开关是否开启 */
  isEnabled: (type: NotificationType) => boolean
  /** 设置单类型开关 */
  setEnabled: (type: NotificationType, enabled: boolean) => void
  /** 类级批量开关 */
  setCategoryEnabled: (category: NotificationCategory, enabled: boolean) => void
  /** 服务端偏好拉回后整体替换（不经保存流程，避免回灌自己） */
  replaceAll: (prefs: StoredPrefs) => void
}

/**
 * 写入服务端。失败时静默：开关是高频轻操作，弹错会打断连续调整，
 * 而失败的下一次调整会重试同一份完整快照。
 */
function persist(prefs: StoredPrefs) {
  void usePanelPreferencesStore
    .getState()
    .save({ notificationPreferences: prefs })
    .catch(() => {})
}

export const useNotificationPreferenceStore = create<NotificationPreferenceState>()((set, get) => ({
  prefs: {},

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

  replaceAll: (prefs) => set({ prefs }),
}))
