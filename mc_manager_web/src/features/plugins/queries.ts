/**
 * 插件管理域 TanStack Query hooks（feat-8 P0-5）
 * - usePlugins：插件列表（staleTime 10s，不轮询——插件仅在文件变更/启停后变化）
 * - useTogglePlugin / useDeletePlugin：mutation，成功后失效列表
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import { apiDeletePlugin, apiGetPlugins, apiSetPluginEnabled } from '@/api/plugins'
import { useConnectionStore } from '@/stores/connection'

/** 插件列表；实例切换时 query key 自动切换 */
export function usePlugins(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.plugins(instanceId ?? ''),
    queryFn: () => apiGetPlugins(config, instanceId ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId),
    staleTime: 10_000,
  })
}

/** 启用/禁用插件；成功后失效列表（服务端已原子重命名） */
export function useTogglePlugin(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ file, enabled }: { file: string; enabled: boolean }) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiSetPluginEnabled(config, instanceId, file, enabled)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(instanceId ?? '') })
    },
  })
}

/** 删除插件；成功后失效列表 */
export function useDeletePlugin(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (file: string) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiDeletePlugin(config, instanceId, file)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(instanceId ?? '') })
    },
  })
}
