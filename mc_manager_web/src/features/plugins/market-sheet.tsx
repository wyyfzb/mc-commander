/**
 * MarketSheet —— 插件市场侧滑面板（feat-8 延伸：Modrinth 一键安装）
 *
 * 交互设计（参考 Pterodactyl 浏览器/Modrinth 官网列表页交叉验证）：
 * - 工具栏「插件市场」按钮打开；空查询默认按下载量浏览热门插件（index=downloads）
 * - 过滤：关键词（400ms 防抖）+ 加载器下拉 + MC 版本输入（自动预填当前实例版本）
 * - 结果卡片：图标（失败回退 Package 占位）/ 标题 / 作者 / 下载量 / 描述（2 行截断）
 *   / 分类 chip（最多 3 个）/ 「已安装同名」提示
 * - 点击卡片展开版本列表（按当前过滤器拉取，最多展示 5 个）：通道徽章
 *   （release/beta/alpha）+ 发布时间 + 体积 + 兼容版本 + 安装按钮
 * - 安装：安装中 spinner + 禁用重复点击；40912 同名冲突 → 覆盖确认弹窗；
 *   成功后失效插件列表并 toast（重启生效提示）
 * - 分页：加载更多（offset 递增追加）；缓存命中时展示「缓存」角标
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  CircleAlert,
  Download,
  ExternalLink,
  Loader2,
  Package,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { ErrorCode, getFriendlyErrorText } from '@/api/errors'
import { apiMarketInstall, apiMarketSearch, apiMarketVersions } from '@/api/plugins'
import type { MarketSearchHit, MarketVersion } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Chip } from '@/components/mcs/chip'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { EmptyState } from '@/components/mcs/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatFileSize } from '@/lib/mc-files'
import { formatRelativeTime } from '@/lib/format'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { usePlugins } from './queries'

const PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 400
const MAX_VISIBLE_VERSIONS = 5

/** Bukkit 系加载器（版本行 loader chip 的高亮集合；其余显示为 muted） */
const BUKKIT_LOADERS = new Set(['paper', 'spigot', 'bukkit', 'purpur', 'folia'])

const LOADER_OPTIONS = [
  { value: '', label: '全部加载器' },
  { value: 'paper', label: 'Paper' },
  { value: 'spigot', label: 'Spigot' },
  { value: 'bukkit', label: 'Bukkit' },
  { value: 'purpur', label: 'Purpur' },
  { value: 'folia', label: 'Folia' },
] as const

/** MC 版本格式（与服务端 GAME_VERSION_REGEX 一致；空值/'unknown' 不预填） */
const GAME_VERSION_RE = /^\d{1,3}(\.\d{1,3}){0,2}(-pre\d*)?$/

/** 下载量紧凑格式：1.2k / 3.4M / 1.1B */
function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

interface MarketSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string | null
}

/** 展开状态：记录哪个 slug 展开了版本列表（同一时刻仅一个，降低请求压力） */
interface VersionsPanel {
  slug: string
  versions: MarketVersion[]
  loading: boolean
  error: string | null
}

