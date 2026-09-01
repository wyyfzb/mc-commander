/**
 * useInstanceSwitch —— 实例切换 hook（含竞态清理）
 *
 * 切换实例时：
 * 1. 取消旧实例的所有进行中 query（TanStack Query 自动 abort fetch）
 * 2. 移除旧实例的 mutation 缓存（防止 stale onSuccess 回调污染新实例状态）
 *
 * TanStack Query 的 query key 已按 instanceId 隔离，查询数据不会串。
 * 但 mutation 的 onSuccess 回调中可能调用 invalidateQueries 并携带旧 instanceId 的
 * queryKey，虽无害但浪费。本 hook 在切换时主动清理旧实例的 mutation 缓存。
 */
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useServerStore } from '@/stores/server'
import { queryKeys } from '@/api/queries'

/**
 * 返回一个增强的 switchInstance 函数，切换实例时自动清理旧实例的 query/mutation 状态。
 */
export function useInstanceSwitch() {
  const queryClient = useQueryClient()
  const instanceId = useServerStore((s) => s.instanceId)
  const setInstanceId = useServerStore((s) => s.setInstanceId)

  const switchInstance = useCallback(
    (newId: string) => {
      if (newId === instanceId) return

      // 取消旧实例所有进行中的 query（自动 abort fetch）
      if (instanceId) {
        queryClient.cancelQueries({ queryKey: queryKeys.all, exact: false })
        // 移除旧实例的 mutation 缓存（防止 stale 回调）
        queryClient.removeQueries({ queryKey: queryKeys.all, exact: false })
      }

      setInstanceId(newId)
    },
    [instanceId, setInstanceId, queryClient],
  )

  return { switchInstance }
}
