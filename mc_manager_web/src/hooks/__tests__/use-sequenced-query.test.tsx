import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSequencedQuery } from '../use-sequenced-query'

describe('useSequencedQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次 execute 成功后更新 data', async () => {
    const executor = vi.fn().mockResolvedValue('result-1')
    const { result } = renderHook(() => useSequencedQuery(executor))

    await act(async () => {
      await result.current.execute('arg')
    })

    expect(result.current.data).toBe('result-1')
    expect(result.current.isPending).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('连续两次 execute，只有最后一次结果被采纳', async () => {
    let release2!: () => void
    const gate2 = new Promise<void>((resolve) => { release2 = resolve })

    const executor = vi.fn().mockImplementation(
      (arg: string) => {
        if (arg === 'slow') return gate2.then(() => 'slow-result')
        return Promise.resolve('fast-result')
      },
    )

    const { result } = renderHook(() => useSequencedQuery(executor))

    // 第一次 execute（慢）
    let slowPromise: Promise<unknown>
    act(() => {
      slowPromise = result.current.execute('slow')
    })

    // 第二次 execute（快）
    await act(async () => {
      await result.current.execute('fast')
    })

    // 快的结果应已更新
    expect(result.current.data).toBe('fast-result')

    // 释放慢的
    await act(async () => {
      release2()
      await slowPromise
    })

    // 慢的结果应被丢弃（data 仍为 fast-result）
    expect(result.current.data).toBe('fast-result')
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('execute 期间 isPending 为 true', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor = vi.fn().mockImplementation(() => gate)

    const { result } = renderHook(() => useSequencedQuery(executor))

    act(() => {
      result.current.execute('arg')
    })

    expect(result.current.isPending).toBe(true)

    await act(async () => {
      release()
    })

    expect(result.current.isPending).toBe(false)
  })

  it('executor 失败时更新 error', async () => {
    const executor = vi.fn().mockRejectedValue(new Error('网络错误'))
    const { result } = renderHook(() => useSequencedQuery(executor))

    await act(async () => {
      await result.current.execute('arg')
    })

    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error?.message).toBe('网络错误')
    expect(result.current.data).toBeNull()
  })

  it('cancel 中止当前操作', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor = vi.fn().mockImplementation(() => gate)

    const { result } = renderHook(() => useSequencedQuery(executor))

    act(() => {
      result.current.execute('arg')
    })
    expect(result.current.isPending).toBe(true)

    act(() => {
      result.current.cancel()
    })
    expect(result.current.isPending).toBe(false)

    // 释放后不应更新（序号已过时）
    await act(async () => {
      release()
    })
    expect(result.current.data).toBeNull()
  })

  it('序号递增，每次 execute 的 seq 不同', async () => {
    const executor = vi.fn().mockResolvedValue('ok')
    const { result } = renderHook(() => useSequencedQuery(executor))

    await act(async () => {
      await result.current.execute('a')
    })
    const seq1 = result.current.seq

    await act(async () => {
      await result.current.execute('b')
    })
    const seq2 = result.current.seq

    expect(seq2).toBeGreaterThan(seq1)
  })
})
