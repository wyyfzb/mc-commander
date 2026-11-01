/**
 * 性能诊断域 TanStack Query hooks。
 *
 * 用 mutation 而不是 query：采集是**用户点一下才发生的动作**（会在服务器上写一个诊断包），
 * 不是按间隔轮询的读取。用 query 会让「切到别的页再切回来」自动重采一次，
 * 用户在不知情的情况下让服务器多跑一轮 10 秒的采样。
 */
import { useMutation } from '@tanstack/react-query'
import { apiTakePerfSnapshot } from './api'
import { useConnectionStore } from '@/stores/connection'
import type { PerfSnapshotKind } from '@mc-commander/schemas'

/** 取一次快照；成功后结果留在 mutation 状态里供页面渲染 */
export function useTakePerfSnapshot(instanceId: string | null) {
  const config = useConnectionStore()
  return useMutation({
    mutationFn: async (kind: PerfSnapshotKind) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiTakePerfSnapshot(config, instanceId, kind)
    },
  })
}
