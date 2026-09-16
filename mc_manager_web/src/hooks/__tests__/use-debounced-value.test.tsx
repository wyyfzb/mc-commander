/**
 * useDebouncedValue 单测：落定语义用 fake timers 断言（不靠「等多久」）
 * - 首帧同步返回初值（不产生额外一次渲染）
 * - 窗口内连发只落末值（每次变更都重新计时）
 * - delayMs 变化重新计时（依赖数组内的第二项）
 * - 卸载清理定时器
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { useDebouncedValue } from '../use-debounced-value'

afterEach(() => {
  vi.useRealTimers()
})

/** 受控探针：把「外部值」与「防抖延迟」都暴露给用例 */
function useProbe(initial: string, delayMs = 300) {
  const [value, setValue] = useState(initial)
  const debounced = useDebouncedValue(value, delayMs)
  return { debounced, setValue }
}

describe('useDebouncedValue', () => {
  it('首帧同步返回初值（不额外渲染一次）', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useProbe('https://panel-a.example.com'))
    expect(result.current.debounced).toBe('https://panel-a.example.com')
  })

  it('窗口内连发只落末值（逐次重新计时）', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useProbe('h'))

    // 模拟逐字输入：每次变更都把落定窗口推后
    for (const typing of ['ht', 'htt', 'http', 'https']) {
      act(() => result.current.setValue(typing))
      act(() => vi.advanceTimersByTime(100))
    }
    // 仍在窗口内：还没有任何中间态落定
    expect(result.current.debounced).toBe('h')

    act(() => vi.advanceTimersByTime(300))
    expect(result.current.debounced).toBe('https')
  })

  it('delayMs 变化会重新计时（不改值也能换档）', () => {
    vi.useFakeTimers()
    // 先按 300ms 起一次计时（值改为 b），随即把延迟缩到 50ms 而值不变：
    // 只有 delayMs 在依赖数组内才会重新计时，否则 300ms 的旧计时仍在跑
    const { result, rerender } = renderHook(
      ({ value, delayMs }: { value: string; delayMs: number }) => useDebouncedValue(value, delayMs),
      { initialProps: { value: 'a', delayMs: 300 } },
    )
    rerender({ value: 'b', delayMs: 300 })
    rerender({ value: 'b', delayMs: 50 })

    act(() => vi.advanceTimersByTime(50))
    expect(result.current).toBe('b')
  })

  it('卸载时清理定时器（不再悬挂更新）', () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { result, unmount } = renderHook(() => useProbe('a'))

    act(() => result.current.setValue('ab'))
    unmount()
    expect(clearSpy).toHaveBeenCalled()

    // 窗口走过也不应有任何更新（已卸载）
    act(() => vi.advanceTimersByTime(1000))
    clearSpy.mockRestore()
  })
})
