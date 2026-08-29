/**
 * PluginsPage —— 插件管理页（feat-8 P0-5 最小闭环：列表 / 启停 / 删除）
 * - 插件卡片列表：元数据（plugin.yml）+ 启停状态 Chip + 启停/删除操作
 * - 启停 = jar ↔ jar.disabled 重命名（服务端原子执行），重启实例后生效
 * - 搜索过滤 + 启用/禁用统计；空目录引导前往文件页上传
 * - 上传走文件管理页（同一 plugins 目录），此处保持最小闭环范围
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Package,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import type { PluginInfo } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Chip } from '@/components/mcs/chip'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { EmptyState } from '@/components/mcs/empty-state'
import { formatFileSize, formatModifiedAt } from '@/lib/mc-files'
import { useServerStore } from '@/stores/server'
import { useDeletePlugin, usePlugins, useTogglePlugin } from './queries'

export function PluginsPage() {
  const instanceId = useServerStore((s) => s.instanceId)
  const navigate = useNavigate()

  const pluginsQuery = usePlugins(instanceId)
  const toggleMutation = useTogglePlugin(instanceId)
  const deleteMutation = useDeletePlugin(instanceId)

  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<PluginInfo | null>(null)
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

  /** 启停：成功 toast 强调"重启实例后生效"（Bukkit 插件仅启动时加载） */
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      {/* ── 页面头：标题 + 刷新 ── */}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-mcs-xl font-semibold text-mcs-text-default">插件管理</h2>
          <p className="text-mcs-xs text-mcs-text-subtle">
            管理 Bukkit 系插件（Paper/Spigot）：启停与增删在重启实例后生效
            {plugins.length > 0 && (
              <span className="ml-2 text-mcs-text-muted">
                共 {plugins.length} 个（启用 {enabledCount} / 禁用 {plugins.length - enabledCount}）
              </span>
            )}
          </p>
        </div>
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
      </div>

      {/* ── 搜索（多插件时快速定位；过滤不改变统计数字） ── */}
      {plugins.length > 5 && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-mcs-text-subtle" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索插件名或文件名…"
            className="pl-8"
            aria-label="搜索插件"
          />
        </div>
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
      ) : plugins.length === 0 ? (
        <EmptyState
          icon={Package}
          title="暂无插件"
          hint={
            <>
              将插件 jar 放入实例 <code className="text-mcs-text-muted">plugins/</code> 目录（可通过文件管理页上传），
              首次启动实例后会生成该目录
            </>
          }
          action={{ label: '前往文件管理', onClick: () => navigate('/files') }}
        />
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
                  toggling={togglingFile === plugin.file}
                  deleting={deleteMutation.isPending && deleteMutation.variables === plugin.file}
                  onToggle={handleToggle}
                  onDelete={() => setDeleteTarget(plugin)}
                />
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ── 删除确认 ── */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`删除插件 ${deleteTarget?.name ?? ''}`}
        description={`将永久删除文件 ${deleteTarget?.file ?? ''}。此操作不可恢复。`}
        confirmText="删除"
        danger
        onConfirm={() => void handleDeleteConfirm()}
      />
    </div>
  )
}

interface PluginRowProps {
  plugin: PluginInfo
  toggling: boolean
  deleting: boolean
  onToggle: (plugin: PluginInfo, enabled: boolean) => Promise<void>
  onDelete: () => void
}

/** 单行插件卡片：元数据主列 + 状态/操作列 */
function PluginRow({ plugin, toggling, deleting, onToggle, onDelete }: PluginRowProps) {
  const displayName = plugin.meta?.name ?? plugin.name
  const version = plugin.meta?.version
  const apiVersion = plugin.meta?.apiVersion
  const authors = plugin.meta?.authors ?? []
  const depend = plugin.meta?.depend ?? []

  return (
    <li className="flex items-start gap-3 p-4">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-default">
        <Package className="size-4 text-mcs-text-muted" aria-hidden />
      </div>

      {/* 主列：名称 + 元数据 */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-mcs-sm font-medium text-mcs-text-default" title={displayName}>
            {displayName}
          </span>
          {version && <Chip tone="muted">v{version}</Chip>}
          {apiVersion && <Chip tone="info">API {apiVersion}</Chip>}
          <Chip tone={plugin.enabled ? 'success' : 'muted'}>
            {plugin.enabled ? '已启用' : '已禁用'}
          </Chip>
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

      {/* 操作列：启停 + 删除 */}
      <div className="flex shrink-0 items-center gap-1.5">
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
