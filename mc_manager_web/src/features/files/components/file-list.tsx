/**
 * FileList —— 文件页中间文件列表
 * - 数据自取：useFileList(instanceId, dir)（目录为目标时返回 files 数组）
 * - 面包屑内置：由 dir 渲染——根 Home 可点 + 逐级可点，最后一级加粗（aria-current=page），
 *   点击均走 onOpenDir 跳转
 * - 行：图标（目录 folder 黄色 --mcs-warning-fg；文件按扩展名映射）+ 名称 + 副行
 *   （目录「文件夹 · MM-DD HH:mm」/ 文件「大小 · 修改时间」，B/KB/MB 一位小数格式化在组件内）
 * - 目录行单击 onOpenDir 进入；文件行单击 onSelectFile（选中态 bg-accent-bg-subtle）；
 *   行尾操作：文件有编辑按钮（同 onSelectFile 打开编辑器），全部有删除按钮（error 色）
 * - 空态：根目录「该实例根目录下没有文件」/ 子目录「此文件夹为空」；加载显示 Skeleton 行
 * - 设计纪律：全部 --mcs-* 语义 token；表格/列表实底，禁硬编码色值/间距/圆角
 */
import { Fragment, useMemo } from 'react'
import {
  Archive,
  ArrowUp,
  Braces,
  ChevronRight,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Home,
  Image,
  Inbox,
  Pencil,
  RefreshCw,
  Settings,
  Trash2,
  TextCursorInput,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useFileList } from '../queries'
import type { FileEntry } from '@/api/types'

export interface FileListProps {
  instanceId: string
  /** 当前目录（'/' 前缀风格；面包屑由此渲染） */
  dir: string
  /** 当前选中文件路径（null=未选中） */
  selectedPath: string | null
  /** 点击文件行 / 编辑按钮 → 打开编辑器 */
  onSelectFile: (path: string) => void
  /** 点击目录行 / 面包屑 → 进入目录 */
  onOpenDir: (path: string) => void
  /** 点击删除按钮（文件或目录；删除确认由父组件负责） */
  onDelete: (entry: FileEntry) => void
  /** 工具栏「刷新」：重新拉取当前目录列表（父组件失效 query） */
  onRefresh?: () => void
  /** 工具栏「上级」：跳转父目录（根目录时父组件隐藏该按钮） */
  onGoUp?: () => void
  /** 工具栏「新建文件」：打开新建文件对话框（父组件负责） */
  onNewFile?: () => void
  /** 工具栏「上传文件」：打开文件选择器（父组件负责 multipart 上传） */
  onUpload?: () => void
  /** 工具栏「新建目录」：创建目录对话框 */
  onCreateDirectory?: () => void
  /** 行级「重命名」 */
  onRename?: (entry: FileEntry) => void
}

/** 文件大小格式化：B / KB / MB 一位小数 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 修改时间格式化：MM-DD HH:mm 本地时区；非法时间返回 '-' */
export function formatModifiedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 文件类型 → 图标名（扩展名映射；目录恒为 folder） */
export function fileIconName(entry: Pick<FileEntry, 'name' | 'isDirectory'>): string {
  if (entry.isDirectory) return 'folder'
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'properties' || ext === 'txt' || ext === 'log') return 'file-text'
  if (ext === 'json') return 'braces'
  if (ext === 'yml' || ext === 'yaml') return 'settings'
  if (ext === 'jar') return 'archive'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif') return 'image'
  return 'file'
}

const FILE_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  'file-text': FileText,
  braces: Braces,
  settings: Settings,
  archive: Archive,
  image: Image,
  file: File,
}

interface FileListRowProps {
  entry: FileEntry
  isSelected: boolean
  onSelectFile: (path: string) => void
  onOpenDir: (path: string) => void
  onDelete: (entry: FileEntry) => void
  /** 行级「重命名」（未提供则不渲染按钮） */
  onRename?: (entry: FileEntry) => void
}

function FileListRow({ entry, isSelected, onSelectFile, onOpenDir, onDelete, onRename }: FileListRowProps) {
  const Icon = FILE_ICONS[fileIconName(entry)] ?? File
  const isDir = entry.isDirectory

  const handleRowClick = () => {
    if (isDir) onOpenDir(entry.path)
    else onSelectFile(entry.path)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={isDir ? `打开目录 ${entry.name}` : `选择文件 ${entry.name}`}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleRowClick()
        }
      }}
      className={cn(
        'flex cursor-pointer items-center gap-3 px-4 py-2 transition-colors duration-mcs-fast focus-visible:bg-mcs-bg-hover',
        isDir ? 'hover:bg-mcs-bg-hover' : cn('hover:bg-mcs-bg-hover', isSelected && 'bg-mcs-accent-bg-subtle'),
      )}
    >
      <Icon
        data-testid={`file-icon-${entry.name}`}
        className={cn('size-5 shrink-0', isDir ? 'text-mcs-warning-fg' : 'text-mcs-text-muted')}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-mcs-sm font-medium text-mcs-text-default">{entry.name}</div>
        <div className="mt-0.5 truncate text-mcs-xs text-mcs-text-muted">
          {isDir
            ? `文件夹 · ${formatModifiedAt(entry.modifiedAt)}`
            : `${formatFileSize(entry.size)} · ${formatModifiedAt(entry.modifiedAt)}`}
        </div>
      </div>
      {!isDir && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`编辑 ${entry.name}`}
          className="text-mcs-text-muted hover:text-mcs-text-default"
          onClick={(e) => {
            e.stopPropagation()
            onSelectFile(entry.path)
          }}
        >
          <Pencil className="size-3.5" aria-hidden />
        </Button>
      )}
      {onRename && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`重命名 ${entry.name}`}
          title="重命名"
          className="text-mcs-text-muted hover:text-mcs-text-default"
          onClick={(e) => {
            e.stopPropagation()
            onRename(entry)
          }}
        >
          <TextCursorInput className="size-3.5" aria-hidden />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`删除 ${entry.name}`}
        className="text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(entry)
        }}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}

