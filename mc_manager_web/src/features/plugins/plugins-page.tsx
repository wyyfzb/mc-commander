/**
 * PluginsPage —— 插件管理页（feat-8 P0-5 最小闭环 + 上传/详情/批量延伸）
 * - 插件卡片列表：元数据（plugin.yml）+ 启停状态 Chip + 启停/删除操作
 * - 上传：工具栏按钮（多选 .jar 顺序上传）+ 全页拖放（dragover 高亮遮罩），
 *   XHR 进度条（可取消）；同名冲突 → 确认弹窗后 overwrite=true 重传（服务端 40912）
 * - 详情面板：行点击打开 Sheet——完整元数据（描述/主类/依赖/软依赖/官网/加载时机）+ 文件信息
 * - 批量操作：行复选框多选 → 批量启用/禁用/删除（顺序执行，逐项提示，汇总结果）
 * - 启停 = jar ↔ jar.disabled 重命名（服务端原子执行），重启实例后生效
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpFromLine,
  ExternalLink,
  FileText,
  Globe,
  Layers,
  Package,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { getFriendlyErrorText, ErrorCode } from '@/api/errors'
import { apiUploadPlugin } from '@/api/plugins'
import type { PluginInfo } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SearchInput } from '@/components/mcs/search-input'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusPill } from '@/components/mcs/status-pill'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { EmptyState } from '@/components/mcs/empty-state'
import { PageHeader } from '@/components/mcs/page-header'
import { formatFileSize, formatModifiedAt } from '@/lib/mc-files'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { MarketSheet } from './market-sheet'
import { apiCheckPluginUpdates } from '@/api/plugins'
import type { PluginUpdateStatus } from '@/api/types'
import { useDeletePlugin, usePlugins, useTogglePlugin } from './queries'

/** 同名冲突上下文：触发冲突的文件 + 上传队列剩余文件（确认覆盖后继续） */
interface UploadConflict {
  file: File
  rest: File[]
  /** 已成功数量（toast 汇总用） */
  succeeded: number
}

