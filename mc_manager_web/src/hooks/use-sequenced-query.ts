/**
 * useSequencedQuery —— 序号守卫异步执行 hook
 *
 * 解决慢响应覆盖问题：当用户快速切换实例/页面时，旧请求的慢响应
 * 可能覆盖新请求的结果。本 hook 用单调递增序号标记每次执行，
 * 异步操作返回后校验序号是否仍为最新，过时结果静默丢弃。
 *
 * 设计参考：general-panel.tsx 的 seqRef 手动模式（issue #222 统一抽象）。
 *
 * 用法：
 *   const { execute, data, isPending, error } = useSequencedQuery(
 *     (args: string, signal) => apiGet(`/api/v1/instances/${args}/status`, config, signal)
 *   )
 */
import { useCallback, useRef, useState } from 'react'

export interface SequencedQueryState<T> {
  /** 最新一次执行的返回值（仅当序号匹配时更新） */
  data: T | null
  /** 是否有正在执行的异步操作 */
  isPending: boolean
  /** 最近一次序号匹配的错误 */
  error: Error | null
  /** 当前最新序号（调试用） */
  seq: number
}

export interface SequencedQueryResult<T, A> extends SequencedQueryState<T> {
  /** 执行异步操作；若前一次尚未完成，其结果将被自动丢弃 */
  execute: (args: A) => Promise<T | undefined>
  /** 取消当前进行中的操作（标记为过时） */
  cancel: () => void
}

/**
 * 序号守卫 hook：包装异步执行器，保证只有最新一次调用的结果会更新 state。
 *
 * @param executor - 异步函数，接收调用参数与 AbortSignal
 * @returns execute（触发执行）、data/isPending/error（响应式状态）、cancel（手动取消）
 */
export function useSequencedQuery<T, A = void>(
  executor: (args: A, signal: AbortSignal) => Promise<T>,
): SequencedQueryResult<T, A> {
  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const [state, setState] = useState<SequencedQueryState<T>>({
    data: null,
    isPending: false,
    error: null,
    seq: 0,
  })

  const execute = useCallback(
    async (args: A): Promise<T | undefined> => {
      const seq = ++seqRef.current

      // 中止上一次未完成的操作
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setState((prev) => ({ ...prev, isPending: true, error: null, seq }))

      try {
        const result = await executor(args, controller.signal)
        // 仅当序号仍为最新时更新（中间有更新的 execute 调用则丢弃）
        if (seq === seqRef.current) {
          setState({ data: result, isPending: false, error: null, seq })
        }
        return result
      } catch (e) {
        if (seq === seqRef.current) {
          setState({ data: null, isPending: false, error: e instanceof Error ? e : new Error(String(e)), seq })
        }
        // 过时错误不 re-throw（调用方无需处理被丢弃的失败）
        return undefined
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null
        }
      }
    },
    [executor],
  )

  const cancel = useCallback(() => {
    ++seqRef.current
    abortRef.current?.abort()
    abortRef.current = null
    setState((prev) => ({ ...prev, isPending: false }))
  }, [])

  return { ...state, execute, cancel }
}
