/**
 * 插件管理域 API 函数（feat-8 P0-5，对照服务端 routes/plugins.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/tasks.ts 同模式）。
 * 启停 = jar ↔ jar.disabled 重命名（服务端原子执行），重启实例后生效。
 */
import { apiDelete, apiGet, apiPut, type ConnectionConfig } from './client'
import type { PluginList, PluginToggleResult } from './types'

/** 插件列表（GET /instances/:id/plugins） */
export function apiGetPlugins(config: ConnectionConfig, instanceId: string) {
  return apiGet<PluginList>(`/api/v1/instances/${instanceId}/plugins`, config)
}

/** 启用/禁用插件（PUT /instances/:id/plugins/:file/enabled，body: {enabled}） */
export function apiSetPluginEnabled(
  config: ConnectionConfig,
  instanceId: string,
  file: string,
  enabled: boolean,
) {
  return apiPut<PluginToggleResult>(
    `/api/v1/instances/${instanceId}/plugins/${encodeURIComponent(file)}/enabled`,
    config,
    { enabled },
  )
}

/** 删除插件 jar（DELETE /instances/:id/plugins/:file） */
export function apiDeletePlugin(config: ConnectionConfig, instanceId: string, file: string) {
  return apiDelete<{ deleted: string }>(
    `/api/v1/instances/${instanceId}/plugins/${encodeURIComponent(file)}`,
    config,
  )
}
