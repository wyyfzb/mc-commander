/**
 * 实例/部署域 TanStack Query hooks
 * - useServerVersions：版本列表（类型切换时按需拉取；5 分钟 stale）
 * - useDeployInstance：部署 mutation（10 分钟超时长请求；进度走 WS deploy store）
 * - useUninstallInstance：卸载 mutation（成功后失效实例列表；实例名确认由服务端强制）
 * - useUpdateInstance：实例配置更新 mutation（实例设置弹窗写入；成功后失效实例详情与列表）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import {
  apiDeployInstance,
  apiGetServerVersions,
  apiUninstallInstance,
  apiUpdateInstance,
} from '@/api/instances'
import { useConnectionStore } from '@/stores/connection'
import type { DeployRequest, InstanceUpdatePayload } from '@/api/types'

/** 服务端版本列表（类型切换按需拉取） */
export function useServerVersions(type: string) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: [...queryKeys.all, 'versions', type],
    queryFn: () => apiGetServerVersions(config, type),
    enabled: config.status === 'ready',
    staleTime: 5 * 60_000,
  })
}

/** 部署新实例（长请求；进度由 WS deployProgress 驱动，见 src/stores/deploy.ts） */
export function useDeployInstance() {
  const config = useConnectionStore()
  return useMutation({
    mutationFn: async (payload: DeployRequest) => {
      return apiDeployInstance(config, payload)
    },
  })
}

/** 更新实例配置；成功后失效该实例详情与实例列表（实例设置弹窗回显依赖详情缓存） */
export function useUpdateInstance() {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (args: { instanceId: string; payload: InstanceUpdatePayload }) => {
      return apiUpdateInstance(config, args.instanceId, args.payload)
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance(args.instanceId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
    },
  })
}

/** 卸载实例；成功后失效实例列表与当前实例状态。
 *  实例名确认与「无备份不可恢复」确认都由服务端裁决，调用方按 409 提示补确认。 */
export function useUninstallInstance() {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (args: {
      instanceId: string
      confirmName: string
      acknowledgeIrreversible?: boolean
    }) => {
      const { instanceId, ...payload } = args
      return apiUninstallInstance(config, instanceId, payload)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.instances() })
    },
  })
}
