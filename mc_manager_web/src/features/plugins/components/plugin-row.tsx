/**
 * PluginRow —— 插件列表单行卡片（自 plugins-page.tsx 迁出，纯移动零行为变更）
 * 复选框 + 元数据主列 + 状态/操作列；行点击打开详情
 */
import { Package, Power, PowerOff, Trash2 } from 'lucide-react'
import type { PluginInfo, PluginUpdateStatus } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { StatusPill } from '@/components/mcs/status-pill'
import { formatFileSize, formatModifiedAt } from '@/lib/mc-files'

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

export function PluginRow({ plugin, checked, onCheckedChange, toggling, deleting, onToggle, onDelete, onOpenDetail, updateInfo, onUpdate }: PluginRowProps) {
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
