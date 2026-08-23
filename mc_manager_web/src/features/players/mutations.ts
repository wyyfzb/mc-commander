/**
 * 玩家操作 mutations
 * 统一模式：操作 → invalidate 玩家列表+封禁记录 → 调用方 toast（getFriendlyErrorMessage）
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import {
  apiAddWhitelist,
  apiBanPlayer,
  apiDeopPlayer,
  apiKickPlayer,
  apiOpPlayer,
  apiPardonBan,
  apiPardonPlayer,
  apiRemoveWhitelist,
  apiSendCommand,
} from '@/api/players'
import type { BanRequestBody } from '@/api/types'

export type PlayerActionKind =
  | 'op'
  | 'deop'
  | 'kick'
  | 'ban'
  | 'pardon'
  | 'pardonTarget'
  | 'whitelistAdd'
  | 'whitelistRemove'
  | 'command'

export interface PlayerActionRequest {
  kind: PlayerActionKind
  /** 目标玩家名（pardonTarget 时为封禁目标） */
  playerName?: string
  /** kick 理由 */
  reason?: string
  /** 封禁请求体 */
  banBody?: BanRequestBody
  /** pardonTarget 的目标类型 */
  targetType?: 'player' | 'ip'
  /** 通用命令文本（kind='command'） */
  command?: string
}

/**
 * 通用玩家操作 mutation。
 * 成功与失败由调用方处理（toast/批量汇总），本 hook 只负责请求与失效刷新。
 */
export function usePlayerAction(instanceId: string | null) {
  const config = useConnectionStore()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (req: PlayerActionRequest) => {
      if (!instanceId) throw new Error('未选择实例')
      switch (req.kind) {
        case 'op':
          return apiOpPlayer(config, instanceId, req.playerName!)
        case 'deop':
          return apiDeopPlayer(config, instanceId, req.playerName!)
        case 'kick':
          return apiKickPlayer(config, instanceId, req.playerName!, req.reason)
        case 'ban':
          return apiBanPlayer(config, instanceId, req.playerName!, req.banBody ?? {})
        case 'pardon':
          return apiPardonPlayer(config, instanceId, req.playerName!)
        case 'pardonTarget':
          return apiPardonBan(config, instanceId, req.playerName!, req.targetType ?? 'player')
        case 'whitelistAdd':
          return apiAddWhitelist(config, instanceId, req.playerName!)
        case 'whitelistRemove':
          return apiRemoveWhitelist(config, instanceId, req.playerName!)
        case 'command':
          return apiSendCommand(config, instanceId, req.command!)
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.players(instanceId ?? '') })
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.players(instanceId ?? ''), 'bans'],
      })
    },
  })
}
