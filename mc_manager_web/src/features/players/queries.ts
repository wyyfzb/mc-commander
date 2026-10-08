/**
 * 玩家域 TanStack Query hooks
 * - usePlayers：全量玩家列表，WS 事件 invalidate + 保底轮询（推送面在线 300s / 掉线 30s）
 * - usePlayerDetails：单玩家详情（列表 RCON 注入的超集字段独立端点）
 * - usePlayerBans：封禁记录，打开期间保底轮询（同上，随推送面状态）
 */
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/api/client'
import { FALLBACK_POLL_INTERVAL_MS, PUSHED_POLL_INTERVAL_MS, queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import type { BanRecord, Player } from '@/api/types'

/** 玩家列表（全量拉取无分页；WS 事件驱动 invalidate + 随推送状态的保底轮询） */
export function usePlayers(instanceId: string | null) {
  const config = useConnectionStore()
  // 推送在线时名单由事件驱动（加入/离开/名单变化都失效重取），轮询退成兜底
  const pushConnected = useServerStore((s) => s.status?.capabilities.msmpPush ?? false)
  return useQuery({
    queryKey: queryKeys.players(instanceId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<Player[]>(`/api/v1/instances/${instanceId}/players`, config, signal),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: pushConnected ? PUSHED_POLL_INTERVAL_MS : FALLBACK_POLL_INTERVAL_MS,
    staleTime: 30_000,
  })
}

/** 单玩家详情（name 需匹配服务端校验 ^[A-Za-z0-9_]{3,16}$） */
export function usePlayerDetails(instanceId: string | null, playerName: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: [...queryKeys.players(instanceId ?? ''), 'details', playerName ?? ''],
    queryFn: ({ signal }) =>
      apiGet<Player>(
        `/api/v1/instances/${instanceId}/players/${playerName}/details`,
        config,
        signal,
      ),
    enabled: config.status === 'ready' && Boolean(instanceId) && Boolean(playerName),
  })
}

/** 封禁记录（生效中+历史；详情面板打开期间保底轮询，随推送面状态） */
export function usePlayerBans(instanceId: string | null, enabled = true) {
  const config = useConnectionStore()
  const pushConnected = useServerStore((s) => s.status?.capabilities.msmpPush ?? false)
  return useQuery({
    queryKey: [...queryKeys.players(instanceId ?? ''), 'bans'],
    queryFn: ({ signal }) =>
      apiGet<BanRecord[]>(`/api/v1/instances/${instanceId}/players/bans`, config, signal),
    enabled: config.status === 'ready' && Boolean(instanceId) && enabled,
    // 封禁/解封（含服务端到期清扫经 MSMP 解封）都会推送名单变化 ⇒ 同样降为兜底
    refetchInterval: pushConnected ? PUSHED_POLL_INTERVAL_MS : FALLBACK_POLL_INTERVAL_MS,
  })
}
