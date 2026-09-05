import { z } from 'zod'

export const pluginMetaSchema = z.object({
  name: z.string().nullable(),
  version: z.string().nullable(),
  main: z.string().nullable(),
  apiVersion: z.string().nullable(),
  description: z.string().nullable(),
  authors: z.array(z.string()),
  depend: z.array(z.string()),
  softdepend: z.array(z.string()),
  website: z.string().nullable(),
  load: z.enum(['STARTUP', 'POSTWORLD']).nullable(),
})

export const pluginInfoSchema = z.object({
  file: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  meta: pluginMetaSchema.nullable(),
})

export const pluginListSchema = z.object({
  plugins: z.array(pluginInfoSchema),
})

export const pluginUpdateStatusSchema = z.object({
  file: z.string(),
  name: z.string(),
  installedVersion: z.string().nullable(),
  enabled: z.boolean(),
  matched: z.boolean(),
  slug: z.string().nullable(),
  title: z.string().nullable(),
  iconUrl: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  hasNewer: z.boolean(),
})

export const pluginUpdateCheckResultSchema = z.object({
  checkedAt: z.string(),
  results: z.array(pluginUpdateStatusSchema),
})

export const pluginToggleResultSchema = z.object({
  file: z.string(),
  enabled: z.boolean(),
})

export const pluginDeleteResultSchema = z.object({
  deleted: z.string(),
})

export const pluginUploadResultSchema = z.object({
  file: z.string(),
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  meta: pluginMetaSchema.nullable(),
  overwritten: z.boolean(),
})

export const marketSearchHitSchema = z.object({
  projectId: z.string().nullable(),
  slug: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  downloads: z.number(),
  follows: z.number(),
  iconUrl: z.string().nullable(),
  dateModified: z.string().nullable(),
  categories: z.array(z.string()),
  serverSide: z.string().nullable(),
  clientSide: z.string().nullable(),
})

export const marketSearchResultSchema = z.object({
  totalHits: z.number(),
  hits: z.array(marketSearchHitSchema),
  cached: z.boolean(),
})

export const marketVersionFileSchema = z.object({
  url: z.string().nullable(),
  filename: z.string(),
  size: z.number(),
  // Modrinth 官方 sha512（hex）：下载完整性校验的数据源；上游缺省时为 null（降级放行）
  sha512: z.string().nullable(),
})

export const marketVersionSchema = z.object({
  versionNumber: z.string(),
  versionType: z.enum(['release', 'beta', 'alpha']).nullable(),
  name: z.string().nullable(),
  changelog: z.string().nullable(),
  datePublished: z.string().nullable(),
  downloads: z.number(),
  gameVersions: z.array(z.string()),
  loaders: z.array(z.string()),
  file: marketVersionFileSchema,
})

export const marketVersionsResultSchema = z.object({
  projectSlug: z.string(),
  versions: z.array(marketVersionSchema),
  cached: z.boolean(),
})

export const marketInstallResultSchema = pluginUploadResultSchema.extend({
  slug: z.string(),
  versionNumber: z.string(),
  source: z.string(),
  originalFileName: z.string(),
})

// ── 请求侧契约（issue 391：路由层 zod 契约统一）──

/**
 * GET /instances/:id/plugins/market/search 查询契约。
 * offset/limit 为分页参数，按 issue 391 边界保持既有手写解析不动
 * （由 #392 分页 util 后续统一），schema 仅作字符串透传避免归一化剥离。
 */
export const marketSearchRequestSchema = z.object({
  q: z.string().optional(),
  offset: z.string().optional(),
  limit: z.string().optional(),
  game_version: z.string().optional(),
  loader: z.string().optional(),
})

/** GET /instances/:id/plugins/market/projects/:slug/versions 查询契约 */
export const marketVersionsRequestSchema = z.object({
  game_version: z.string().optional(),
  loader: z.string().optional(),
})

/**
 * overwrite 查询参数契约：与既有 `=== 'true'` 判定同域（字符串枚举），
 * 非法值从「静默按 false 处理」收紧为 400（前端仅发送 'true' 或缺省，不受影响）。
 */
export const pluginOverwriteQuerySchema = z.object({
  overwrite: z.enum(['true', 'false']).optional(),
})

/** POST /instances/:id/plugins/market/install 请求体契约 */
export const marketInstallRequestSchema = z.object({
  slug: z.string(),
  versionNumber: z.string(),
})

/** PUT /instances/:id/plugins/:file/enabled 请求体契约 */
export const pluginEnabledRequestSchema = z.object({
  enabled: z.boolean({ invalid_type_error: 'enabled must be a boolean' }),
})

export type PluginMeta = z.infer<typeof pluginMetaSchema>
export type PluginInfo = z.infer<typeof pluginInfoSchema>
export type PluginList = z.infer<typeof pluginListSchema>
export type PluginUpdateStatus = z.infer<typeof pluginUpdateStatusSchema>
export type PluginUpdateCheckResult = z.infer<typeof pluginUpdateCheckResultSchema>
export type PluginToggleResult = z.infer<typeof pluginToggleResultSchema>
export type PluginDeleteResult = z.infer<typeof pluginDeleteResultSchema>
export type PluginUploadResult = z.infer<typeof pluginUploadResultSchema>
export type MarketSearchHit = z.infer<typeof marketSearchHitSchema>
export type MarketSearchResult = z.infer<typeof marketSearchResultSchema>
export type MarketVersionFile = z.infer<typeof marketVersionFileSchema>
export type MarketVersion = z.infer<typeof marketVersionSchema>
export type MarketVersionsResult = z.infer<typeof marketVersionsResultSchema>
export type MarketInstallResult = z.infer<typeof marketInstallResultSchema>
export type MarketSearchRequest = z.infer<typeof marketSearchRequestSchema>
export type MarketVersionsRequest = z.infer<typeof marketVersionsRequestSchema>
export type PluginOverwriteQuery = z.infer<typeof pluginOverwriteQuerySchema>
export type MarketInstallRequest = z.infer<typeof marketInstallRequestSchema>
export type PluginEnabledRequest = z.infer<typeof pluginEnabledRequestSchema>
