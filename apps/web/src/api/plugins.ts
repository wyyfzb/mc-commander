/**
 * 插件/模组管理域 API 函数（对照服务端 routes/plugins.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/tasks.ts 同模式）。
 * 装载目标由 kind 决定端点前缀：plugin → plugins/、mod → mods/（同一套后端模型）。
 * 启停 = jar ↔ jar.disabled 重命名（服务端原子执行），仅插件有此语义，重启实例后生效。
 * 上传走 client.ts 共享 apiUploadFile（XHR 进度 + 双通道凭据 + 网关适配）。
 */
import { apiDelete, apiGet, apiPost, apiPut, apiUploadFile, type ConnectionConfig } from './client'
import type {
  MarketInstallResult,
  MarketKind,
  MarketProfile,
  MarketSearchResult,
  MarketVersionsResult,
  PluginList,
  PluginToggleResult,
  PluginUpdateCheckResult,
  PluginUploadResult,
} from './types'

/** 装载目标 → 端点目录（与服务端的 LOAD_TARGETS 目录同名，API 路径的一部分） */
function targetDir(kind: MarketKind): 'plugins' | 'mods' {
  return kind === 'mod' ? 'mods' : 'plugins'
}

/** 条目列表（GET /instances/:id/{plugins|mods}） */
export function apiGetPlugins(
  config: ConnectionConfig,
  instanceId: string,
  kind: MarketKind = 'plugin',
) {
  return apiGet<PluginList>(`/api/v1/instances/${instanceId}/${targetDir(kind)}`, config)
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

/** 删除条目 jar（DELETE /instances/:id/{plugins|mods}/:file） */
export function apiDeletePlugin(
  config: ConnectionConfig,
  instanceId: string,
  file: string,
  kind: MarketKind = 'plugin',
) {
  return apiDelete<{ deleted: string }>(
    `/api/v1/instances/${instanceId}/${targetDir(kind)}/${encodeURIComponent(file)}`,
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
  opts?: {
    overwrite?: boolean
    kind?: MarketKind
    onProgress?: (pct: number) => void
    signal?: AbortSignal
  },
) {
  const dir = targetDir(opts?.kind ?? 'plugin')
  return apiUploadFile<PluginUploadResult>(
    `/api/v1/instances/${instanceId}/${dir}/upload`,
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

// ── 插件市场（延伸：Modrinth 代理，全部经服务端转发，前端不直连外网）──

/**
 * 本实例的市场装载目标（GET /instances/:id/plugins/market/profile）。
 * 类型由服务端的实例记录推导（客户端不传）：这一页是「插件」还是「模组」、
 * 默认过滤哪个 loader，都以它为准，前端不按 modLoader 再算一遍。
 */
export function apiMarketProfile(
  config: ConnectionConfig,
  instanceId: string,
  signal?: AbortSignal,
) {
  return apiGet<MarketProfile>(
    `/api/v1/instances/${instanceId}/plugins/market/profile`,
    config,
    signal,
  )
}

export interface MarketSearchParams {
  q: string
  offset?: number
  limit?: number
  /** MC 版本过滤（如 1.21.4；空串不过滤） */
  gameVersion?: string
  /** 加载器过滤：paper/spigot/bukkit/purpur/folia（空串不过滤） */
  loader?: string
}

/** 市场搜索（GET /instances/:id/plugins/market/search） */
export function apiMarketSearch(
  config: ConnectionConfig,
  instanceId: string,
  params: MarketSearchParams,
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams({
    q: params.q,
    offset: String(params.offset ?? 0),
    limit: String(params.limit ?? 20),
  })
  if (params.gameVersion) sp.set('game_version', params.gameVersion)
  if (params.loader) sp.set('loader', params.loader)
  return apiGet<MarketSearchResult>(
    `/api/v1/instances/${instanceId}/plugins/market/search?${sp.toString()}`,
    config,
    signal,
  )
}

/** 市场版本列表（GET /instances/:id/plugins/market/projects/:slug/versions） */
export function apiMarketVersions(
  config: ConnectionConfig,
  instanceId: string,
  slug: string,
  opts?: { gameVersion?: string; loader?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams()
  if (opts?.gameVersion) sp.set('game_version', opts.gameVersion)
  if (opts?.loader) sp.set('loader', opts.loader)
  const qs = sp.toString()
  return apiGet<MarketVersionsResult>(
    `/api/v1/instances/${instanceId}/plugins/market/projects/${encodeURIComponent(slug)}/versions${qs ? `?${qs}` : ''}`,
    config,
    signal,
  )
}

/**
 * 市场一键安装（POST /instances/:id/plugins/market/install）。
 * - 服务端解析下载 URL（CDN 白名单），前端只传 slug + versionNumber
 * - 同名默认 40912 拒绝；overwrite=true 显式覆盖（与手动上传同语义）
 * - 安装含服务端下载（大文件），超时放大到 10 分钟
 */
export function apiMarketInstall(
  config: ConnectionConfig,
  instanceId: string,
  slug: string,
  versionNumber: string,
  opts?: { overwrite?: boolean },
) {
  return apiPost<MarketInstallResult>(
    `/api/v1/instances/${instanceId}/plugins/market/install${opts?.overwrite ? '?overwrite=true' : ''}`,
    config,
    { slug, versionNumber },
    { timeoutMs: 600_000 },
  )
}

/**
 * 批量更新检测（POST /instances/:id/plugins/check-updates， 延伸）。
 * 服务端逐个搜索 Modrinth（并发 5 + 缓存），命中后比对版本；最坏情况
 * 20 插件 × 多次上游往返，超时放宽到 60s。
 */
export function apiCheckPluginUpdates(config: ConnectionConfig, instanceId: string) {
  return apiPost<PluginUpdateCheckResult>(
    `/api/v1/instances/${instanceId}/plugins/check-updates`,
    config,
    {},
    { timeoutMs: 60_000 },
  )
}
