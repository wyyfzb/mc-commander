/**
 * 备份域 API 函数（对照服务端 routes/backups.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/tasks.ts 同模式）。
 * 分页信封仅解包 data（pagination 丢失）——前端拉 pageSize=100 后 slice 最近 10 条。
 */
import { apiDelete, apiGet, apiPost, type ConnectionConfig, ApiError, NetworkError } from './client'
import type { BackupItem } from './types'

/** 备份列表（GET /instances/:id/backups?page=&pageSize=；分页信封） */
export function apiGetBackups(config: ConnectionConfig, instanceId: string) {
  return apiGet<BackupItem[]>(
    `/api/v1/instances/${instanceId}/backups?page=1&pageSize=100`,
    config,
  )
}

/** 单备份（GET /backups/:id） */
export function apiGetBackup(config: ConnectionConfig, backupId: number) {
  return apiGet<BackupItem>(`/api/v1/backups/${backupId}`, config)
}

/** 创建备份（POST /instances/:id/backups；201 备份对象 status=creating；40901 同实例进行中互斥） */
export function apiCreateBackup(
  config: ConnectionConfig,
  instanceId: string,
  payload?: { name?: string; description?: string },
) {
  return apiPost<BackupItem>(`/api/v1/instances/${instanceId}/backups`, config, payload ?? {})
}

/** 恢复备份（POST /backups/:id/restore；202 异步后台执行 + WS 事件；仅 completed 可恢复） */
export function apiRestoreBackup(config: ConnectionConfig, backupId: number) {
  return apiPost<null>(`/api/v1/backups/${backupId}/restore`, config)
}

/** 删除备份（DELETE /backups/:id；creating/restoring 中拒绝 40901） */
export function apiDeleteBackup(config: ConnectionConfig, backupId: number) {
  return apiDelete<null>(`/api/v1/backups/${backupId}`, config)
}

/** 下载备份（GET /backups/:id/download；流式 tar.gz blob，独立 120s 超时） */
export async function apiDownloadBackup(config: ConnectionConfig, backupId: number): Promise<Blob> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const url = `${base}/api/v1/backups/${backupId}/download`
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 120_000)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-API-Key': config.apiKey },
      signal: timeout.signal,
    })

    if (!res.ok) {
      try {
        const errPayload = await res.json()
        if (errPayload.status === 'error') {
          throw new ApiError(errPayload.code, res.status, errPayload.message, errPayload.details)
        }
      } catch (e) {
        if (e instanceof ApiError) throw e
      }
      throw new NetworkError(`备份下载失败（HTTP ${res.status}）`)
    }

    return await res.blob()
  } catch (e) {
    if (e instanceof ApiError || e instanceof NetworkError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new NetworkError('备份下载超时')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}