export function MarketSheet({ open, onOpenChange, instanceId }: MarketSheetProps) {
  const instanceMcVersion = useServerStore((s) => s.status?.mcVersion)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [loader, setLoader] = useState<string>('')
  const [gameVersion, setGameVersion] = useState('')

  // 打开时预填当前实例 MC 版本（服务端探测的 mcVersion，'unknown' 不填）
  useEffect(() => {
    if (!open) return
    if (typeof instanceMcVersion === 'string' && GAME_VERSION_RE.test(instanceMcVersion)) {
      setGameVersion(instanceMcVersion)
    }
  }, [open, instanceMcVersion])

  // 关键词防抖
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // 搜索状态：手动管理（支持「加载更多」追加 + 过滤变化重置）
  const [hits, setHits] = useState<MarketSearchHit[]>([])
  const [totalHits, setTotalHits] = useState(0)
  const [cached, setCached] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const firstLoadDoneRef = useRef(false)

  // 已安装文件名集合（卡片「已安装同名」提示 + 安装后即时刷新）
  const pluginsQuery = usePlugins(open ? instanceId : null)
  const installedFiles = useMemo(
    () => new Set((pluginsQuery.data?.plugins ?? []).map((p) => p.file)),
    [pluginsQuery.data],
  )

  const fetchSearch = useCallback(
    async (offset: number) => {
      if (!instanceId) return
      searchAbortRef.current?.abort()
      const controller = new AbortController()
      searchAbortRef.current = controller
      if (offset === 0) setLoading(true)
      else setLoadingMore(true)
      setError(null)
      try {
        const data = await apiMarketSearch(
          useConnectionStore.getState(),
          instanceId,
          {
            // 空关键词：按下载量浏览热门插件（Modrinth search 支持 q 可选）
            q: debouncedQuery,
            offset,
            limit: PAGE_SIZE,
            gameVersion: gameVersion || undefined,
            loader: loader || undefined,
          },
          controller.signal,
        )
        if (controller.signal.aborted) return
        setHits((prev) => (offset === 0 ? data.hits : [...prev, ...data.hits]))
        setTotalHits(data.totalHits)
        setCached(data.cached)
        firstLoadDoneRef.current = true
      } catch (e) {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return
        setError(getFriendlyErrorText(e))
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [instanceId, debouncedQuery, gameVersion, loader],
  )

  // 打开时首次加载；防抖词/过滤器变化时重置列表
  useEffect(() => {
    if (!open || !instanceId) return
    setHits([])
    setTotalHits(0)
    void fetchSearch(0)
    return () => searchAbortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, instanceId, debouncedQuery, gameVersion, loader])

  // ── 版本面板展开 ────────────────────────────────────────────
  const [panel, setPanel] = useState<VersionsPanel | null>(null)
  const versionsAbortRef = useRef<AbortController | null>(null)

  const toggleVersions = useCallback(
    async (hit: MarketSearchHit) => {
      if (!instanceId || !hit.slug) return
      // 折叠已展开的同一项目
      if (panel?.slug === hit.slug) {
        setPanel(null)
        return
      }
      versionsAbortRef.current?.abort()
      const controller = new AbortController()
      versionsAbortRef.current = controller
      setPanel({ slug: hit.slug, versions: [], loading: true, error: null })
      try {
        const data = await apiMarketVersions(
          useConnectionStore.getState(),
          instanceId,
          hit.slug,
          { gameVersion: gameVersion || undefined, loader: loader || undefined },
          controller.signal,
        )
        if (controller.signal.aborted) return
        setPanel({ slug: hit.slug, versions: data.versions, loading: false, error: null })
      } catch (e) {
        if (controller.signal.aborted) return
        setPanel({ slug: hit.slug, versions: [], loading: false, error: getFriendlyErrorText(e) })
      }
    },
    [instanceId, panel?.slug, gameVersion, loader],
  )

  // 关闭面板时清理进行中的请求
  useEffect(() => () => {
    searchAbortRef.current?.abort()
    versionsAbortRef.current?.abort()
  }, [])

  // ── 安装（单项目串行；40912 → 覆盖确认）──────────────────────
  const [installingKey, setInstallingKey] = useState<string | null>(null)
  const [overwriteTarget, setOverwriteTarget] = useState<{ hit: MarketSearchHit; version: MarketVersion } | null>(null)

  const installOne = useCallback(
    async (hit: MarketSearchHit, version: MarketVersion, overwrite: boolean) => {
      if (!instanceId || !hit.slug) return
      const key = `${hit.slug}@${version.versionNumber}`
      setInstallingKey(key)
      try {
        const result = await apiMarketInstall(
          useConnectionStore.getState(),
          instanceId,
          hit.slug,
          version.versionNumber,
          { overwrite },
        )
        toast.success(
          result.overwritten
            ? `已覆盖安装 ${result.file}（${hit.title ?? hit.slug}），重启实例后生效`
            : `已安装 ${result.file}（${hit.title ?? hit.slug} ${version.versionNumber}），重启实例后生效`,
        )
        void pluginsQuery.refetch()
        setPanel(null) // 安装成功收起版本面板，回列表继续浏览
      } catch (e) {
        if (e instanceof ApiError && e.code === ErrorCode.PLUGIN_FILE_EXISTS) {
          setOverwriteTarget({ hit, version })
          return
        }
        toast.error(`安装 ${hit.title ?? hit.slug} 失败：${getFriendlyErrorText(e)}`)
      } finally {
        setInstallingKey(null)
      }
    },
    [instanceId, pluginsQuery],
  )

  const hasMore = hits.length < totalHits

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
        data-testid="market-sheet"
      >
        <SheetHeader className="border-b border-mcs-border-muted px-5 py-4">
          <SheetTitle className="flex items-center gap-2 text-mcs-base">
            <Package className="size-4 text-mcs-accent" aria-hidden />
            插件市场
            {cached && <Chip tone="muted">缓存</Chip>}
          </SheetTitle>
          <SheetDescription className="text-mcs-xs">
            从 Modrinth 社区搜索并一键安装 Bukkit 系插件；安装后需重启实例生效
          </SheetDescription>
        </SheetHeader>

        {/* ── 过滤栏 ── */}
        <div className="space-y-2 border-b border-mcs-border-muted px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mcs-text-subtle" aria-hidden />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索插件（留空浏览热门）…"
              className="pl-9 pr-8"
              aria-label="搜索插件关键词"
              data-testid="market-search-input"
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-1/2 -translate-y-1/2"
                onClick={() => setQuery('')}
                aria-label="清空搜索"
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Select value={loader} onValueChange={setLoader}>
              <SelectTrigger size="sm" className="w-[130px]" aria-label="按加载器过滤">
                <SelectValue placeholder="全部加载器" />
              </SelectTrigger>
              <SelectContent>
                {LOADER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={gameVersion}
              onChange={(e) => setGameVersion(e.target.value.trim())}
              placeholder="MC 版本（如 1.21.4）"
              className="h-8 flex-1 text-mcs-xs"
              aria-label="按 MC 版本过滤"
              data-testid="market-game-version"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void fetchSearch(0)}
              disabled={loading}
              aria-label="重新搜索"
              title="重新搜索"
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            </Button>
          </div>
          {totalHits > 0 && (
            <p className="text-mcs-xs text-mcs-text-subtle" aria-live="polite">
              共 {totalHits.toLocaleString()} 个结果
            </p>
          )}
        </div>

        {/* ── 结果区（滚动） ── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="market-results">
          {loading ? (
            <div className="space-y-3" aria-busy="true" aria-label="搜索中">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex gap-3 rounded-mcs-md border border-mcs-border-muted p-3">
                  <Skeleton className="size-10 rounded-mcs-md" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <EmptyState
              icon={CircleAlert}
              title="搜索失败"
              hint={error}
              action={{ label: '重试', onClick: () => void fetchSearch(0) }}
            />
          ) : hits.length === 0 ? (
            <EmptyState
              icon={Package}
              title="没有找到匹配的插件"
              hint="尝试更换关键词、放宽版本/加载器过滤，或清空过滤条件浏览热门插件"
            />
          ) : (
            <ul className="space-y-2.5" aria-label="插件搜索结果">
              {hits.map((hit) => (
                <MarketHitCard
                  key={hit.slug ?? hit.projectId ?? hit.title ?? Math.random()}
                  hit={hit}
                  expanded={panel?.slug === hit.slug}
                  panel={panel?.slug === hit.slug ? panel : null}
                  installingKey={installingKey}
                  installedFiles={installedFiles}
                  onToggle={() => void toggleVersions(hit)}
                  onInstall={(v) => void installOne(hit, v, false)}
                />
              ))}
            </ul>
          )}

          {/* 加载更多 */}
          {!loading && !error && hasMore && (
            <div className="mt-3 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchSearch(hits.length)}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <ChevronDown className="size-3.5" aria-hidden />
                )}
                加载更多（{hits.length}/{totalHits}）
              </Button>
            </div>
          )}
        </div>

        {/* ── 底注：安全说明 ── */}
        <div className="border-t border-mcs-border-muted px-5 py-2.5 text-mcs-xs text-mcs-text-subtle">
          数据源 modrinth.com（服务端代理转发，面板不出网）；文件经 zip 校验与文件名净化后落入 plugins/
        </div>
      </SheetContent>

      {/* 同名覆盖确认（与上传冲突确认同语义：升级是高影响操作） */}
      <ConfirmDialog
        open={overwriteTarget !== null}
        onOpenChange={(o) => { if (!o) setOverwriteTarget(null) }}
        title="同名插件文件已存在"
        description={`plugins/ 目录已存在 ${overwriteTarget?.version.file.filename ?? ''}（净化后同名）。覆盖安装将替换旧文件，插件升级/降级可能影响存档兼容性。`}
        confirmText="覆盖安装"
        danger
        loading={false}
        onConfirm={() => {
          const t = overwriteTarget
          setOverwriteTarget(null)
          if (t) void installOne(t.hit, t.version, true)
        }}
      />
    </Sheet>
  )
}

