/**
 * 插件管理域 API 函数（feat-8 P0-5，对照服务端 routes/plugins.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/tasks.ts 同模式）。
 * 启停 = jar ↔ jar.disabled 重命名（服务端原子执行），重启实例后生效。
 * 上传走 client.ts 共享 apiUploadFile（XHR 进度 + 双通道凭据 + 网关适配）。
 */
import { apiDelete, apiGet, apiPut, apiUploadFile, type ConnectionConfig } from './client'
import type { PluginList, PluginToggleResult, PluginUploadResult } from './types'

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

/**
 * 上传插件 jar（POST /instances/:id/plugins/upload，multipart 字段 file）。
 * - 同名默认 40912 拒绝；overwrite=true 显式覆盖（插件升级必须用户确认）
 * - onProgress（0-100）与 signal（用户取消）透传给共享 XHR 实现
 */
export function apiUploadPlugin(
  config: ConnectionConfig,
  instanceId: string,
  file: File,
  opts?: { overwrite?: boolean; onProgress?: (pct: number) => void; signal?: AbortSignal },
) {
  return apiUploadFile<PluginUploadResult>(
    `/api/v1/instances/${instanceId}/plugins/upload`,
    config,
    file,
    {
      fieldName: 'file',
      query: opts?.overwrite ? 'overwrite=true' : undefined,
      onProgress: opts?.onProgress,
      signal: opts?.signal,
    },
  )
}
