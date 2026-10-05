/**
 * 世界/属性域 API 函数（对照服务端 routes/status.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/players.ts 同模式）。
 */
import { apiGet, apiPost, apiPut, type ConnectionConfig } from './client'
import type {
  PushChannelState,
  PushChannelToggleResponse,
  ServerProperties,
  UpdatePropertiesResponse,
  WorldInfo,
} from './types'

const base = (instanceId: string) => `/api/v1/instances/${instanceId}`

/** 世界信息（GET /instances/:id/world） */
export function apiGetWorld(config: ConnectionConfig, instanceId: string) {
  return apiGet<WorldInfo>(`${base(instanceId)}/world`, config)
}

/**
 * server.properties（GET /instances/:id/properties）
 * 敏感键以 "********" 占位符返回；difficulty/gamemode 为运行中真实值覆盖。
 */
export function apiGetProperties(config: ConnectionConfig, instanceId: string) {
  return apiGet<ServerProperties>(`${base(instanceId)}/properties`, config)
}

/**
 * 更新 server.properties（PUT /instances/:id/properties）
 * 响应 data={restartRequired: string[]}：需重启生效的属性键列表；
 * 部分属性（white-list/difficulty/gamemode 等）运行中下发命令即时生效。
 */
export function apiUpdateProperties(
  config: ConnectionConfig,
  instanceId: string,
  props: ServerProperties,
) {
  return apiPut<UpdatePropertiesResponse>(`${base(instanceId)}/properties`, config, props)
}

/**
 * 推送通道（MSMP）状态（GET /instances/:id/push-channel）。
 * 单独一个端点而非走 properties：那三项必须**一起写**（只写 enabled 会让服务器起不来），
 * 通用 PUT 的逐键语义表达不了这个原子约束。
 */
export function apiGetPushChannel(config: ConnectionConfig, instanceId: string) {
  return apiGet<PushChannelState>(`${base(instanceId)}/push-channel`, config)
}

/** 开/关推送通道（POST /instances/:id/push-channel） */
export function apiSetPushChannel(config: ConnectionConfig, instanceId: string, enabled: boolean) {
  return apiPost<PushChannelToggleResponse>(`${base(instanceId)}/push-channel`, config, { enabled })
}
