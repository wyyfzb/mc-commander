import { useEffect } from 'react'
import { usePanelPreferencesStore } from '@/stores/panel-preferences'
import { useNotificationPreferenceStore } from '@/stores/notification-preferences'

/**
 * 面板打开时把服务端偏好拉进内存。
 *
 * 挂在 AppShell 而不是各消费点：偏好有五个互不相关的消费方（仪表盘输入框、
 * 公告卡、礼包弹窗、传送标签页、设置页），各自拉会在同一次打开里发五份请求，
 * 且每一处都要自己处理「还没拉到」的中间态。
 *
 * 拉回后同步灌进通知偏好 store：它的开关在 WS 事件热路径上以 getState()
 * 同步读取，不能改成异步等待。
 */
export function usePanelPreferencesHydrate() {
  const hydrate = usePanelPreferencesStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    const apply = (remote: ReturnType<typeof usePanelPreferencesStore.getState>['remote']) => {
      if (remote?.notificationPreferences) {
        useNotificationPreferenceStore.getState().replaceAll(remote.notificationPreferences)
      }
    }
    apply(usePanelPreferencesStore.getState().remote)
    return usePanelPreferencesStore.subscribe((state) => apply(state.remote))
  }, [])
}
