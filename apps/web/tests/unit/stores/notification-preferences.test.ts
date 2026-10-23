/**
 * notification-preferences store 单测：
 * 默认全开 / 单类型开关 / 类级批量开关 / 写入面板偏好（跨设备一致）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotificationPreferenceStore } from '@/stores/notification-preferences'
import { usePanelPreferencesStore } from '@/stores/panel-preferences'

beforeEach(() => {
  useNotificationPreferenceStore.setState({ prefs: {} })
  usePanelPreferencesStore.setState({ remote: {}, saving: false })
  vi.restoreAllMocks()
})

describe('notification-preferences', () => {
  it('默认全部类型开启（存储无配置兜底 true）', () => {
    const store = useNotificationPreferenceStore.getState()
    expect(store.isEnabled('join')).toBe(true)
    expect(store.isEnabled('serverCrash')).toBe(true)
    expect(store.isEnabled('backupComplete')).toBe(true)
  })

  it('单类型关闭后 isEnabled 为 false，其他类型不受影响', () => {
    const store = useNotificationPreferenceStore.getState()
    store.setEnabled('chat', false)

    const next = useNotificationPreferenceStore.getState()
    expect(next.isEnabled('chat')).toBe(false)
    expect(next.isEnabled('join')).toBe(true)
  })

  it('类级批量开关：关闭 game 类只影响 game 类型', () => {
    const store = useNotificationPreferenceStore.getState()
    store.setCategoryEnabled('game', false)

    const next = useNotificationPreferenceStore.getState()
    expect(next.isEnabled('join')).toBe(false)
    expect(next.isEnabled('chat')).toBe(false)
    // server 类不受影响
    expect(next.isEnabled('serverStart')).toBe(true)
    expect(next.isEnabled('backupFailed')).toBe(true)
  })

  it('类级重新开启恢复默认', () => {
    const store = useNotificationPreferenceStore.getState()
    store.setCategoryEnabled('server', false)
    expect(useNotificationPreferenceStore.getState().isEnabled('save')).toBe(false)

    store.setCategoryEnabled('server', true)
    expect(useNotificationPreferenceStore.getState().isEnabled('save')).toBe(true)
  })

  it('关闭项写入面板偏好（换设备/换浏览器后仍是关闭）', () => {
    const save = vi.spyOn(usePanelPreferencesStore.getState(), 'save').mockResolvedValue(undefined)

    useNotificationPreferenceStore.getState().setEnabled('death', false)

    expect(save).toHaveBeenCalledWith({ notificationPreferences: { death: { toast: false } } })
  })

  it('偏好拉回后整体替换：重载后关闭项保持关闭', () => {
    useNotificationPreferenceStore.getState().replaceAll({ death: { toast: false } })

    expect(useNotificationPreferenceStore.getState().isEnabled('death')).toBe(false)
    expect(useNotificationPreferenceStore.getState().isEnabled('revive')).toBe(true)
  })

  it('不写本机 localStorage（落点是服务端偏好）', () => {
    useNotificationPreferenceStore.getState().setEnabled('death', false)

    expect(localStorage.getItem('mcs-notification-preferences')).toBeNull()
  })
})
