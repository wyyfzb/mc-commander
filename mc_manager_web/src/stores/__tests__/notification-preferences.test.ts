/**
 * notification-preferences store 单测：
 * 默认全开 / 单类型开关 / 类级批量开关 / localStorage 持久化往返
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useNotificationPreferenceStore } from '../notification-preferences'

beforeEach(() => {
  localStorage.clear()
  useNotificationPreferenceStore.setState({ prefs: {} })
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

  it('localStorage 持久化往返：关闭项重载后保持关闭', () => {
    const store = useNotificationPreferenceStore.getState()
    store.setEnabled('death', false)

    // 模拟新会话：从 localStorage 重新读取
    const raw = localStorage.getItem('mcs-notification-preferences')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as Record<string, { toast: boolean }>
    expect(parsed.death?.toast).toBe(false)

    // 用读到的原始数据重建（等价于 store 重启）
    useNotificationPreferenceStore.setState({ prefs: parsed })
    expect(useNotificationPreferenceStore.getState().isEnabled('death')).toBe(false)
    expect(useNotificationPreferenceStore.getState().isEnabled('revive')).toBe(true)
  })
})