export function PluginsPage() {
  const instanceId = useServerStore((s) => s.instanceId)
  const navigate = useNavigate()

  const pluginsQuery = usePlugins(instanceId)
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
  /** 上传中条目（顺序队列同一时刻仅一个活跃） */
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null)
  /** 上传队列剩余数量（含活跃项） */
  const [queueRemaining, setQueueRemaining] = useState(0)
  /** 同名覆盖确认 */
  const [conflict, setConflict] = useState<UploadConflict | null>(null)
  /** 拖放悬停高亮 */
  const [dragActive, setDragActive] = useState(false)
  /** 插件市场侧滑面板 */
  const [marketOpen, setMarketOpen] = useState(false)
  /** 更新检测结果（file → status，feat-8 延伸：已装插件 vs Modrinth 最新版） */
  const [updateMap, setUpdateMap] = useState<Map<string, PluginUpdateStatus>>(new Map())
  const [updateChecking, setUpdateChecking] = useState(false)
  /** 市场预填搜索词（点「更新」时带上 plugin.yml name 直达） */
  const [marketInitialQuery, setMarketInitialQuery] = useState<string | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** 拖放嵌套计数（子元素 dragleave 会误触发，用计数法） */
  const dragDepthRef = useRef(0)
  /** 上传成功数（覆盖确认后续传时累计） */
  const uploadSucceededRef = useRef(0)
  /** 上传失败数 */
  const uploadFailedRef = useRef(0)

  /** 正在启停的插件（行按钮 loading） */
  const togglingFile = toggleMutation.isPending ? toggleMutation.variables?.file ?? null : null

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

  // 卸载时取消进行中的上传
  useEffect(() => () => uploadAbortRef.current?.abort(), [])

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

  /** 清空选择（列表变化后勾选项可能已不存在） */
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

  // ── 上传（顺序队列 + 进度 + 冲突确认） ─────────────────────

  /** 上传单个文件；40912 同名冲突时抛给调用方处理 */
  const uploadOne = useCallback(async (file: File, overwrite: boolean) => {
    if (!instanceId) return // 早退分支语义（此处尚未渲染，防御性 guard）
    setUploading({ name: file.name, pct: 0 })
    const controller = new AbortController()
    uploadAbortRef.current = controller
    try {
      const result = await apiUploadPlugin(useConnectionStore.getState(), instanceId, file, {
        overwrite,
        onProgress: (pct) => setUploading({ name: file.name, pct }),
        signal: controller.signal,
      })
      uploadSucceededRef.current += 1
      toast.success(
        result.overwritten
          ? `已覆盖上传 ${file.name}，重启实例后生效`
          : `已上传 ${file.name}${result.meta?.name ? `（${result.meta.name}）` : ''}，重启实例后生效`,
      )
    } finally {
      uploadAbortRef.current = null
    }
  }, [instanceId])

  /** 顺序上传队列：冲突时暂停并弹确认；取消/失败不阻断其余文件 */
  const runUploadQueue = useCallback(
    async (files: File[], overwrite = false, succeededBase = 0) => {
      uploadSucceededRef.current = succeededBase
      uploadFailedRef.current = 0
      const queue = [...files]
      let idx = 0
      while (idx < queue.length) {
        const file = queue[idx]
        if (!file) break // 循环条件已保证存在，noUncheckedIndexedAccess 收窄用
        setQueueRemaining(queue.length - idx)
        try {
          await uploadOne(file, overwrite)
          idx += 1
          // 覆盖模式仅对触发冲突的那一个文件生效，后续文件恢复默认防覆盖
          overwrite = false
        } catch (e) {
          if (e instanceof ApiError && e.code === ErrorCode.PLUGIN_FILE_EXISTS) {
            // 同名冲突：暂停队列，弹确认框；确认后从当前文件继续
            setConflict({ file, rest: queue.slice(idx + 1), succeeded: uploadSucceededRef.current })
            setUploading(null)
            setQueueRemaining(0)
            return
          }
          uploadFailedRef.current += 1
          toast.error(`上传 ${file.name} 失败：${getFriendlyErrorText(e)}`)
          idx += 1
        }
      }
      setUploading(null)
      setQueueRemaining(0)
      if (uploadFailedRef.current > 0) {
        toast.warning(`上传完成：成功 ${uploadSucceededRef.current} 个，失败 ${uploadFailedRef.current} 个`)
      }
      void pluginsQuery.refetch()
    },
    [uploadOne, pluginsQuery],
  )

  /** 选择/拖放入口：过滤非 .jar（逐个提示），剩余进入队列 */
  const handleFilesPicked = useCallback(
    (list: FileList | File[] | null) => {
      if (!list || list.length === 0) return
      const all = Array.from(list)
      const jars = all.filter((f) => f.name.toLowerCase().endsWith('.jar'))
      const skipped = all.length - jars.length
      if (jars.length === 0) {
        toast.error('仅支持上传 .jar 插件文件')
        return
      }
      if (skipped > 0) toast.warning(`${skipped} 个非 .jar 文件已跳过`)
      uploadSucceededRef.current = 0
      uploadFailedRef.current = 0
      void runUploadQueue(jars)
    },
    [runUploadQueue],
  )

  /** 批量启停的数据源：选中项的完整插件信息 */
  const selectedInfos = useMemo(
    () => plugins.filter((p) => selected.has(p.file)),
    [plugins, selected],
  )

  if (!instanceId) {
    return (
      <EmptyState
        icon={Package}
        title="暂无服务器实例"
        hint="请先在服务端创建 MC 服务器实例"
        action={{ label: '前往实例管理', onClick: () => navigate('/instances') }}
      />
    )
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

  const cancelUpload = () => {
    uploadAbortRef.current?.abort()
    setUploading(null)
    setQueueRemaining(0)
    toast.info('上传已取消')
  }

  const confirmOverwrite = () => {
    if (!conflict) return
    const { file, rest, succeeded } = conflict
    setConflict(null)
    void runUploadQueue([file, ...rest], true, succeeded)
  }

  const skipConflictFile = () => {
    if (!conflict) return
    const { rest, succeeded } = conflict
    uploadFailedRef.current += 1
    setConflict(null)
    if (rest.length > 0) {
      void runUploadQueue(rest, false, succeeded)
    } else {
      setUploading(null)
      setQueueRemaining(0)
      toast.warning(`上传完成：成功 ${succeeded} 个，跳过 1 个（同名冲突），失败 0 个`)
      void pluginsQuery.refetch()
    }
  }

  // ── 拖放（整页接受 .jar，计数法处理嵌套 dragleave） ────────────

  const onDragEnter = (e: React.DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault() // 允许 drop
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    handleFilesPicked(e.dataTransfer.files)
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
      className="relative flex h-full min-h-0 flex-col gap-4 p-4"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* 拖放高亮遮罩 */}
      {dragActive && (
        <div
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-mcs-md border-2 border-dashed border-mcs-accent bg-mcs-accent/5"
          data-testid="drop-overlay"
        >
          <div className="flex flex-col items-center gap-2 text-mcs-accent">
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
        title="插件管理"
        description={
          <>
            管理 Bukkit 系插件（Paper/Spigot）：启停与增删在重启实例后生效
            {plugins.length > 0 && (
              <span className="ml-2 text-mcs-text-muted">
                共 {plugins.length} 个（启用 {enabledCount} / 禁用 {plugins.length - enabledCount}）
              </span>
            )}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void pluginsQuery.refetch()}
              disabled={pluginsQuery.isFetching}
              aria-label="刷新插件列表"
            >
              <RefreshCw className={`size-3.5 ${pluginsQuery.isFetching ? 'animate-spin' : ''}`} aria-hidden />
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
              <RefreshCw className={`size-3.5 ${updateChecking ? 'animate-spin' : ''}`} aria-hidden />
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
        <div
          className="flex items-center gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted px-4 py-3"
          data-testid="upload-progress"
          aria-live="polite"
        >
          <FileText className="size-4 shrink-0 text-mcs-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-mcs-sm text-mcs-text-default" title={uploading.name}>
                正在上传 {uploading.name}
                {queueRemaining > 1 && (
                  <span className="ml-1.5 text-mcs-xs text-mcs-text-subtle">（队列剩余 {queueRemaining - 1} 个）</span>
                )}
              </p>
              <span className="text-mcs-xs tabular-nums text-mcs-text-muted">{uploading.pct}%</span>
            </div>
            <div
              role="progressbar"
              aria-label="上传进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={uploading.pct}
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-mcs-bg-hover"
            >
              <div
                className="h-full rounded-full bg-mcs-accent transition-[width] duration-mcs-base"
                style={{ width: `${uploading.pct}%` }}
              />
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={cancelUpload}>
            <X className="size-3.5" aria-hidden />
            取消
          </Button>
        </div>
      )}

      {/* ── 批量操作条 ── */}
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted px-4 py-2.5"
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
        </div>
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
      {pluginsQuery.isPending ? (
        <div className="space-y-2" data-testid="plugin-skeletons" aria-label="加载插件中">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-mcs-md border border-mcs-border-muted p-4">
              <Skeleton className="size-9 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : pluginsQuery.isError ? (
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
                <code className="text-mcs-text-muted">plugins/</code> 目录，首次启动实例后会生成该目录
              </>
            }
            action={{ label: '上传插件', onClick: () => fileInputRef.current?.click() }}
          />
          <div className="mt-3 flex justify-center">
            <Button variant="link" size="sm" onClick={() => setMarketOpen(true)} data-testid="open-market-empty">
              <Store className="size-3.5" aria-hidden />
              或从插件市场一键安装
            </Button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-4 py-12 text-center text-mcs-text-muted">
          <Search className="size-8 opacity-60" aria-hidden />
          <p className="mt-1 text-mcs-sm">无匹配插件</p>
          <p className="text-mcs-xs text-mcs-text-subtle">换个关键词试试</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="overflow-hidden rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
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
          </div>
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
          if (!open) setConflict(null)
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

interface PluginRowProps {
  plugin: PluginInfo
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  toggling: boolean
  deleting: boolean
  onToggle: (plugin: PluginInfo, enabled: boolean) => Promise<void>
  onDelete: () => void
  onOpenDetail: () => void
  /** 更新检测结果（未检测/未收录为 undefined；hasNewer=true 展示「可更新」徽章） */
  updateInfo?: PluginUpdateStatus
  /** 点击「更新」：打开市场并预填搜索 */
  onUpdate: (plugin: PluginInfo) => void
}

/** 单行插件卡片：复选框 + 元数据主列 + 状态/操作列；行点击打开详情 */
function PluginRow({ plugin, checked, onCheckedChange, toggling, deleting, onToggle, onDelete, onOpenDetail, updateInfo, onUpdate }: PluginRowProps) {
  const displayName = plugin.meta?.name ?? plugin.name
  const version = plugin.meta?.version
  const apiVersion = plugin.meta?.apiVersion
  const authors = plugin.meta?.authors ?? []
  const depend = plugin.meta?.depend ?? []

  return (
    <li
      className="flex cursor-pointer items-start gap-3 p-4 transition-colors hover:bg-mcs-bg-hover"
      onClick={onOpenDetail}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenDetail()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`查看插件 ${displayName} 详情`}
    >
      {/* 复选框（阻止行点击） */}
      <div
        className="mt-1 flex items-center"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <Checkbox
          checked={checked}
          onCheckedChange={(c) => onCheckedChange(c === true)}
          aria-label={`选择 ${displayName}`}
        />
      </div>

      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-default">
        <Package className="size-4 text-mcs-text-muted" aria-hidden />
      </div>

      {/* 主列：名称 + 元数据 */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-mcs-sm font-medium text-mcs-text-default" title={displayName}>
            {displayName}
          </span>
          {version && <StatusPill tone="muted">v{version}</StatusPill>}
          {apiVersion && <StatusPill tone="info">API {apiVersion}</StatusPill>}
          <StatusPill tone={plugin.enabled ? 'success' : 'muted'}>
            {plugin.enabled ? '已启用' : '已禁用'}
          </StatusPill>
          {updateInfo?.hasNewer && (
            <button
              type="button"
              data-testid="update-badge"
              className="rounded-full bg-mcs-accent-bg-subtle px-2 py-0.5 text-mcs-2xs font-medium text-mcs-accent-fg transition-colors duration-mcs-fast hover:bg-mcs-accent-bg"
              onClick={(e) => {
                e.stopPropagation()
                onUpdate(plugin)
              }}
              title={`Modrinth 最新版 ${updateInfo.latestVersion ?? ''}，点击前往市场更新`}
            >
              可更新 → {updateInfo.latestVersion}
            </button>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-mcs-xs text-mcs-text-subtle">
          <span className="truncate font-mono" title={plugin.file}>{plugin.file}</span>
          <span>{formatFileSize(plugin.sizeBytes)}</span>
          <span>{formatModifiedAt(new Date(plugin.mtimeMs).toISOString())} 修改</span>
          {authors.length > 0 && <span className="truncate">作者 {authors.join(', ')}</span>}
        </div>
        {depend.length > 0 && (
          <div className="mt-1 text-mcs-xs text-mcs-text-subtle">
            依赖：{depend.join('、')}
            <span className="ml-1 opacity-70">（不做自动解析，缺失时插件可能无法加载）</span>
          </div>
        )}
      </div>

      {/* 操作列：启停 + 删除（阻止行点击冒泡） */}
      <div
        className="flex shrink-0 items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        {plugin.enabled ? (
          <Button
            variant="outline"
            size="sm"
            disabled={toggling}
            onClick={() => void onToggle(plugin, false)}
            aria-label={`禁用 ${displayName}`}
            title="禁用（重启实例后生效）"
          >
            <PowerOff className="size-3.5" aria-hidden />
            禁用
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={toggling}
            onClick={() => void onToggle(plugin, true)}
            aria-label={`启用 ${displayName}`}
            title="启用（重启实例后生效）"
          >
            <Power className="size-3.5" aria-hidden />
            启用
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={deleting}
          onClick={onDelete}
          aria-label={`删除 ${displayName}`}
          className="text-mcs-error-fg hover:text-mcs-error-fg"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
    </li>
  )
}

interface PluginDetailSheetProps {
  plugin: PluginInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onToggle: (plugin: PluginInfo, enabled: boolean) => void
  toggling: boolean
}

const LOAD_LABEL: Record<string, string> = {
  STARTUP: 'STARTUP（世界加载前）',
  POSTWORLD: 'POSTWORLD（世界加载后，默认）',
}

/** 插件详情面板：完整元数据 + 文件信息 + 行内启停 */
function PluginDetailSheet({ plugin, open, onOpenChange, onToggle, toggling }: PluginDetailSheetProps) {
  if (!plugin) return null
  const meta = plugin.meta
  const displayName = meta?.name ?? plugin.name

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            <span className="truncate">{displayName}</span>
            <StatusPill tone={plugin.enabled ? 'success' : 'muted'}>
              {plugin.enabled ? '已启用' : '已禁用'}
            </StatusPill>
          </SheetTitle>
          <SheetDescription className="font-mono text-mcs-xs">{plugin.file}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 px-4 pb-6">
          {/* 描述 */}
          {meta?.description && (
            <p className="text-mcs-sm leading-relaxed text-mcs-text-muted">{meta.description}</p>
          )}

          {/* 基本信息 */}
          <section className="space-y-2.5" aria-label="基本信息">
            <h3 className="flex items-center gap-1.5 text-mcs-xs font-semibold text-mcs-text-subtle">
              <Layers className="size-3.5" aria-hidden />
              基本信息
            </h3>
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-mcs-sm">
              {meta?.version && (
                <>
                  <dt className="shrink-0 text-mcs-text-subtle">版本</dt>
                  <dd className="text-mcs-text-default">
                    <StatusPill tone="muted">v{meta.version}</StatusPill>
                  </dd>
                </>
              )}
              {meta?.apiVersion && (
                <>
                  <dt className="shrink-0 text-mcs-text-subtle">API 版本</dt>
                  <dd className="text-mcs-text-default">
                    <StatusPill tone="info">API {meta.apiVersion}</StatusPill>
                  </dd>
                </>
              )}
              {meta?.load && (
                <>
                  <dt className="shrink-0 text-mcs-text-subtle">加载时机</dt>
                  <dd className="text-mcs-text-default">{LOAD_LABEL[meta.load] ?? meta.load}</dd>
                </>
              )}
              {meta?.main && (
                <>
                  <dt className="shrink-0 text-mcs-text-subtle">主类</dt>
                  <dd className="break-all font-mono text-mcs-xs text-mcs-text-muted">{meta.main}</dd>
                </>
              )}
              {(meta?.authors?.length ?? 0) > 0 && (
                <>
                  <dt className="shrink-0 text-mcs-text-subtle">作者</dt>
                  <dd className="text-mcs-text-default">{meta!.authors.join('、')}</dd>
                </>
              )}
              {meta?.website && (
                <>
                  <dt className="shrink-0 text-mcs-text-subtle">官网</dt>
                  <dd>
                    <a
                      href={meta.website}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-mcs-accent hover:underline"
                    >
                      <Globe className="size-3.5" aria-hidden />
                      {meta.website}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </section>

          {/* 依赖 */}
          {((meta?.depend?.length ?? 0) > 0 || (meta?.softdepend?.length ?? 0) > 0) && (
            <section className="space-y-2.5" aria-label="依赖关系">
              <h3 className="text-mcs-xs font-semibold text-mcs-text-subtle">依赖关系</h3>
              {(meta?.depend?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <p className="text-mcs-xs text-mcs-text-subtle">硬依赖（缺失时插件无法加载）</p>
                  <div className="flex flex-wrap gap-1.5">
                    {meta!.depend.map((d) => (
                      <StatusPill key={d} tone="warning">{d}</StatusPill>
                    ))}
                  </div>
                </div>
              )}
              {(meta?.softdepend?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <p className="text-mcs-xs text-mcs-text-subtle">软依赖（缺失不影响加载）</p>
                  <div className="flex flex-wrap gap-1.5">
                    {meta!.softdepend.map((d) => (
                      <StatusPill key={d} tone="muted">{d}</StatusPill>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 文件信息 */}
          <section className="space-y-2.5" aria-label="文件信息">
            <h3 className="text-mcs-xs font-semibold text-mcs-text-subtle">文件信息</h3>
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-mcs-sm">
              <dt className="shrink-0 text-mcs-text-subtle">大小</dt>
              <dd className="text-mcs-text-default">{formatFileSize(plugin.sizeBytes)}</dd>
              <dt className="shrink-0 text-mcs-text-subtle">修改时间</dt>
              <dd className="text-mcs-text-default">
                {formatModifiedAt(new Date(plugin.mtimeMs).toISOString())}
              </dd>
              <dt className="shrink-0 text-mcs-text-subtle">路径</dt>
              <dd className="break-all font-mono text-mcs-xs text-mcs-text-muted">plugins/{plugin.file}</dd>
            </dl>
          </section>

          <div className="mt-auto flex items-center gap-2 pt-2">
            {plugin.enabled ? (
              <Button
                variant="outline"
                size="sm"
                disabled={toggling}
                onClick={() => onToggle(plugin, false)}
                className="flex-1"
              >
                <PowerOff className="size-3.5" aria-hidden />
                禁用插件
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={toggling}
                onClick={() => onToggle(plugin, true)}
                className="flex-1"
              >
                <Power className="size-3.5" aria-hidden />
                启用插件
              </Button>
            )}
          </div>
          <p className="-mt-3 text-center text-mcs-xs text-mcs-text-subtle">
            启停与增删在重启实例后生效（Bukkit 插件仅启动时加载）
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
