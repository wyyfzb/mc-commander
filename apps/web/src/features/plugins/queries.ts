/**
 * 插件/模组管理域 TanStack Query hooks
 * - useMarketProfile：本实例的装载目标（插件 or 模组），页面与市场面板都按它走
 * - usePlugins：条目列表（staleTime 10s，30s 轮询——与其他列表页一致）
 * - useTogglePlugin / useDeletePlugin：mutation，成功后失效列表
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import {
  apiDeletePlugin,
  apiGetPlugins,
  apiMarketProfile,
  apiSetPluginEnabled,
} from '@/api/plugins'
import type { MarketKind } from '@/api/types'
import { useConnectionStore } from '@/stores/connection'

/** 实例的装载目标；实例切换时 key 自动切换 */
export function useMarketProfile(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.marketProfile(instanceId ?? ''),
    queryFn: ({ signal }) => apiMarketProfile(config, instanceId ?? '', signal),
    enabled: config.status === 'ready' && Boolean(instanceId),
    staleTime: 60_000,
  })
}

/**
 * 条目列表（kind 决定读 plugins/ 还是 mods/）；实例切换时 query key 自动切换。
 * `enabled` 供页面在装载目标未定时先不取数：按回落的 kind 抢跑会往错目录拉一次。
 */
export function usePlugins(
  instanceId: string | null,
  kind: MarketKind = 'plugin',
  { enabled = true }: { enabled?: boolean } = {},
) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.plugins(instanceId ?? '', kind),
    queryFn: () => apiGetPlugins(config, instanceId ?? '', kind),
    enabled: config.status === 'ready' && Boolean(instanceId) && enabled,
    staleTime: 10_000,
    refetchInterval: 30_000,
  })
}

/** 启用/禁用插件；成功后失效列表（服务端已原子重命名，仅插件有此语义） */
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

/** 删除条目；成功后失效列表 */
export function useDeletePlugin(instanceId: string | null, kind: MarketKind = 'plugin') {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (file: string) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiDeletePlugin(config, instanceId, file, kind)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(instanceId ?? '', kind) })
    },
  })
}
