/**
 * useSnapshotSave —— 保存竞态守卫 hook
 *
 * 解决快速连续保存竞态：用户连续点击保存或 Ctrl+S 时，
 * 只有最后一次保存的结果会被采纳，中间的过时保存静默忽略。
 *
 * 机制：单调递增序号。调用 save() 时递增序号，
 * 异步操作完成后校验序号，过时结果不触发回调。
 *
 * 用法：
 *   const { save, isSaving } = useSnapshotSave({
 *     onSave: async (snapshot) => await apiPost('/save', config, snapshot),
 *     onSaved: (snapshot) => console.log('saved', snapshot.path),
 *     onError: (e) => toast.error(`保存失败：${e.message}`),
 *   })
 *   save(currentData)
 */
import { useCallback, useRef, useState } from 'react'

export interface SnapshotSaveOptions<T> {
  /** 执行保存的异步函数（接收快照数据） */
  onSave: (snapshot: T) => Promise<unknown>
  /** 保存成功回调（仅最新一次保存触发；接收对应快照） */
  onSaved?: (snapshot: T) => void
  /** 保存失败回调（仅最新一次保存触发；过时错误不回调） */
  onError?: (error: Error) => void
}

export interface SnapshotSaveResult<T> {
  /** 触发保存（传入当前快照；isSaving 期间仍可调用，旧结果自动丢弃） */
  save: (snapshot: T) => void
  /** 是否有保存操作进行中 */
  isSaving: boolean
  /** 最近一次序号匹配的错误 */
  error: Error | null
}

/**
 * 保存竞态守卫 hook：连续快速保存时，只有最后一次的结果被采纳。
 *
 * @param options - onSave（必须）、onSaved/onError（可选回调）
 * @returns save（触发）、isSaving/error（状态）
 */
export function useSnapshotSave<T>(options: SnapshotSaveOptions<T>): SnapshotSaveResult<T> {
  const { onSave, onSaved, onError } = options
  const seqRef = useRef(0)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const save = useCallback(
    (snapshot: T) => {
      const seq = ++seqRef.current
      setIsSaving(true)
      setError(null)

      void onSave(snapshot).then(
        () => {
          if (seq !== seqRef.current) return // 过时成功，静默丢弃
          setIsSaving(false)
          setError(null)
          onSaved?.(snapshot)
        },
        (e) => {
          if (seq !== seqRef.current) return // 过时失败，静默丢弃
          setIsSaving(false)
          const err = e instanceof Error ? e : new Error(String(e))
          setError(err)
          onError?.(err)
        },
      )
    },
    [onSave, onSaved, onError],
  )

  return { save, isSaving, error }
}
