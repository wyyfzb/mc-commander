/**
 * PluginsPage —— 插件管理页（feat-8 P0-5 最小闭环 + 上传/详情/批量延伸）
 * - 插件卡片列表：元数据（plugin.yml）+ 启停状态 Chip + 启停/删除操作
 * - 上传：工具栏按钮（多选 .jar 顺序上传）+ 全页拖放（dragover 高亮遮罩），
 *   XHR 进度条（可取消）；同名冲突 → 确认弹窗后 overwrite=true 重传（服务端 40912）
 *   —— 上传队列/冲突确认/拖放逻辑外提至 use-plugin-upload.ts
 * - 详情面板：行点击打开 Sheet——完整元数据 + 文件信息（plugin-detail-sheet.tsx）
 * - 批量操作：行复选框多选 → 批量启用/禁用/删除（顺序执行，逐项提示，汇总结果）
 * - 启停 = jar ↔ jar.disabled 重命名（服务端原子执行），重启实例后生效
 *
 * 拆分结构（issue 389，纯移动零行为变更）：
 * - components/plugin-row.tsx        单行插件卡片
 * - components/plugin-detail-sheet.tsx  详情侧滑面板（含 LOAD_LABEL）
 * - components/upload-progress-bar.tsx  上传进度条
 * - use-plugin-upload.ts             上传队列/冲突确认/拖放 hook
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpFromLine,
  Package,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Store,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { queryPhase } from '@/lib/query-phase'
import type { PluginInfo } from '@/api/types'
import { Button } from '@/components/ui/button'
import { SearchInput } from '@/components/mcs/search-input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { EmptyState } from '@/components/mcs/empty-state'
import { StaleQueryNotice } from '@/components/mcs/data-states'
import { Card } from '@/components/mcs/card'
import { InfoHint } from '@/components/mcs/info-hint'
import { InstanceRequiredState } from '@/features/instances/components/instance-required-state'
import { PageHeader } from '@/components/mcs/page-header'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { MarketSheet } from './market-sheet'
import { apiCheckPluginUpdates } from '@/api/plugins'
import type { PluginUpdateStatus } from '@/api/types'
import { useDeletePlugin, usePlugins, useTogglePlugin } from './queries'
import { usePluginUpload } from './use-plugin-upload'
import { PluginRow } from './components/plugin-row'
import { PluginDetailSheet } from './components/plugin-detail-sheet'
import { UploadProgressBar } from './components/upload-progress-bar'

/** 插件管理说明全文（唯一声明源：展示点与测试都取这里） */
const PLUGIN_EFFECT_HINT = '管理 Bukkit 系插件（Paper/Spigot）：启停与增删在重启实例后生效'

