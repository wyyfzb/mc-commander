/**
 * 定时任务域 TanStack Query hooks
 * - useTasks：任务列表 30s 轮询（任务被服务端触发后 nextRun/lastRun 自动更新）
 * - useCreateTask / useUpdateTask / useDeleteTask / useRunTaskNow：mutation，成功后失效列表
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import {
  apiCreateTask,
  apiDeleteTask,
  apiGetTasks,
  apiRunTaskNow,
  apiUpdateTask,
} from '@/api/tasks'
import { useConnectionStore } from '@/stores/connection'
import type { TaskCreatePayload, TaskUpdatePayload } from '@/api/types'

/** 任务列表（30s 轮询；实例切换自动切换 query key） */
export function useTasks(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.tasks(instanceId ?? ''),
    queryFn: () => apiGetTasks(config, instanceId ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: 30_000,
  })
}

/** 创建任务；成功后失效列表 */
export function useCreateTask(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: TaskCreatePayload) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiCreateTask(config, instanceId, payload)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(instanceId ?? '') })
    },
  })
}

/** 更新任务（含行内启停开关）；成功后失效列表 */
export function useUpdateTask(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ taskId, payload }: { taskId: number; payload: TaskUpdatePayload }) => {
      return apiUpdateTask(config, taskId, payload)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(instanceId ?? '') })
    },
  })
}

/** 删除任务；成功后失效列表 */
export function useDeleteTask(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (taskId: number) => {
      return apiDeleteTask(config, taskId)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(instanceId ?? '') })
    },
  })
}

/** 立即执行任务；成功后失效列表（lastRunAt 立即反映） */
export function useRunTaskNow(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (taskId: number) => {
      return apiRunTaskNow(config, taskId)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks(instanceId ?? '') })
    },
  })
}
