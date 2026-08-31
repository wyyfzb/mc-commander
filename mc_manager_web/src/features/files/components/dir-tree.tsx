/**
 * DirTree —— 文件页左侧目录树
 * - 根节点「/」（实例根目录，Home 图标）+ 子目录逐层懒加载：子节点仅在父节点展开后挂载，
 *   由 useFileList(instanceId, dirPath) 按需拉取对应目录列表
 * - 展开态为本地 useState Set<string>（存放已展开目录路径）
 * - 只显示目录（filter type === 'directory'）；加载中子目录显示 Skeleton 行；
 *   已知叶子目录（无子目录）不显示展开箭头
 * - 点击目录名 → onNavigate(path)（父组件负责切换到该目录为主视图）；
 *   当前路径节点高亮（accent 文字 + bg-subtle 底）
 * - 宽约 220px，ScrollArea 滚动；设计纪律：全部 --mcs-* 语义 token，禁硬编码色值/间距
 */
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderX, Home } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useFileList } from '../queries'
import type { FileEntry } from '@/api/types'

export interface DirTreeProps {
  instanceId: string
  /** 当前主视图目录（'/' 前缀风格），用于节点高亮 */
  currentPath: string
  /** 点击目录名 → 跳转到该目录（主视图） */
  onNavigate: (path: string) => void
}

interface DirTreeNodeProps {
  instanceId: string
  /** 目录完整路径（'/' 前缀风格） */
  dirPath: string
  /** 节点显示名（根节点为 '/'） */
  name: string
  /** 树深度（根为 0，用于缩进） */
  depth: number
  currentPath: string
  expanded: Set<string>
  onToggle: (path: string) => void
  onNavigate: (path: string) => void
}

/** 树节点（递归）：挂载即拉取自身目录列表（父节点展开后才挂载 → 逐层懒加载） */
function DirTreeNode({
  instanceId,
  dirPath,
  name,
  depth,
  currentPath,
  expanded,
  onToggle,
  onNavigate,
}: DirTreeNodeProps) {
  const { data, isLoading, isError, refetch } = useFileList(instanceId, dirPath)
  const isRoot = dirPath === '/'
  const isExpanded = expanded.has(dirPath)
  const isActive = currentPath === dirPath
  /** 可读节点名（根节点显示 '/'，无障碍标签用「实例根目录」） */
  const displayName = isRoot ? '实例根目录' : name

  /** 子目录列表（列表响应可能命中文件单信息响应，用 'files' in data 收窄） */
  const subDirs = useMemo<FileEntry[]>(() => {
    if (!data || !('files' in data)) return []
    return data.files.filter((f) => f.type === 'directory')
  }, [data])

  /** 是否已知有子目录：true=有 / false=叶子（无箭头）/ null=未知（加载中，先给箭头） */
  const hasChildren = data == null ? null : subDirs.length > 0

  return (
    <div>
      <div
        className="group flex items-center"
        style={{ paddingLeft: `calc(var(--mcs-space-2) + var(--mcs-space-3) * ${depth})` }}
      >
        {hasChildren === false ? (
          // 叶子目录：无子项不显示箭头（占位保持对齐）
          <span className="flex w-[18px] shrink-0 justify-center" aria-hidden />
        ) : (
          <button
            type="button"
            aria-label={`${isExpanded ? '折叠' : '展开'} ${displayName}`}
            aria-expanded={isExpanded}
            onClick={() => onToggle(dirPath)}
            className="flex h-6 w-[18px] shrink-0 items-center justify-center rounded-sm text-mcs-text-muted transition-colors duration-mcs-fast hover:text-mcs-text-default focus-visible:ring-2 focus-visible:ring-mcs-focus-ring"
          >
            {isExpanded ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
          </button>
        )}
        <button
          type="button"
          aria-current={isActive ? 'location' : undefined}
          onClick={() => onNavigate(dirPath)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-mcs-sm transition-colors duration-mcs-fast',
            isActive
              ? 'bg-mcs-accent-bg-subtle font-medium text-mcs-accent-fg'
              : 'text-mcs-text-default hover:bg-mcs-bg-hover',
          )}
        >
          {isRoot ? (
            <Home className="size-4 shrink-0 text-mcs-accent-fg" aria-hidden />
          ) : (
            <Folder className="size-4 shrink-0 text-mcs-warning-fg" aria-hidden />
          )}
          <span className="truncate">{name}</span>
        </button>
      </div>
      {isExpanded && (
        <div>
          {isLoading && !data && (
            <div
              className="space-y-1 py-1"
              style={{ paddingLeft: `calc(var(--mcs-space-2) + var(--mcs-space-3) * ${depth + 1})` }}
            >
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-5 w-3/5" />
            </div>
          )}
          {isError && !isLoading && (
            <button
              type="button"
              onClick={() => void refetch()}
              className="flex w-full items-center gap-1 py-1 text-mcs-2xs text-mcs-error-fg hover:underline"
              style={{ paddingLeft: `calc(var(--mcs-space-2) + var(--mcs-space-3) * ${depth + 1})` }}
            >
              <FolderX className="size-3.5 shrink-0" aria-hidden />
              目录加载失败 · 点击重试
            </button>
          )}
          {!isLoading && !isError && subDirs.map((dir) => (
            <DirTreeNode
              key={dir.path}
              instanceId={instanceId}
              dirPath={dir.path}
              name={dir.name}
              depth={depth + 1}
              currentPath={currentPath}
              expanded={expanded}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function DirTree({ instanceId, currentPath, onNavigate }: DirTreeProps) {
  /** 已展开目录路径集合（本地 UI 态，不持久化） */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <ScrollArea className="h-full w-[220px] shrink-0">
      <div className="py-1 pr-1">
        <DirTreeNode
          instanceId={instanceId}
          dirPath="/"
          name="/"
          depth={0}
          currentPath={currentPath}
          expanded={expanded}
          onToggle={toggle}
          onNavigate={onNavigate}
        />
      </div>
    </ScrollArea>
  )
}
