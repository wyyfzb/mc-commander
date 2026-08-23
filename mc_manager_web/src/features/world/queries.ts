/**
 * 世界/属性域 TanStack Query hooks
 * - useWorldInfo：世界信息，30s 轮询（对齐 usePlayers 的 enabled 模式）
 * - useServerProperties：server.properties，30s 轮询
 * - useUpdateProperties：保存属性，成功后失效 properties + world（difficulty/
 *   gameMode/viewDistance 等世界字段直接来源于 properties，需同步刷新）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import { apiGetProperties, apiGetWorld, apiUpdateProperties } from '@/api/world'
import { useConnectionStore } from '@/stores/connection'
import type { ServerProperties } from '@/api/types'

/** 世界信息（30s 轮询；WS 事件/属性保存后另行失效） */
export function useWorldInfo(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.world(instanceId ?? ''),
    queryFn: () => apiGetWorld(config, instanceId ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: 30_000,
  })
}

/** server.properties（30s 轮询；仅连接就绪时启用） */
export function useServerProperties(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.properties(instanceId ?? ''),
    queryFn: () => apiGetProperties(config, instanceId ?? ''),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: 30_000,
  })
}

/** 保存 server.properties；成功后失效 properties 与 world 查询（UI 层负责 toast/restartRequired 提示） */
export function useUpdateProperties(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (props: ServerProperties) => {
      if (!instanceId) throw new Error('未选择实例')
      return apiUpdateProperties(config, instanceId, props)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.properties(instanceId ?? '') })
      void queryClient.invalidateQueries({ queryKey: queryKeys.world(instanceId ?? '') })
    },
  })
}
