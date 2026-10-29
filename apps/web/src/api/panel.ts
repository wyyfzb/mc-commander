/** 面板自身去留（设置页「危险区」） */
import { apiGet, apiPost, apiDownloadFile, type ConnectionConfig } from './client'

export interface PanelDataItem {
  key: 'servers' | 'data' | 'backups'
  label: string
  path: string
  entries: number
  bytes: number
  /** 所在文件系统剩余字节；-1 = 读不到（此时前端显示「未知」而不是 0） */
  freeBytes?: number
  /** 所在挂载点，空串 = 未能解析 */
  mountPoint?: string
}

/** 面板当前存了多少东西；entries 为 0 表示该目录没内容，不能当成「已保留」 */
export function apiPanelData(config: ConnectionConfig) {
  return apiGet<{ items: PanelDataItem[] }>('/api/v1/panel/data', config)
}

/**
 * 数据目录迁移：把某一类数据搬到另一个分区。
 *
 * 搬运期间实例会被停掉、面板会暂停；失败时服务端退回原配置（数据仍留在原目录）。
 */
export function apiMigrateData(
  config: ConnectionConfig,
  payload: { key: PanelDataItem['key']; target: string },
) {
  return apiPost<null>('/api/v1/panel/migrate', config, payload, { timeoutMs: 30_000 })
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

/**
 * 面板内自更新：服务端触发 root 更新单元并回包，更新在本面板进程之外进行。
 *
 * `tag` 必须形如 v0.10.4——服务端只接受这个形态，它会拼进下载 URL。
 */
export function applyPanelUpdate(config: ConnectionConfig, tag: string) {
  return apiPost<null>('/api/v1/panel/update', config, { tag }, { timeoutMs: 30_000 })
}

export interface RuntimeStatus {
  /** 当前运行进程的 Node 版本，形如 v24.22.2 */
  current: string
  /** 同一条线的官方最新版；null 表示查询失败（不是「已最新」） */
  latest: string | null
  hasUpdate: boolean
  /** 软链是否指向本面板安装的 Node；false 时不给升级按钮 */
  managed: boolean
  /** 不可自动升级的原因，managed 为 true 时为 null */
  reason: string | null
}

/** 运行环境（Node.js）状态：面板只能改自己装的 Node，别的一律只提示 */
export function apiRuntimeStatus(config: ConnectionConfig, signal?: AbortSignal) {
  return apiGet<RuntimeStatus>('/api/v1/panel/runtime', config, signal)
}

/** 升级运行环境：触发 root 单元，面板会重启一次 */
export function apiUpgradeRuntime(config: ConnectionConfig) {
  return apiPost<null>('/api/v1/panel/runtime-upgrade', config, {}, { timeoutMs: 30_000 })
}

/** 面板内彻底删除：服务端触发清理单元并回包，清理在本面板进程之外进行 */
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