// ── 结果卡片（含内联版本面板）─────────────────────────────────

interface MarketHitCardProps {
  hit: MarketSearchHit
  expanded: boolean
  panel: VersionsPanel | null
  installingKey: string | null
  installedFiles: Set<string>
  onToggle: () => void
  onInstall: (version: MarketVersion) => void
}

function MarketHitCard({
  hit,
  expanded,
  panel,
  installingKey,
  installedFiles,
  onToggle,
  onInstall,
}: MarketHitCardProps) {
  const [iconFailed, setIconFailed] = useState(false)
  const title = hit.title ?? hit.slug ?? '未命名项目'

  // 与服务端净化规则保持一致：空格折叠/白名单外删除/扩展名小写
  const installedSameFile = useCallback(
    (version: MarketVersion) => {
      const cleaned = version.file.filename
        .replace(/\s+/g, '-')
        .replace(/[^A-Za-z0-9._-]/g, '')
        .replace(/\.jar$/i, '.jar')
      return installedFiles.has(cleaned)
    },
    [installedFiles],
  )

  return (
    <li
      className={`rounded-mcs-md border bg-mcs-bg-default transition-colors duration-mcs-base ${
        expanded ? 'border-mcs-accent/50' : 'border-mcs-border-muted hover:border-mcs-border-strong'
      }`}
      data-testid="market-hit"
    >
      {/* 卡片主体（点击展开版本） */}
      <button
        type="button"
        className="flex w-full items-start gap-3 p-3 text-left"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? '收起' : '展开'} ${title} 的版本列表`}
      >
        {/* 图标：加载失败回退 Package 占位 */}
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
          {hit.iconUrl && !iconFailed ? (
            <img
              src={hit.iconUrl}
              alt=""
              className="size-full object-cover"
              loading="lazy"
              onError={() => setIconFailed(true)}
            />
          ) : (
            <Package className="size-4 text-mcs-text-muted" aria-hidden />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-mcs-sm font-medium text-mcs-text-default" title={title}>
              {title}
            </span>
            {hit.author && <span className="text-mcs-xs text-mcs-text-subtle">{hit.author}</span>}
            {/* 已安装同名提示（按净化文件名比对） */}
            <Chip tone="success">↓ {formatCompact(hit.downloads)}</Chip>
          </div>
          {hit.description && (
            <p className="mt-1 line-clamp-2 text-mcs-xs text-mcs-text-muted" title={hit.description}>
              {hit.description}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {hit.categories.slice(0, 3).map((c) => (
              <Chip key={c} tone="muted">{c}</Chip>
            ))}
            {hit.dateModified && (
              <span className="text-mcs-xs text-mcs-text-subtle">
                {formatRelativeTime(hit.dateModified)} 更新
              </span>
            )}
          </div>
        </div>

        <ChevronDown
          className={`mt-1 size-4 shrink-0 text-mcs-text-subtle transition-transform duration-mcs-base ${expanded ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {/* 版本面板 */}
      {expanded && (
        <div className="border-t border-mcs-border-muted bg-mcs-bg-muted/40 px-3 py-2.5" data-testid="market-versions">
          {panel?.loading ? (
            <div className="flex items-center gap-2 py-2 text-mcs-xs text-mcs-text-subtle" aria-busy="true">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              正在获取版本列表…
            </div>
          ) : panel?.error ? (
            <p className="py-1.5 text-mcs-xs text-mcs-danger">{panel.error}</p>
          ) : panel && panel.versions.length === 0 ? (
            <p className="py-1.5 text-mcs-xs text-mcs-text-subtle">
              当前过滤条件下没有可安装的版本（可尝试放宽版本/加载器过滤）
            </p>
          ) : panel ? (
            <ul className="space-y-1.5">
              {panel.versions.slice(0, MAX_VISIBLE_VERSIONS).map((v) => {
                const key = `${hit.slug}@${v.versionNumber}`
                const installing = installingKey === key
                return (
                  <li
                    key={v.versionNumber}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-mcs-sm px-2 py-1.5 hover:bg-mcs-bg-hover"
                  >
                    <span className="font-mono text-mcs-xs text-mcs-text-default" title={v.name ?? v.versionNumber}>
                      {v.versionNumber}
                    </span>
                    {v.versionType === 'release' ? (
                      <Chip tone="success">正式</Chip>
                    ) : v.versionType === 'beta' ? (
                      <Chip tone="warning">Beta</Chip>
                    ) : v.versionType === 'alpha' ? (
                      <Chip tone="error">Alpha</Chip>
                    ) : null}
                    {installedSameFile(v) && <Chip tone="muted">同名已安装</Chip>}
                    {/* loader 标签：区分 bukkit 系 / fabric / neoforge 构建产物 */}
                    {v.loaders.slice(0, 4).map((l) => (
                      <Chip key={l} tone={BUKKIT_LOADERS.has(l) ? 'info' : 'muted'}>
                        {l}
                      </Chip>
                    ))}
                    <span className="text-mcs-xs text-mcs-text-subtle">
                      {formatFileSize(v.file.size)}
                      {v.datePublished && ` · ${formatRelativeTime(v.datePublished)}`}
                    </span>
                    <span className="min-w-0 truncate text-mcs-xs text-mcs-text-subtle" title={v.gameVersions.join(', ')}>
                      兼容 {v.gameVersions.length > 3 ? `${v.gameVersions.slice(0, 3).join(', ')} 等` : v.gameVersions.join(', ') || '—'}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {hit.slug && (
                        <a
                          href={`https://modrinth.com/project/${hit.slug}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex size-7 items-center justify-center rounded-mcs-sm text-mcs-text-subtle transition-colors hover:bg-mcs-bg-hover hover:text-mcs-text-default"
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`在 Modrinth 打开 ${title}`}
                          title="在 Modrinth 打开"
                        >
                          <ExternalLink className="size-3.5" aria-hidden />
                        </a>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={installing || installingKey !== null}
                        onClick={(e) => {
                          e.stopPropagation()
                          onInstall(v)
                        }}
                        aria-label={`安装 ${title} ${v.versionNumber}`}
                      >
                        {installing ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Download className="size-3.5" aria-hidden />
                        )}
                        {installing ? '安装中…' : '安装'}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      )}
    </li>
  )
}
