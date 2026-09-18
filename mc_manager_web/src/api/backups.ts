/**
 * 备份域 API 函数（对照服务端 routes/backups.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/tasks.ts 同模式）。
 * 分页信封仅解包 data（pagination 丢失）——前端拉 pageSize=100 后 slice 最近 10 条。
 */
import { apiDelete, apiDownloadFile, apiGet, apiPost, type ConnectionConfig } from './client'
import type { ArchivedSnapshotGroup, BackupAttachResponse, BackupItem } from './types'

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

/** 恢复备份（POST /backups/:id/restore；202 异步后台执行 + WS 事件；仅 completed 可恢复）。
 *  confirmName 为该备份所属实例的名称：服务端强制比对（弹窗输入只是 UX） */
export function apiRestoreBackup(config: ConnectionConfig, backupId: number, confirmName: string) {
  return apiPost<null>(`/api/v1/backups/${backupId}/restore`, config, { confirmName })
}

/** 删除备份（DELETE /backups/:id；creating/restoring 中拒绝 40901） */
export function apiDeleteBackup(config: ConnectionConfig, backupId: number) {
  return apiDelete<null>(`/api/v1/backups/${backupId}`, config)
}

/**
 * 下载备份（GET /backups/:id/download；流式 tar.gz blob）。
 * 走共享下载实现（apiDownloadFile）而不是自实现 fetch：凭据注入（会话 Bearer 优先、
 * 不适用时才回落 X-API-Key）与 40103 会话过期处置必须与其它请求同口径——
 * 原先只发 X-API-Key，纯密码登录（本机无 Key）的用户下载备份必然 40101 失败。
 * 超时沿用 120s（共享实现的默认是 600s，备份体量远小于世界文件），
 * 响应头的 Content-Disposition 不取——文件名由前端按备份元数据构造。
 */
export async function apiDownloadBackup(config: ConnectionConfig, backupId: number): Promise<Blob> {
  const { blob } = await apiDownloadFile(`/api/v1/backups/${backupId}/download`, config, {
    timeoutMs: 120_000,
  })
  return blob
}

/**
 * 归档快照清点（GET /backups/archived）。
 * 卸载实例会删掉备份表记录、但快照目录按设计保留在磁盘上——此后它们不出现在任何实例的
 * 备份列表里，且会随保留期被自动清理。本端点把「磁盘上有、索引里没有」的那部分清点出来。
 */
export function apiGetArchivedSnapshots(config: ConnectionConfig) {
  return apiGet<ArchivedSnapshotGroup[]>('/api/v1/backups/archived', config)
}

/**
 * 挂载归档快照到实例（POST /instances/:id/backups/attach）。
 * **只建索引，不复制、不移动磁盘内容**：挂载后这些快照出现在该实例的备份列表里，
 * 可正常恢复/下载/删除。幂等：已挂载过的份数计 skipped。
 */
export function apiAttachArchive(config: ConnectionConfig, instanceId: string, archiveId: string) {
  return apiPost<BackupAttachResponse>(
    `/api/v1/instances/${instanceId}/backups/attach`,
    config,
    { archiveId },
  )
}
