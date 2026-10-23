/** 面板自身去留（设置页「危险区」） */
import { apiGet, apiPost, apiDownloadFile, type ConnectionConfig } from './client'

export interface PanelDataItem {
  key: 'servers' | 'data' | 'backups'
  label: string
  path: string
  entries: number
  bytes: number
}

/** 面板当前存了多少东西；entries 为 0 表示该目录没内容，不能当成「已保留」 */
export function apiPanelData(config: ConnectionConfig) {
  return apiGet<{ items: PanelDataItem[] }>('/api/v1/panel/data', config)
}

/** 停用面板（保留全部数据）。响应返回后服务端才真正停止，故调用方能收到确认文案 */
export function apiStopPanel(config: ConnectionConfig) {
  return apiPost<null>('/api/v1/panel/stop', config, {})
}

export interface RemovalPreview {
  items: PanelDataItem[]
  /** 配了 2FA 才要求动态口令；未配时不该逼用户先去开 2FA */
  totpEnabled: boolean
  installDir: string
}

/** 彻底删除前要用户确认的全部事实 */
export function apiRemovalPreview(config: ConnectionConfig) {
  return apiGet<RemovalPreview>('/api/v1/panel/removal-preview', config)
}

export interface RemovalRequest {
  password: string
  code?: string
  /** 必须逐字输入「彻底删除」 */
  confirmText: string
  /** true = 只删程序保留存档 */
  keepData?: boolean
}

/** 面板内彻底删除：服务端先回包，再由 systemd-run 延迟执行清理 */
export function apiRequestRemoval(config: ConnectionConfig, payload: RemovalRequest) {
  return apiPost<null>('/api/v1/panel/removal', config, payload, { timeoutMs: 30_000 })
}

/**
 * 下载完整备份。
 *
 * 不能把导出地址直接挂给 <a download>：认证走 Authorization 头，
 * 浏览器自主发起的跳转带不上它，服务端只会回 401。必须由 fetch 带上头取回再存盘。
 * 打包上百 MB 时无进度会让用户以为卡死，故走带进度回调的下载通道。
 */
export function apiExportPanel(config: ConnectionConfig, onProgress?: (percent: number) => void) {
  return apiDownloadFile('/api/v1/panel/export', config, {
    timeoutMs: 30 * 60_000,
    onProgress,
  })
}
