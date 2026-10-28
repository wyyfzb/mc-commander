import { z } from 'zod'

/** 市场装载目标：与落盘目录同名（plugin → plugins/，mod → mods/） */
export const MARKET_KINDS = ['plugin', 'mod'] as const
export type MarketKind = (typeof MARKET_KINDS)[number]

/**
 * `project_type` → 该类型可用的 loader 白名单。
 *
 * 两类 loader 不能混：Bukkit 系（plugin）与 Fabric/Forge 系（mod）在 Modrinth 上是
 * 不同的取值，混用会让 facets 过滤出空集（用户搜到零结果却不知为什么）。按类型分组
 * 而不是合成一张大表——合成后 `project_type:plugin` 配上 `loaders:fabric` 这种自相
 * 矛盾的组合会被放行。服务端校验 loader、前端渲染筛选项都取这一份。
 */
export const MARKET_LOADERS = {
  plugin: ['paper', 'spigot', 'bukkit', 'purpur', 'folia'],
  mod: ['fabric', 'forge', 'neoforge', 'quilt'],
} as const satisfies Record<MarketKind, readonly string[]>

export interface MarketTarget {
  /** 装载目标：同时是 Modrinth 的 project_type 与落盘目录的键 */
  kind: MarketKind
  /**
   * 该实例的 loader：模组系用于 facets 默认过滤（装错 loader 的 jar 起不来）；
   * Bukkit 系为 null＝不预过滤。插件多数同时声明 paper/spigot/bukkit 等多个 loader，
   * 按实例 loader 收窄会把「能用的插件」筛掉。
   */
  loader: string | null
}

/**
 * 实例 modLoader（部署类型写入的 `mod_loader`）→ 市场装载目标。
 * 判据是「是否模组系」：fabric/forge/neoforge/quilt 落 mods/，其余（Paper/Purpur/
 * Vanilla/未知）沿用 plugins/。未知值走 Bukkit 系是保守方向——模组装到 plugins/
 * 只是不生效，插件装到 mods/ 则会把 mods/ 当成插件目录读。
 */
export function resolveMarketTarget(modLoader?: string | null): MarketTarget {
  const normalized = String(modLoader ?? '')
    .trim()
    .toLowerCase()
  const modLoaders: readonly string[] = MARKET_LOADERS.mod
  if (modLoaders.includes(normalized)) {
    return { kind: 'mod', loader: normalized }
  }
  return { kind: 'plugin', loader: null }
}

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
  /** 本次没被检测的插件数，按原因分类：面板必须能说清「全部最新」覆盖了哪些 */
  skipped: z.object({
    disabled: z.number(),
    overLimit: z.number(),
    noMeta: z.number(),
  }),
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

/**
 * 实例的市场装载目标（GET /instances/:id/plugins/market/profile）。
 * 前端据此决定这一页是「插件」还是「模组」：类型是实例的属性，
 * 不在前端按 modLoader 再算一次（两处映射必然漂移）。
 */
export const marketProfileSchema = z.object({
  kind: z.enum(MARKET_KINDS),
  /** 实例自身的 loader（模组实例用于默认过滤）；Bukkit 系为 null */
  loader: z.string().nullable(),
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

/**
 * 版本声明的依赖（Modrinth `dependencies[]`）。上游多数只给 `project_id`
 * （`version_id`/`file_name` 常为 null），故契约只收项目维度的事实。
 */
export const marketVersionDependencySchema = z.object({
  projectId: z.string(),
  dependencyType: z.enum(['required', 'optional', 'incompatible', 'embedded']).nullable(),
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
  // 版本声明的依赖：仅用于安装后提示「还缺哪些前置」，不参与自动下载。
  // 可选（缺省按空数组处理）：列表消费方不必因为多了一个展示性字段而改夹具
  dependencies: z.array(marketVersionDependencySchema).optional(),
  file: marketVersionFileSchema,
})

export const marketVersionsResultSchema = z.object({
  projectSlug: z.string(),
  versions: z.array(marketVersionSchema),
  cached: z.boolean(),
})

/**
 * 安装结果里的必需前置依赖（Modrinth `dependencies[]` 中 `dependency_type=required`）。
 * 面板**不自动下载**依赖：只把「还差什么」说清，用户可再去市场搜装。
 * `slug`/`title` 是上游批量解析的结果，解析失败时为 null（projectId 仍可自查）。
 */
export const marketRequiredDependencySchema = z.object({
  projectId: z.string(),
  slug: z.string().nullable(),
  title: z.string().nullable(),
})

export const marketInstallResultSchema = pluginUploadResultSchema.extend({
  slug: z.string(),
  versionNumber: z.string(),
  source: z.string(),
  originalFileName: z.string(),
  /** 实际落盘目标与目录名：前端提示按它说，不自行拼目录名 */
  kind: z.enum(MARKET_KINDS),
  installedTo: z.string(),
  requiredDependencies: z.array(marketRequiredDependencySchema),
})

// ── 请求侧契约（路由层 zod 契约统一）──

/**
 * GET /instances/:id/plugins/market/search 查询契约。
 * offset/limit 为分页参数，按分页边界保持既有手写解析不动，
 * schema 仅作字符串透传避免归一化剥离。
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
  enabled: z.boolean({ error: () => 'enabled must be a boolean' }),
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
export type MarketProfile = z.infer<typeof marketProfileSchema>
export type MarketSearchResult = z.infer<typeof marketSearchResultSchema>
export type MarketVersionFile = z.infer<typeof marketVersionFileSchema>
export type MarketVersionDependency = z.infer<typeof marketVersionDependencySchema>
export type MarketVersion = z.infer<typeof marketVersionSchema>
export type MarketVersionsResult = z.infer<typeof marketVersionsResultSchema>
export type MarketInstallResult = z.infer<typeof marketInstallResultSchema>
export type MarketRequiredDependency = z.infer<typeof marketRequiredDependencySchema>
export type MarketSearchRequest = z.infer<typeof marketSearchRequestSchema>
export type MarketVersionsRequest = z.infer<typeof marketVersionsRequestSchema>
export type PluginOverwriteQuery = z.infer<typeof pluginOverwriteQuerySchema>
export type MarketInstallRequest = z.infer<typeof marketInstallRequestSchema>
export type PluginEnabledRequest = z.infer<typeof pluginEnabledRequestSchema>
