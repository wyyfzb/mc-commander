/**
 * 备份域 API 函数（对照服务端 routes/backups.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/tasks.ts 同模式）。
 * 分页信封仅解包 data（pagination 丢失）——前端拉 pageSize=100 后 slice 最近 10 条。
 */
import { apiDelete, apiGet, apiPost, type ConnectionConfig } from './client'
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

/**
 * 备份下载导出（GET /backups/:id/download）
 * 不走 JSON 信封——直接返回 blob（application/gzip），浏览器触发保存。
 * 不受 10s 超时约束（大备份可能需要几十秒）。
 */
export async function apiDownloadBackup(
  config: ConnectionConfig,
  backupId: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const base = config.baseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/api/v1/backups/${backupId}/download`, {
    headers: { 'X-API-Key': config.apiKey },
    signal,
  })
  if (!res.ok) {
    let msg = `下载失败（HTTP ${res.status}）`
    try {
      const err = (await res.json()) as { message?: string; code?: number }
      if (err.message) msg = err.message
    } catch {}
    throw new Error(msg)
  }
  return res.blob()
}
