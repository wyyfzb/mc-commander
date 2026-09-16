/**
 * 实例/部署域 API 函数（对照服务端 routes/server-jar.js + status.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/players.ts 同模式）。
 */
import { apiDelete, apiGet, apiPost, apiPut, type ConnectionConfig } from './client'
import type { DeployRequest, DeployResult, DeployStatusResponse, InstanceDeleteRequestBody, InstanceDeleteResponse, InstanceStatus, InstanceUpdatePayload, UpgradeRequest, UpgradeStartResponse, VersionsResponse } from './types'

/** 服务端版本列表（GET /versions?type=；fabric 额外返回 loaders） */
export function apiGetServerVersions(config: ConnectionConfig, type: string) {
  return apiGet<VersionsResponse>(`/api/v1/versions?type=${encodeURIComponent(type)}`, config)
}

/** 部署新实例（POST /instances/deploy）；同步长请求（jar 下载数分钟），超时放大到 10 分钟 */
export function apiDeployInstance(config: ConnectionConfig, payload: DeployRequest) {
  return apiPost<DeployResult>('/api/v1/instances/deploy', config, payload, {
    timeoutMs: 10 * 60_000,
  })
}

/** 部署进度兜底查询（GET /instances/deploy/status）；无部署/已终态返回空态 { deploying: false }
 *  extraQuery 供 e2e mock 切换场景（真实服务端忽略未知查询参数） */
export function apiGetDeployStatus(config: ConnectionConfig, signal?: AbortSignal, extraQuery = '') {
  return apiGet<DeployStatusResponse>(`/api/v1/instances/deploy/status${extraQuery}`, config, signal)
}

/** 卸载实例（DELETE /instances/:id；危险操作的实例名确认由服务端强制，
 *  confirmName 必须是该实例名；实例没有任何备份时服务端回 409，
 *  需带 acknowledgeIrreversible 重发） */
export function apiUninstallInstance(
  config: ConnectionConfig,
  instanceId: string,
  payload: InstanceDeleteRequestBody,
) {
  return apiDelete<InstanceDeleteResponse>(`/api/v1/instances/${instanceId}`, config, { body: payload })
}

/** 更新实例配置（PUT /instances/:id；白名单字段：name/description/javaPath/maxMemory/minMemory/jarFile/autoRestart/jvmArgs/startCommand） */
export function apiUpdateInstance(
  config: ConnectionConfig,
  instanceId: string,
  payload: InstanceUpdatePayload,
) {
  return apiPut<InstanceStatus>(`/api/v1/instances/${instanceId}`, config, payload)
}

/** 实例版本升级（POST /instances/:id/upgrade；202 异步，WS 推送进度） */
export function apiUpgradeInstance(config: ConnectionConfig, instanceId: string, payload: UpgradeRequest) {
  return apiPost<UpgradeStartResponse>(`/api/v1/instances/${instanceId}/upgrade`, config, payload)
}

/** 查询升级状态（GET /instances/:id/upgrade/status） */
export function apiGetUpgradeStatus(config: ConnectionConfig, instanceId: string) {
  return apiGet<{ upgrading: boolean; instanceId?: string; stage?: string; percent?: number; detail?: string }>(
    `/api/v1/instances/${instanceId}/upgrade/status`,
    config,
  )
}
