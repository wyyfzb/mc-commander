/**
 * 设置页备份域 TanStack Query hooks
 * - useBackups：备份列表 30s 轮询
 * - 事件驱动刷新：备份/恢复 WS 通知到达时立即失效列表，无需等 30s
 *   （经 notifications store 的 items 变化触发）
 * - useCreateBackup / useRestoreBackup / useDeleteBackup：mutation，成功后失效列表
 */
import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import {
  apiCreateBackup,
  apiDeleteBackup,
  apiGetBackups,
  apiRestoreBackup,
} from '@/api/backups'
import { useConnectionStore } from '@/stores/connection'
import { useNotificationStore } from '@/stores/notifications'

/** 备份列表（30s 轮询；实例切换自动切换 query key） */
export function useBackups(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.backups(instanceId ?? ''),
    queryFn: () => apiGetBackups(config, instanceId ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: 30_000,
  })
}

/** 创建备份（POST；服务端 status=creating 异步完成）；成功后立即刷新（201 列表可见 creating 行） */
export function useCreateBackup(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      if (!instanceId) throw new Error('未选择实例')
      return apiCreateBackup(config, instanceId)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups(instanceId ?? '') })
    },
  })
}

/** 恢复备份（POST restore；202 异步 + WS 事件）；成功后立即刷新 */
export function useRestoreBackup(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (backupId: number) => {
      return apiRestoreBackup(config, backupId)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups(instanceId ?? '') })
    },
  })
}

/** 删除备份（DELETE；creating/restoring 中服务端拒绝）；成功后立即刷新 */
export function useDeleteBackup(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (backupId: number) => {
      return apiDeleteBackup(config, backupId)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups(instanceId ?? '') })
    },
  })
}

/**
 * 备份/恢复相关通知类型
 */
const REFRESH_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'backupStart',
  'backupComplete',
  'backupFailed',
  'backupSkipped',
  'restoreStart',
  'restoreComplete',
  'restoreFailed',
])

/**
 * 事件驱动刷新：备份/恢复 WS 通知到达 → 失效当前实例备份列表，无需等 30s 轮询。
 * 按最新通知 id 去重（聚合 count++ 不产生新 id，天然不会重复触发）
 */
export function useBackupEventRefresh(instanceId: string | null) {
  const queryClient = useQueryClient()
  const latest = useNotificationStore((s) => s.items[0])
  const handledRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (latest == null || !instanceId) return
    if (latest.id === handledRef.current) return
    handledRef.current = latest.id
    if (REFRESH_TRIGGER_TYPES.has(latest.type)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups(instanceId) })
    }
  }, [latest, instanceId, queryClient])
}
