/**
 * PluginDetailSheet —— 插件详情侧滑面板（自 plugins-page.tsx 迁出，纯移动零行为变更）
 * 完整元数据（描述/主类/依赖/软依赖/官网/加载时机）+ 文件信息 + 行内启停
 */
import { ExternalLink, Globe, Layers, Power, PowerOff } from 'lucide-react'
import type { PluginInfo } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { StatusPill } from '@/components/mcs/status-pill'
import { formatFileSize, formatModifiedAt } from '@/lib/mc-files'

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
export function PluginDetailSheet({
  plugin,
  open,
  onOpenChange,
  onToggle,
  toggling,
}: PluginDetailSheetProps) {
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
            <h3 className="flex items-center gap-1.5 text-mcs-xs font-semibold text-mcs-text-muted">
              <Layers className="size-3.5" aria-hidden />
              基本信息
            </h3>
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-mcs-sm">
              {meta?.version && (
                <>
                  <dt className="shrink-0 text-mcs-text-muted">版本</dt>
                  <dd className="text-mcs-text-default">
                    <StatusPill tone="muted">v{meta.version}</StatusPill>
                  </dd>
                </>
              )}
              {meta?.apiVersion && (
                <>
                  <dt className="shrink-0 text-mcs-text-muted">API 版本</dt>
                  <dd className="text-mcs-text-default">
                    <StatusPill tone="info">API {meta.apiVersion}</StatusPill>
                  </dd>
                </>
              )}
              {meta?.load && (
                <>
                  <dt className="shrink-0 text-mcs-text-muted">加载时机</dt>
                  <dd className="text-mcs-text-default">{LOAD_LABEL[meta.load] ?? meta.load}</dd>
                </>
              )}
              {meta?.main && (
                <>
                  <dt className="shrink-0 text-mcs-text-muted">主类</dt>
                  <dd className="break-all font-mono text-mcs-xs text-mcs-text-muted">
                    {meta.main}
                  </dd>
                </>
              )}
              {(meta?.authors?.length ?? 0) > 0 && (
                <>
                  <dt className="shrink-0 text-mcs-text-muted">作者</dt>
                  <dd className="text-mcs-text-default">{meta!.authors.join('、')}</dd>
                </>
              )}
              {meta?.website && (
                <>
                  <dt className="shrink-0 text-mcs-text-muted">官网</dt>
                  <dd>
                    <a
                      href={meta.website}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-mcs-accent-fg hover:underline"
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
              <h3 className="text-mcs-xs font-semibold text-mcs-text-muted">依赖关系</h3>
              {(meta?.depend?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <p className="text-mcs-xs text-mcs-text-muted">硬依赖（缺失时插件无法加载）</p>
                  <div className="flex flex-wrap gap-1.5">
                    {meta!.depend.map((d) => (
                      <StatusPill key={d} tone="warning">
                        {d}
                      </StatusPill>
                    ))}
                  </div>
                </div>
              )}
              {(meta?.softdepend?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <p className="text-mcs-xs text-mcs-text-muted">软依赖（缺失不影响加载）</p>
                  <div className="flex flex-wrap gap-1.5">
                    {meta!.softdepend.map((d) => (
                      <StatusPill key={d} tone="muted">
                        {d}
                      </StatusPill>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 文件信息 */}
          <section className="space-y-2.5" aria-label="文件信息">
            <h3 className="text-mcs-xs font-semibold text-mcs-text-muted">文件信息</h3>
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-mcs-sm">
              <dt className="shrink-0 text-mcs-text-muted">大小</dt>
              <dd className="text-mcs-text-default">{formatFileSize(plugin.sizeBytes)}</dd>
              <dt className="shrink-0 text-mcs-text-muted">修改时间</dt>
              <dd className="text-mcs-text-default">
                {formatModifiedAt(new Date(plugin.mtimeMs).toISOString())}
              </dd>
              <dt className="shrink-0 text-mcs-text-muted">路径</dt>
              <dd className="break-all font-mono text-mcs-xs text-mcs-text-muted">
                plugins/{plugin.file}
              </dd>
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
          <p className="-mt-3 text-center text-mcs-xs text-mcs-text-muted">
            启停与增删在重启实例后生效（Bukkit 插件仅启动时加载）
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
