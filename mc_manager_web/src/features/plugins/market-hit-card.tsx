/**
 * 市场结果卡片（拆分自 market-sheet.tsx，issue 473 治理线延续，纯搬移）
 *
 * 搜索结果条目 + 内联版本面板。纯受控组件：展开/安装行为经 onToggle/onInstall
 * 回调上抛，版本数据由 MarketSheet 经 VersionsPanel 下发（同一时刻仅一个 slug
 * 展开，降低请求压力）。
 */
import { useCallback, useState } from 'react'
import {
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  Package,
} from 'lucide-react'
import type { MarketSearchHit, MarketVersion } from '@/api/types'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/mcs/status-pill'
import { formatFileSize } from '@/lib/mc-files'
import { formatRelativeTime } from '@/lib/format'
import { BUKKIT_LOADERS, MAX_VISIBLE_VERSIONS, formatCompact } from './market-config'

/** 展开状态：记录哪个 slug 展开了版本列表（同一时刻仅一个，降低请求压力） */
export interface VersionsPanel {
  slug: string
  versions: MarketVersion[]
  loading: boolean
  error: string | null
}

interface MarketHitCardProps {
  hit: MarketSearchHit
  expanded: boolean
  panel: VersionsPanel | null
  installingKey: string | null
  installedFiles: Set<string>
  onToggle: () => void
  onInstall: (version: MarketVersion) => void
}

export function MarketHitCard({
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
        expanded ? 'border-mcs-accent-border-strong' : 'border-mcs-border-muted hover:border-mcs-border-default'
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
            <StatusPill tone="success">↓ {formatCompact(hit.downloads)}</StatusPill>
          </div>
          {hit.description && (
            <p className="mt-1 line-clamp-2 text-mcs-xs text-mcs-text-muted" title={hit.description}>
              {hit.description}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {hit.categories.slice(0, 3).map((c) => (
              <StatusPill key={c} tone="muted">{c}</StatusPill>
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
            <p className="py-1.5 text-mcs-xs text-mcs-error-fg">{panel.error}</p>
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
                      <StatusPill tone="success">正式</StatusPill>
                    ) : v.versionType === 'beta' ? (
                      <StatusPill tone="warning">Beta</StatusPill>
                    ) : v.versionType === 'alpha' ? (
                      <StatusPill tone="error">Alpha</StatusPill>
                    ) : null}
                    {installedSameFile(v) && <StatusPill tone="muted">同名已安装</StatusPill>}
                    {/* loader 标签：区分 bukkit 系 / fabric / neoforge 构建产物 */}
                    {v.loaders.slice(0, 4).map((l) => (
                      <StatusPill key={l} tone={BUKKIT_LOADERS.has(l) ? 'info' : 'muted'}>
                        {l}
                      </StatusPill>
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
