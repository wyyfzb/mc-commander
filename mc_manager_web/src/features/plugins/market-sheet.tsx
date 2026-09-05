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
import { ChevronDown, CircleAlert, Loader2, Package } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { ErrorCode, getFriendlyErrorText } from '@/api/errors'
import { apiMarketInstall, apiMarketSearch, apiMarketVersions } from '@/api/plugins'
import type { MarketSearchHit, MarketVersion } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { StatusPill } from '@/components/mcs/status-pill'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { EmptyState } from '@/components/mcs/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { usePlugins } from './queries'
import { GAME_VERSION_RE, PAGE_SIZE } from './market-config'
import { MarketFilterBar } from './market-filter-bar'
import { MarketHitCard, type VersionsPanel } from './market-hit-card'

interface MarketSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instanceId: string | null
  /** 打开时预填搜索词（插件页「更新」入口带 plugin.yml name 直达搜索） */
  initialQuery?: string | null
}

export function MarketSheet({ open, onOpenChange, instanceId, initialQuery = null }: MarketSheetProps) {
  const instanceMcVersion = useServerStore((s) => s.status?.mcVersion)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // 防抖回调（由 SearchInput 内部管理 debounce 定时器；清除时立即同步）
  const handleDebouncedChange = useCallback(
    (v: string) => setDebouncedQuery(v),
    [],
  )
  const [loader, setLoader] = useState<string>('')
  const [gameVersion, setGameVersion] = useState('')

  // 打开时预填当前实例 MC 版本（服务端探测的 mcVersion，'unknown' 不填）
  useEffect(() => {
    if (!open) return
    if (typeof instanceMcVersion === 'string' && GAME_VERSION_RE.test(instanceMcVersion)) {
      // oxlint-disable-next-line react/set-state-in-effect -- 打开时用 prop 初始化可编辑 state（重置 on 开关惯用法），用户后续编辑不受影响
      setGameVersion(instanceMcVersion)
    }
  }, [open, instanceMcVersion])

  // 打开时预填搜索词（更新检测入口直达对应插件）
  useEffect(() => {
    if (!open || !initialQuery) return
    // oxlint-disable-next-line react/set-state-in-effect -- 打开时用 prop 初始化可编辑搜索词（重置 on 开关惯用法），仅首次生效
    setQuery(initialQuery)
    setDebouncedQuery(initialQuery)
  }, [open, initialQuery])

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
    // oxlint-disable-next-line react/set-state-in-effect -- 过滤条件变化时重置搜索结果（手动管理搜索状态，重置与重取同周期），随后立即异步重取
    setHits([])
    setTotalHits(0)
    void fetchSearch(0)
    return () => searchAbortRef.current?.abort()
  }, [open, instanceId, debouncedQuery, gameVersion, loader, fetchSearch])

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
          <SheetTitle className="flex items-center gap-2 text-mcs-text-default">
            <Package className="size-4 text-mcs-accent" aria-hidden />
            插件市场
            {cached && <StatusPill tone="muted">缓存</StatusPill>}
          </SheetTitle>
          <SheetDescription className="text-mcs-xs">
            从 Modrinth 社区搜索并一键安装 Bukkit 系插件；安装后需重启实例生效
          </SheetDescription>
        </SheetHeader>

        {/* ── 过滤栏 ── */}
        <MarketFilterBar
          query={query}
          onQueryChange={setQuery}
          onDebouncedChange={handleDebouncedChange}
          loader={loader}
          onLoaderChange={setLoader}
          gameVersion={gameVersion}
          onGameVersionChange={setGameVersion}
          loading={loading}
          onRefresh={() => void fetchSearch(0)}
          totalHits={totalHits}
        />

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
              action={{
                label: '清空过滤',
                onClick: () => {
                  // 一键回到「热门浏览」：清关键词 + 版本/加载器过滤（防抖词同步清，避免重搜旧词）
                  setQuery('')
                  setDebouncedQuery('')
                  setLoader('')
                  setGameVersion('')
                },
              }}
            />
          ) : (
            <ul className="space-y-2.5" aria-label="插件搜索结果">
              {hits.map((hit, i) => (
                <MarketHitCard
                  key={hit.slug ?? hit.projectId ?? hit.title ?? `hit-${i}`}
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
