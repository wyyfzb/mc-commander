import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { NOTIFICATION_TYPE_META, type NotificationType } from '@/lib/notifications'
import { useNotificationPreferenceStore } from '@/stores/notification-preferences'
import { useNotificationStore } from '@/stores/notifications'

/**
 * 通知中心 → toast 播报（游戏内事件即时反馈）
 * - 仅 game 分类：server 类常规跃迁沿用「只入通知中心」策略，避免运维噪音打断操作
 * - 双重限流：同类型节流 + 全局窗口上限，聊天/团灭密集时不刷屏（通知中心仍完整留存）
 */

/** 同类型节流窗口：同一类型在该窗口内最多播报一次 */
export const THROTTLE_PER_TYPE_MS = 2000
/** 全局窗口：窗口内播报达上限后静默丢弃 */
export const GLOBAL_WINDOW_MS = 5000
export const GLOBAL_MAX_PER_WINDOW = 4

export function useNotificationToasts() {
  const latest = useNotificationStore((s) => s.items[0])
  const lastIdRef = useRef<string | undefined>(undefined)
  const primedRef = useRef(false)
  const typeStampsRef = useRef(new Map<NotificationType, number>())
  const windowStampsRef = useRef<number[]>([])

  useEffect(() => {
    // 首帧同步：无论有无历史条目都只记录游标，避免刷新后把持久化历史追溯弹一遍
    if (!primedRef.current) {
      primedRef.current = true
      if (latest) lastIdRef.current = latest.id
      return
    }
    if (!latest) return
    if (latest.id === lastIdRef.current) return
    lastIdRef.current = latest.id

    const meta = NOTIFICATION_TYPE_META[latest.type]
    if (meta.category !== 'game') return
    if (!useNotificationPreferenceStore.getState().isEnabled(latest.type)) return

    const now = Date.now()
    if (now - (typeStampsRef.current.get(latest.type) ?? 0) < THROTTLE_PER_TYPE_MS) return
    const recent = windowStampsRef.current.filter((t) => now - t < GLOBAL_WINDOW_MS)
    if (recent.length >= GLOBAL_MAX_PER_WINDOW) {
      windowStampsRef.current = recent
      return
    }
    windowStampsRef.current = [...recent, now]
    typeStampsRef.current.set(latest.type, now)

    // 聚合命中的重复事件带 count，标注次数避免「只播报了一次」的错觉
    const text = latest.count > 1 ? `${latest.content}（×${latest.count}）` : latest.content
    const options = { description: meta.label }
    if (meta.severity === 'severe') toast.error(text, options)
    else if (meta.severity === 'warning') toast.warning(text, options)
    else toast(text, options)
  }, [latest])
}