export function PluginsPage() {
  const instanceId = useServerStore((s) => s.instanceId)

  const pluginsQuery = usePlugins(instanceId)
  /** 列表相位：有旧值可留时不把一次轮询抖动呈现成整屏故障 */
  const pluginsPhase = queryPhase(pluginsQuery)
  const toggleMutation = useTogglePlugin(instanceId)
  const deleteMutation = useDeletePlugin(instanceId)

  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<PluginInfo | null>(null)
  /** 批量删除确认（与单删共用 ConfirmDialog，用数组区分） */
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  /** 已勾选的插件文件名集合 */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /** 详情面板当前插件 */
  const [detail, setDetail] = useState<PluginInfo | null>(null)
  /** 插件市场侧滑面板 */
  const [marketOpen, setMarketOpen] = useState(false)
  /** 更新检测结果（file → status，feat-8 延伸：已装插件 vs Modrinth 最新版） */
  const [updateMap, setUpdateMap] = useState<Map<string, PluginUpdateStatus>>(new Map())
  const [updateChecking, setUpdateChecking] = useState(false)
  /** 市场预填搜索词（点「更新」时带上 plugin.yml name 直达） */
  const [marketInitialQuery, setMarketInitialQuery] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 正在启停的插件（行按钮 loading） */
  const togglingFile = toggleMutation.isPending ? (toggleMutation.variables?.file ?? null) : null

  // 列表加载失败提示（TanStack Query 静默 → 页面补 error toast）
  const loadErrorShownRef = useRef(false)
  useEffect(() => {
    if (pluginsQuery.isError && !loadErrorShownRef.current) {
      loadErrorShownRef.current = true
      toast.error(`加载失败：${getFriendlyErrorText(pluginsQuery.error)}`)
    } else if (pluginsQuery.isSuccess) {
      loadErrorShownRef.current = false
    }
  }, [pluginsQuery.isError, pluginsQuery.isSuccess, pluginsQuery.error])

  // 上传队列/冲突确认/拖放（逻辑外提，issue 389）
  const {
    uploading,
    queueRemaining,
    conflict,
    dragActive,
    handleFilesPicked,
    cancelUpload,
    confirmOverwrite,
    skipConflictFile,
    dismissConflict,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  } = usePluginUpload({ instanceId, refreshList: pluginsQuery.refetch })

  const plugins = useMemo(() => pluginsQuery.data?.plugins ?? [], [pluginsQuery.data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter((p) => {
      const metaName = p.meta?.name?.toLowerCase() ?? ''
      return p.file.toLowerCase().includes(q) || metaName.includes(q)
    })
  }, [plugins, search])

  const enabledCount = useMemo(() => plugins.filter((p) => p.enabled).length, [plugins])

  // 插件列表变化（实例切换/上传/删除后失效重取）→ 更新检测结果同步失效
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 实例切换时重置检测结果（重置 on 属性变化惯用法），派生渲染重写会扩大改动面
    setUpdateMap(new Map())
  }, [instanceId])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 列表刷新后剔除已不存在的勾选项；函数式更新返回原引用时无级联渲染风险
    setSelected((prev) => {
      const valid = new Set(plugins.map((p) => p.file))
      const next = new Set([...prev].filter((f) => valid.has(f)))
      return next.size === prev.size ? prev : next
    })
  }, [plugins])

  /** 批量启停的数据源：选中项的完整插件信息 */
  const selectedInfos = useMemo(
    () => plugins.filter((p) => selected.has(p.file)),
    [plugins, selected],
  )

  // 无实例门：加载中/加载失败/真空态/待选中四态各自诚实（见 InstanceRequiredState）
  if (!instanceId) {
    return <InstanceRequiredState />
  }

  /**
   * 批量更新检测（feat-8 延伸）：POST check-updates（服务端搜索 Modrinth + 版本比对）。
   * 结果映射 file → status 供行内徽章消费；hasNewer（真落后）计数 toast 提示。
   * 检测按钮与行内「可更新」徽章联动；关闭市场面板即清预填。
   */
  const checkUpdates = async () => {
    if (!instanceId || updateChecking) return
    setUpdateChecking(true)
    try {
      const result = await apiCheckPluginUpdates(useConnectionStore.getState(), instanceId)
      setUpdateMap(new Map(result.results.map((r) => [r.file, r])))
      const outdated = result.results.filter((r) => r.hasNewer)
      const mismatched = result.results.filter((r) => r.matched && !r.hasNewer && r.updateAvailable)
      if (outdated.length > 0) {
        toast.info(`检测到 ${outdated.length} 个插件有新版本`, {
          description: outdated.map((r) => `${r.name} → ${r.latestVersion}`).join('、'),
        })
      } else if (mismatched.length > 0) {
        toast.info(`${mismatched.length} 个插件版本号与 Modrinth 不一致（可能为自定义构建）`)
      } else {
        toast.success('所有已收录插件均为最新版本')
      }
    } catch (err) {
      toast.error(`更新检测失败：${getFriendlyErrorText(err)}`)
    } finally {
      setUpdateChecking(false)
    }
  }

  /** 单插件启停：成功 toast 强调"重启实例后生效"（Bukkit 插件仅启动时加载） */
  const handleToggle = async (plugin: PluginInfo, enabled: boolean) => {
    try {
      await toggleMutation.mutateAsync({ file: plugin.file, enabled })
      toast.success(
        enabled ? `已启用 ${plugin.name}，重启实例后生效` : `已禁用 ${plugin.name}，重启实例后生效`,
      )
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      await deleteMutation.mutateAsync(target.file)
      toast.success(`插件 ${target.name} 已删除`)
    } catch (e) {
      toast.error(`删除失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 批量启停入口：把选中项按当前状态翻转到目标状态（已处目标状态的项视为成功跳过） */
  const batchSetEnabled = async (enabled: boolean) => {
    let ok = 0
    let fail = 0
    const failures: { target: string; error: string }[] = []
    for (const p of selectedInfos) {
      if (p.enabled === enabled) {
        ok += 1
        continue
      }
      try {
        await toggleMutation.mutateAsync({ file: p.file, enabled })
        ok += 1
      } catch (err) {
        fail += 1
        failures.push({ target: p.file, error: err instanceof Error ? err.message : String(err) })
      }
    }
    setSelected(new Set())
    const summary = `批量${enabled ? '启用' : '禁用'}完成：成功 ${ok} 个${fail > 0 ? `，失败 ${fail} 个` : ''}，重启实例后生效`
    if (fail > 0) {
      toast.warning(summary, {
        description: failures.map((f) => `• ${f.target}：${f.error}`).join('\n'),
      })
    } else {
      toast.success(summary)
    }
  }

  const handleBatchDeleteConfirm = async () => {
    const targets = selectedInfos
    setBatchDeleteOpen(false)
    let ok = 0
    let fail = 0
    const failures: { target: string; error: string }[] = []
    for (const p of targets) {
      try {
        await deleteMutation.mutateAsync(p.file)
        ok += 1
      } catch (err) {
        fail += 1
        failures.push({ target: p.file, error: err instanceof Error ? err.message : String(err) })
      }
    }
    setSelected(new Set())
    if (fail === 0) {
      toast.success(`已删除 ${ok} 个插件`)
    } else {
      toast.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`, {
        description: failures.map((f) => `• ${f.target}：${f.error}`).join('\n'),
      })
    }
  }

  const toggleSelected = (file: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(file)
      else next.delete(file)
      return next
    })
  }

  return (
    <div
      /* @container：页头的「上下堆叠 ↔ 同行」按可用内容宽切档而非视口宽
         （侧栏可折叠，同视口下内容宽差 152px），见 PageHeader 的 className */
      className="@container relative flex h-full min-h-0 flex-col gap-4 p-4"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* 拖放高亮遮罩 */}
      {dragActive && (
        <div
          className="pointer-events-none absolute inset-2 z-(--mcs-z-overlay) flex items-center justify-center rounded-mcs-md border-2 border-dashed border-mcs-accent-border-strong bg-mcs-accent/5"
          data-testid="drop-overlay"
        >
          <div className="flex flex-col items-center gap-2 text-mcs-accent-fg">
            <ArrowUpFromLine className="size-8" aria-hidden />
            <p className="text-mcs-sm font-medium">松开以上传插件（.jar）</p>
          </div>
        </div>
      )}

      {/* 隐藏文件选择器（多选 .jar） */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".jar,application/java-archive"
        multiple
        className="sr-only"
        aria-label="选择插件 jar 文件"
        onChange={(e) => {
          handleFilesPicked(e.target.files)
          e.target.value = '' // 允许重复选择同一文件
        }}
      />

      <PageHeader
        /* 内容宽 <576px 时改为上下堆叠：操作区四个按钮不可收缩（349px），与标题同排时
           标题列只剩 39px，「插件管理」逐字竖排。断点取容器档（@xl=576px）而非视口档——
           侧栏折叠会使同视口下内容宽差 152px，且 768 以下侧栏退化成抽屉（不占布局宽），
           视口断点在这两种状态下给不出正确判据 */
        className="flex-col items-stretch gap-3 @xl:flex-row @xl:items-center"
        title="插件管理"
        description={
          <span className="inline-flex items-center gap-1">
            {plugins.length > 0 && (
              <>
                共 {plugins.length} 个（启用 {enabledCount} / 禁用 {plugins.length - enabledCount}）
              </>
            )}
            <InfoHint label="插件管理说明">{PLUGIN_EFFECT_HINT}</InfoHint>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void pluginsQuery.refetch()}
              disabled={pluginsQuery.isFetching}
              aria-label="刷新插件列表"
            >
              <RefreshCw
                className={`size-3.5 ${pluginsQuery.isFetching ? 'animate-spin' : ''}`}
                aria-hidden
              />
              刷新
            </Button>
            <Button size="sm" onClick={() => fileInputRef.current?.click()} aria-label="上传插件">
              <ArrowUpFromLine className="size-3.5" aria-hidden />
              上传插件
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void checkUpdates()}
              disabled={updateChecking || plugins.length === 0}
              aria-label="检查插件更新"
              data-testid="check-updates"
            >
              <RefreshCw
                className={`size-3.5 ${updateChecking ? 'animate-spin' : ''}`}
                aria-hidden
              />
              检查更新
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMarketOpen(true)}
              aria-label="打开插件市场"
              data-testid="open-market"
            >
              <Store className="size-3.5" aria-hidden />
              插件市场
            </Button>
          </div>
        }
      />

      {/* ── 上传进度条（顺序队列，可取消） ── */}
      {uploading && (
        <UploadProgressBar
          uploading={uploading}
          queueRemaining={queueRemaining}
          onCancel={cancelUpload}
        />
      )}

      {/* ── 批量操作条 ── */}
      {selected.size > 0 && (
        <Card
          as="div"
          className="flex flex-wrap items-center gap-2 px-4 py-2.5"
          data-testid="batch-bar"
        >
          <span className="text-mcs-sm text-mcs-text-default">
            已选 <span className="font-semibold">{selected.size}</span> 个
          </span>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <Button variant="outline" size="sm" onClick={() => void batchSetEnabled(true)}>
            <Power className="size-3.5" aria-hidden />
            批量启用
          </Button>
          <Button variant="outline" size="sm" onClick={() => void batchSetEnabled(false)}>
            <PowerOff className="size-3.5" aria-hidden />
            批量禁用
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-mcs-error-fg hover:text-mcs-error-fg"
            onClick={() => setBatchDeleteOpen(true)}
          >
            <Trash2 className="size-3.5" aria-hidden />
            删除
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
        </Card>
      )}

      {/* ── 搜索（多插件时快速定位；过滤不改变统计数字） ── */}
      {plugins.length > 5 && (
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="搜索插件名或文件名…"
          aria-label="搜索插件"
        />
      )}

      {/* ── 内容区 ── */}
      {pluginsPhase === 'stale' && (
        <StaleQueryNotice
          className="mb-2"
          error={pluginsQuery.error}
          onRetry={() => void pluginsQuery.refetch()}
        />
      )}
      {pluginsQuery.isPending ? (
        <div className="space-y-2" data-testid="plugin-skeletons" aria-label="加载插件中">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-mcs-md border border-mcs-border-muted p-4"
            >
              <Skeleton className="size-9 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : pluginsPhase === 'failed' ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={AlertTriangle}
            title="加载失败"
            hint={`无法获取插件列表：${getFriendlyErrorText(pluginsQuery.error)}`}
            action={{ label: '重试', onClick: () => void pluginsQuery.refetch() }}
          />
        </div>
      ) : plugins.length === 0 ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={Package}
            title="暂无插件"
            hint={
              <>
                将插件 jar 拖入本页或点击「上传插件」，放入实例{' '}
                <code className="text-mcs-text-muted">plugins/</code>{' '}
                目录，首次启动实例后会生成该目录
              </>
            }
            action={{ label: '上传插件', onClick: () => fileInputRef.current?.click() }}
          />
          <div className="mt-3 flex justify-center">
            <Button
              variant="link"
              size="sm"
              onClick={() => setMarketOpen(true)}
              data-testid="open-market-empty"
            >
              <Store className="size-3.5" aria-hidden />
              或从插件市场一键安装
            </Button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-4 py-12 text-center text-mcs-text-muted">
          <Search className="size-8 opacity-60" aria-hidden />
          <p className="mt-1 text-mcs-sm">无匹配插件</p>
          <p className="text-mcs-xs text-mcs-text-muted">换个关键词试试</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Card as="div" className="overflow-hidden">
            <ul className="divide-y divide-mcs-border-subtle">
              {filtered.map((plugin) => (
                <PluginRow
                  key={plugin.file}
                  plugin={plugin}
                  checked={selected.has(plugin.file)}
                  onCheckedChange={(c) => toggleSelected(plugin.file, c)}
                  toggling={togglingFile === plugin.file}
                  deleting={deleteMutation.isPending && deleteMutation.variables === plugin.file}
                  onToggle={handleToggle}
                  onDelete={() => setDeleteTarget(plugin)}
                  onOpenDetail={() => setDetail(plugin)}
                  updateInfo={updateMap.get(plugin.file)}
                  onUpdate={(p) => {
                    setMarketInitialQuery(p.meta?.name ?? p.name)
                    setMarketOpen(true)
                  }}
                />
              ))}
            </ul>
          </Card>
        </div>
      )}

      {/* ── 删除确认（单个） ── */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`删除插件 ${deleteTarget?.name ?? ''}？`}
        description={`将永久删除文件 ${deleteTarget?.file ?? ''}。`}
        warning="此操作不可撤销"
        confirmText="删除"
        danger
        onConfirm={() => void handleDeleteConfirm()}
      />

      {/* ── 删除确认（批量） ── */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(open) => {
          if (!open) setBatchDeleteOpen(false)
        }}
        title={`删除 ${selected.size} 个插件？`}
        description="将永久删除选中的插件文件。"
        warning="此操作不可撤销"
        confirmText={`删除 ${selected.size} 个`}
        danger
        onConfirm={() => void handleBatchDeleteConfirm()}
      />

      {/* ── 同名覆盖确认 ── */}
      <ConfirmDialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open) dismissConflict()
        }}
        title="同名插件已存在"
        description={`plugins/ 目录中已存在 ${conflict?.file.name ?? ''}。覆盖后旧版本将被替换（建议先备份）。`}
        confirmText="覆盖上传"
        danger
        onConfirm={() => confirmOverwrite()}
        onCancel={() => skipConflictFile()}
        cancelText="跳过此文件"
      />

      {/* ── 详情面板 ── */}
      <PluginDetailSheet
        plugin={detail}
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
        onToggle={(p, enabled) => void handleToggle(p, enabled)}
        toggling={detail !== null && togglingFile === detail.file}
      />

      {/* ── 插件市场（Modrinth 一键安装，feat-8 延伸） ── */}
      <MarketSheet
        open={marketOpen}
        onOpenChange={(o) => {
          setMarketOpen(o)
          if (!o) setMarketInitialQuery(null) // 关闭即清预填，下次手动打开回到浏览模式
        }}
        instanceId={instanceId}
        initialQuery={marketInitialQuery}
      />
    </div>
  )
}
