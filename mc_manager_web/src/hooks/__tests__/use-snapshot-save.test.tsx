import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSnapshotSave } from '../use-snapshot-save'

describe('useSnapshotSave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('save 成功后调用 onSaved 并传回快照', async () => {
    const onSaved = vi.fn()
    const onSave = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useSnapshotSave({ onSave, onSaved }),
    )

    const snapshot = { content: 'hello', path: '/test.txt' }
    await act(async () => {
      result.current.save(snapshot)
      // 等待 microtask
      await vi.runAllTimersAsync()
    })

    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledWith(snapshot)
    expect(result.current.isSaving).toBe(false)
  })

  it('连续快速 save，只有最后一次触发 onSaved', async () => {
    let release1!: () => void
    const gate1 = new Promise<void>((resolve) => { release1 = resolve })
    let resolve2!: () => void
    const gate2 = new Promise<void>((resolve2_) => { resolve2 = resolve2_ })

    let callCount = 0
    const onSave = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return gate1
      return gate2
    })
    const onSaved = vi.fn()

    const { result } = renderHook(() =>
      useSnapshotSave({ onSave, onSaved }),
    )

    // 第一次 save（慢）
    act(() => {
      result.current.save({ content: 'v1' })
    })
    expect(result.current.isSaving).toBe(true)

    // 第二次 save（快）
    await act(async () => {
      result.current.save({ content: 'v2' })
      resolve2()
      await vi.runAllTimersAsync()
    })

    // onSaved 只应被调用一次（v2 的）
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledWith({ content: 'v2' })

    // 释放 v1
    await act(async () => {
      release1()
      await vi.runAllTimersAsync()
    })

    // v1 的 onSaved 不应被调用（已过时）
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('save 失败时调用 onError', async () => {
    const onError = vi.fn()
    const onSave = vi.fn().mockRejectedValue(new Error('保存失败'))

    const { result } = renderHook(() =>
      useSnapshotSave({ onSave, onError }),
    )

    await act(async () => {
      result.current.save({ content: 'test' })
      await vi.runAllTimersAsync()
    })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '保存失败' }))
    expect(result.current.isSaving).toBe(false)
    expect(result.current.error).toBeInstanceOf(Error)
  })

  it('过时失败不触发 onError', async () => {
    const onError = vi.fn()
    let release1!: () => void
    const gate1 = new Promise<void>((resolve) => { release1 = resolve })

    let callCount = 0
    const onSave = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return gate1.then(() => { throw new Error('old-error') })
      return Promise.resolve()
    })

    const { result } = renderHook(() =>
      useSnapshotSave({ onSave, onError }),
    )

    // 第一次 save（慢，会失败）
    act(() => {
      result.current.save({ content: 'v1' })
    })

    // 第二次 save（快，成功）
    await act(async () => {
      result.current.save({ content: 'v2' })
      await vi.runAllTimersAsync()
    })

    // 释放第一次的失败
    await act(async () => {
      release1()
      await vi.runAllTimersAsync()
    })

    // 过时失败不应触发 onError
    expect(onError).not.toHaveBeenCalled()
  })
})
