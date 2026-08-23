/**
 * useNow 单测：每分钟周期刷新 + 卸载清理定时器
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useNow } from '../use-now'

afterEach(() => {
  vi.useRealTimers()
})

describe('useNow', () => {
  it('初始返回当前时间戳，按间隔周期刷新', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 15, 9, 0, 0))

    const { result } = renderHook(() => useNow())
    expect(result.current).toBe(new Date(2026, 7, 15, 9, 0, 0).getTime())

    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current).toBe(new Date(2026, 7, 15, 9, 1, 0).getTime())

    act(() => vi.advanceTimersByTime(120_000))
    expect(result.current).toBe(new Date(2026, 7, 15, 9, 3, 0).getTime())
  })

  it('卸载时清理定时器（不再触发更新）', () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(window, 'clearInterval')

    const { unmount } = renderHook(() => useNow())
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
