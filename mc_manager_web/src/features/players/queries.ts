/**
 * 玩家域 TanStack Query hooks
 * - usePlayers：全量玩家列表，5s 轮询，WS 事件 invalidate
 * - usePlayerDetails：单玩家详情（列表 RCON 注入的超集字段独立端点）
 * - usePlayerBans：封禁记录，打开期间 30s 轮询
 */
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import type { BanRecord, Player } from '@/api/types'

/** 玩家列表（全量拉取无分页；WS 事件驱动 invalidate + 30s 保底轮询） */
export function usePlayers(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.players(instanceId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<Player[]>(`/api/v1/instances/${instanceId}/players`, config, signal),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: 30_000,
    staleTime: 30_000,
  })
}

/** 单玩家详情（name 需匹配服务端校验 ^[A-Za-z0-9_]{3,16}$） */
export function usePlayerDetails(instanceId: string | null, playerName: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: [...queryKeys.players(instanceId ?? ''), 'details', playerName ?? ''],
    queryFn: ({ signal }) =>
      apiGet<Player>(`/api/v1/instances/${instanceId}/players/${playerName}/details`, config, signal),
    enabled: config.status === 'ready' && Boolean(instanceId) && Boolean(playerName),
  })
}

/** 封禁记录（生效中+历史；详情面板打开期间 30s 轮询） */
export function usePlayerBans(instanceId: string | null, enabled = true) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: [...queryKeys.players(instanceId ?? ''), 'bans'],
    queryFn: ({ signal }) =>
      apiGet<BanRecord[]>(`/api/v1/instances/${instanceId}/players/bans`, config, signal),
    enabled: config.status === 'ready' && Boolean(instanceId) && enabled,
    refetchInterval: 30_000,
  })
}
