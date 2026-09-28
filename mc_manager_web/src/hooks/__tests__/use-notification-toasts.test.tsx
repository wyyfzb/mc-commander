/**
 * useNotificationToasts 单测：游戏事件播报、双重限流、首帧不追溯、偏好开关
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { useNotificationToasts } from '../use-notification-toasts'
import { useNotificationPreferenceStore } from '@/stores/notification-preferences'
import { useNotificationStore } from '@/stores/notifications'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }),
}))

const mockedToast = vi.mocked(toast)

function dispatch(type: string, data: Record<string, unknown>) {
  act(() => {
    useNotificationStore.getState().dispatchWsEvent({ type, data })
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 8, 10, 0, 0))
  localStorage.clear()
  useNotificationStore.setState({ items: [], unreadCount: 0, activeAlerts: new Set() })
  useNotificationPreferenceStore.setState({ prefs: {} })
  mockedToast.mockClear()
  mockedToast.error.mockClear()
  mockedToast.warning.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useNotificationToasts', () => {
  it('挂载时已有历史通知不追溯弹窗', () => {
    dispatch('playerJoin', { name: 'Steve' })
    mockedToast.mockClear()

    renderHook(() => useNotificationToasts())

    expect(mockedToast).not.toHaveBeenCalled()
  })

  it('game 类事件按中文文案播报 toast', () => {
    renderHook(() => useNotificationToasts())

    dispatch('playerDeath', { name: 'Steve', cause: '被击杀' })

    expect(mockedToast).toHaveBeenCalledWith('Steve 被击杀', { description: '死亡' })
  })

  it('server 类事件不播报（沿用只入通知中心策略）', () => {
    renderHook(() => useNotificationToasts())

    dispatch('status', { event: 'started' })

    expect(useNotificationStore.getState().items).toHaveLength(1)
    expect(mockedToast).not.toHaveBeenCalled()
  })

  it('同类型 2s 内只播报一次（聊天刷屏防护）', () => {
    renderHook(() => useNotificationToasts())

    dispatch('playerChat', { name: 'Steve', message: 'hi' })
    act(() => vi.advanceTimersByTime(1000))
    dispatch('playerChat', { name: 'Alex', message: 'yo' })

    expect(mockedToast).toHaveBeenCalledTimes(1)
  })

  it('全局窗口 5s 内播报达上限后静默丢弃', () => {
    renderHook(() => useNotificationToasts())

    dispatch('playerJoin', { name: 'P1' })
    dispatch('playerLeave', { name: 'P2' })
    dispatch('playerDeath', { name: 'P3', cause: '饿死了' })
    dispatch('achievement', { name: 'P4', advancement: 'Stone Age' })
    // 第五类：同窗口内已超上限
    dispatch('playerSleep', { name: 'P5', sleeping: true })

    expect(mockedToast).toHaveBeenCalledTimes(4)
  })

  it('偏好开关关闭的类型不播报', () => {
    renderHook(() => useNotificationToasts())
    act(() => {
      useNotificationPreferenceStore.getState().setEnabled('join', false)
    })

    dispatch('playerJoin', { name: 'Steve' })

    expect(mockedToast).not.toHaveBeenCalled()
  })
})
