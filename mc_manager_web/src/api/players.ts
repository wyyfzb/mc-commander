/**
 * 玩家管理 API 函数（对照服务端 routes/players.js 契约）
 * 操作类端点全部实时落地命令；给予/传送/gamemode/clear/tell 等走通用 command 端点。
 */
import { apiDelete, apiPost, type ConnectionConfig } from './client'
import type { BanRequestBody } from './types'

const base = (instanceId: string) => `/api/v1/instances/${instanceId}`

/** 设置 OP（POST /players/:player/op → op <name>） */
export function apiOpPlayer(config: ConnectionConfig, instanceId: string, playerName: string) {
  return apiPost<null>(`${base(instanceId)}/players/${playerName}/op`, config)
}

/** 取消 OP（DELETE /players/:player/op → deop <name>） */
export function apiDeopPlayer(config: ConnectionConfig, instanceId: string, playerName: string) {
  return apiDelete<null>(`${base(instanceId)}/players/${playerName}/op`, config)
}

/** 踢出（POST /players/:player/kick {reason?} → kick <name> <reason>；reason 消毒由服务端处理） */
export function apiKickPlayer(
  config: ConnectionConfig,
  instanceId: string,
  playerName: string,
  reason?: string,
) {
  return apiPost<null>(`${base(instanceId)}/players/${playerName}/kick`, config, { reason })
}

/**
 * 封禁（POST /players/:player/ban {reason?, duration?, ip?}）
 * duration 为 s/m/h/d/w/mo 语法（如 "1h"）；缺省=永久。响应 data={expiresAt: number|null}
 */
export function apiBanPlayer(
  config: ConnectionConfig,
  instanceId: string,
  playerName: string,
  body: BanRequestBody,
) {
  return apiPost<{ expiresAt: number | null }>(
    `${base(instanceId)}/players/${playerName}/ban`,
    config,
    body,
  )
}

/** 解封（按玩家名，POST /players/:player/pardon → pardon <name>） */
export function apiPardonPlayer(config: ConnectionConfig, instanceId: string, playerName: string) {
  return apiPost<null>(`${base(instanceId)}/players/${playerName}/pardon`, config)
}

/** 解封（按目标+类型，POST /players/bans/:target/pardon {targetType:'player'|'ip'}） */
export function apiPardonBan(
  config: ConnectionConfig,
  instanceId: string,
  target: string,
  targetType: 'player' | 'ip',
) {
  return apiPost<null>(`${base(instanceId)}/players/bans/${target}/pardon`, config, { targetType })
}

/** 加入白名单（POST /players/:player/whitelist/add → whitelist add <name>） */
export function apiAddWhitelist(config: ConnectionConfig, instanceId: string, playerName: string) {
  return apiPost<null>(`${base(instanceId)}/players/${playerName}/whitelist/add`, config)
}

/** 移除白名单（DELETE /players/:player/whitelist → whitelist remove <name>） */
export function apiRemoveWhitelist(
  config: ConnectionConfig,
  instanceId: string,
  playerName: string,
) {
  return apiDelete<null>(`${base(instanceId)}/players/${playerName}/whitelist`, config)
}

/** 发送任意命令（POST /instances/:id/command；给予/传送/gamemode/clear/tell/effect 的通用落点） */
export function apiSendCommand(config: ConnectionConfig, instanceId: string, command: string) {
  return apiPost<unknown>(`${base(instanceId)}/command`, config, { command })
}