export function FileList({
  instanceId,
  dir,
  selectedPath,
  onSelectFile,
  onOpenDir,
  onDelete,
  onRefresh,
  onGoUp,
  onNewFile,
  onUpload,
  onCreateDirectory,
  onRename,
}: FileListProps) {
  const { data, isLoading, isError } = useFileList(instanceId, dir)

  /** 规范化目录：去除尾部斜杠（根目录保持 '/'） */
  const normalizedDir = dir === '/' ? '/' : dir.replace(/\/+$/, '') || '/'

  /** 面包屑段落：由 dir 拆解（根 Home 独立渲染，不在此列） */
  const crumbs = useMemo(() => {
    const parts = normalizedDir.split('/').filter(Boolean)
    return parts.map((p, i) => ({ label: p, path: `/${parts.slice(0, i + 1).join('/')}` }))
  }, [normalizedDir])

  /** 目录在前（同组保持服务端顺序；现代引擎稳定排序） */
  const entries = useMemo<FileEntry[]>(() => {
    if (!data || !('files' in data)) return []
    return [...data.files].sort((a, b) => (a.isDirectory === b.isDirectory ? 0 : a.isDirectory ? -1 : 1))
  }, [data])

  const isEmpty = data !== undefined && data.isDirectory === true && data.files.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 面包屑：根 Home 可点 + 逐级可点，最后一级加粗 */}
      <nav
        aria-label="面包屑"
        className="flex h-10 shrink-0 items-center gap-1 border-b border-mcs-border-subtle px-4"
      >
        {crumbs.length === 0 ? (
          <span className="flex items-center gap-1.5 font-semibold text-mcs-text-default">
            <Home className="size-4 text-mcs-accent-fg" aria-hidden />
            <span>根目录</span>
          </span>
        ) : (
          <Fragment>
            <button
              type="button"
              aria-label="根目录"
              onClick={() => onOpenDir('/')}
              className="flex items-center rounded-sm p-0.5 text-mcs-accent-fg transition-colors duration-mcs-fast hover:bg-mcs-bg-hover"
            >
              <Home className="size-4" aria-hidden />
            </button>
            {crumbs.map((c, i) => {
              const isLast = i === crumbs.length - 1
              return (
                <Fragment key={c.path}>
                  <ChevronRight className="size-3.5 shrink-0 text-mcs-text-subtle" aria-hidden />
                  {isLast ? (
                    <span
                      aria-current="page"
                      className="max-w-44 truncate font-semibold text-mcs-text-default"
                    >
                      {c.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpenDir(c.path)}
                      className="max-w-44 truncate rounded-sm px-1 py-0.5 text-mcs-accent-fg transition-colors duration-mcs-fast hover:bg-mcs-bg-hover"
                    >
                      {c.label}
                    </button>
                  )}
                </Fragment>
              )
            })}
          </Fragment>
        )}
        {/* 工具栏：上级 / 刷新 / 新建文件（未提供回调则不渲染对应按钮） */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {onGoUp && normalizedDir !== '/' && (
            <Button variant="ghost" size="icon-sm" aria-label="上级目录" title="上级目录" onClick={onGoUp}>
              <ArrowUp aria-hidden />
            </Button>
          )}
          {onRefresh && (
            <Button variant="ghost" size="icon-sm" aria-label="刷新" title="刷新" onClick={onRefresh}>
              <RefreshCw aria-hidden />
            </Button>
          )}
          {onNewFile && (
            <Button variant="ghost" size="icon-sm" aria-label="新建文件" title="新建文件" onClick={onNewFile}>
              <FilePlus aria-hidden />
            </Button>
          )}
          {onCreateDirectory && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="新建目录"
              title="新建目录"
              onClick={onCreateDirectory}
            >
              <FolderPlus aria-hidden />
            </Button>
          )}
          {onUpload && (
            <Button variant="ghost" size="icon-sm" aria-label="上传文件" title="上传文件到实例根目录" onClick={onUpload}>
              <Upload aria-hidden />
            </Button>
          )}
        </div>
      </nav>

      {/* 文件列表（实底；玻璃禁区） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && (
          <div className="space-y-1 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className="size-5 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!isLoading && isError && (
          <p className="px-4 py-10 text-center text-mcs-sm text-mcs-text-muted">加载失败，请稍后重试</p>
        )}
        {!isLoading && !isError && isEmpty && (
          <div className="flex flex-col items-center gap-2 py-12 text-mcs-text-muted">
            <Inbox className="size-8 opacity-60" aria-hidden />
            <p className="text-mcs-sm">{normalizedDir === '/' ? '该实例根目录下没有文件' : '此文件夹为空'}</p>
            {onNewFile && (
              <div className="flex items-center gap-2">
                {onCreateDirectory && (
                  <Button variant="outline" size="sm" onClick={onCreateDirectory}>
                    <FolderPlus aria-hidden />
                    新建目录
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onNewFile}>
                  <FilePlus aria-hidden />
                  新建文件
                </Button>
              </div>
            )}
          </div>
        )}
        {!isLoading && !isError && !isEmpty && (
          <div className="divide-y divide-mcs-border-subtle">
            {entries.map((entry) => (
              <FileListRow
                key={entry.path}
                entry={entry}
                isSelected={selectedPath === entry.path}
                onSelectFile={onSelectFile}
                onOpenDir={onOpenDir}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
