/**
 * FileList —— 文件页中间文件列表
 * - 数据自取：useFileList(instanceId, dir)（目录为目标时返回 files 数组）
 * - 面包屑内置：由 dir 渲染——根 Home 可点 + 逐级可点，最后一级加粗（aria-current=page），
 *   点击均走 onOpenDir 跳转
 * - 行：图标（目录 folder 黄色 --mcs-warning-fg；文件按扩展名映射）+ 名称 + 副行
 *   （目录「文件夹 · MM-DD HH:mm」/ 文件「大小 · 修改时间」，B/KB/MB 一位小数格式化在组件内）
 * - 目录行单击 onOpenDir 进入；文件行单击 onSelectFile（选中态 bg-accent-bg-subtle）；
 *   行尾操作：可编辑文件有编辑按钮（二进制文件不提供——防误入文本编辑器，
 *   feat-9 编辑保护），全部文件有下载按钮（目录无），全部有删除按钮（error 色）
 * - 空态：根目录「该实例根目录下没有文件」/ 子目录「此文件夹为空」；加载显示 Skeleton 行
 * - 设计纪律：全部 --mcs-* 语义 token；表格/列表实底，禁硬编码色值/间距/圆角
 */
import { Fragment, useMemo } from 'react'
import {
  Archive,
  ArrowUp,
  Braces,
  ChevronRight,
  Download,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Home,
  Image,
  Loader2,
  Pencil,
  RefreshCw,
  Settings,
  Trash2,
  TextCursorInput,
  Upload,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/mcs/icon-button'
import { cn } from '@/lib/utils'
import { fileIconName, formatFileSize, formatModifiedAt, isEditableFile } from '@/lib/mc-files'
import { EmptyStateVisual, ErrorStateVisual, ListSkeleton } from '@/components/mcs/data-states'
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
  /** 行级「下载」（文件行） */
  onDownload?: (entry: FileEntry) => void
  /** 正在下载的文件路径（null = 无下载进行中） */
  downloadingPath?: string | null
}

/** 文件大小格式化 → src/lib/mc-files.ts（fast-refresh 合规） */

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
  /** 行级「下载」（文件行；未提供则不渲染按钮） */
  onDownload?: (entry: FileEntry) => void
  /** 正在下载的文件路径（行内按钮转 spinner 并禁用） */
  downloadingPath: string | null
}

function FileListRow({
  entry,
  isSelected,
  onSelectFile,
  onOpenDir,
  onDelete,
  onRename,
  onDownload,
  downloadingPath,
}: FileListRowProps) {
  const Icon = FILE_ICONS[fileIconName(entry)] ?? File
  const isDir = entry.isDirectory
  const editable = isEditableFile(entry)
  const isDownloading = !isDir && entry.path === downloadingPath

  const handleRowClick = () => {
    if (isDir) onOpenDir(entry.path)
    else if (editable) onSelectFile(entry.path)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={
        isDir
          ? `打开目录 ${entry.name}`
          : editable
            ? `选择文件 ${entry.name}`
            : `文件 ${entry.name}（二进制，可下载）`
      }
      // 当前预览文件：底色是视觉线索，语义位由 aria-current 承担（role=button 行不构成列表选中集）
      aria-current={isSelected ? 'true' : undefined}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        // role="button" 行只处理落在行本身的激活键；行内图标按钮的冒泡不再触发行打开
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleRowClick()
        }
      }}
      className={cn(
        'flex cursor-pointer items-center gap-3 px-4 py-2 transition-colors duration-mcs-fast focus-visible:bg-mcs-state-focus',
        isDir
          ? 'hover:bg-mcs-state-hover'
          : cn('hover:bg-mcs-state-hover', isSelected && 'bg-mcs-accent-bg-subtle'),
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
      {!isDir && editable && (
        <IconButton
          aria-label={`编辑 ${entry.name}`}
          title="编辑"
          className="text-mcs-text-muted hover:text-mcs-text-default"
          onClick={(e) => {
            e.stopPropagation()
            onSelectFile(entry.path)
          }}
        >
          <Pencil className="size-3.5" aria-hidden />
        </IconButton>
      )}
      {!isDir && onDownload && (
        <IconButton
          aria-label={`下载 ${entry.name}`}
          title="下载到本地"
          disabled={isDownloading}
          className="text-mcs-text-muted hover:text-mcs-text-default"
          onClick={(e) => {
            e.stopPropagation()
            onDownload(entry)
          }}
        >
          {isDownloading ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Download className="size-3.5" aria-hidden />
          )}
        </IconButton>
      )}
      {onRename && (
        <IconButton
          aria-label={`重命名 ${entry.name}`}
          title="重命名"
          className="text-mcs-text-muted hover:text-mcs-text-default"
          onClick={(e) => {
            e.stopPropagation()
            onRename(entry)
          }}
        >
          <TextCursorInput className="size-3.5" aria-hidden />
        </IconButton>
      )}
      <IconButton
        aria-label={`删除 ${entry.name}`}
        className="text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(entry)
        }}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </IconButton>
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
  onDownload,
  downloadingPath = null,
}: FileListProps) {
  const { data, isLoading, isError, error, refetch, isFetching } = useFileList(instanceId, dir)

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
    return [...data.files].sort((a, b) =>
      a.isDirectory === b.isDirectory ? 0 : a.isDirectory ? -1 : 1,
    )
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
              className="flex items-center rounded-sm p-0.5 text-mcs-accent-fg transition-colors duration-mcs-fast hover:bg-mcs-state-hover"
            >
              <Home className="size-4" aria-hidden />
            </button>
            {crumbs.map((c, i) => {
              const isLast = i === crumbs.length - 1
              return (
                <Fragment key={c.path}>
                  <ChevronRight className="size-3.5 shrink-0 text-mcs-text-muted" aria-hidden />
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
                      className="max-w-44 truncate rounded-sm px-1 py-0.5 text-mcs-accent-fg transition-colors duration-mcs-fast hover:bg-mcs-state-hover"
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
            <IconButton aria-label="上级目录" title="上级目录" onClick={onGoUp}>
              <ArrowUp aria-hidden />
            </IconButton>
          )}
          {onRefresh && (
            <IconButton aria-label="刷新" title="刷新" onClick={onRefresh}>
              <RefreshCw aria-hidden />
            </IconButton>
          )}
          {onNewFile && (
            <IconButton aria-label="新建文件" title="新建文件" onClick={onNewFile}>
              <FilePlus aria-hidden />
            </IconButton>
          )}
          {onCreateDirectory && (
            <IconButton aria-label="新建目录" title="新建目录" onClick={onCreateDirectory}>
              <FolderPlus aria-hidden />
            </IconButton>
          )}
          {onUpload && (
            <IconButton
              aria-label="上传文件（单个文件 ≤ 50MB）"
              title="上传文件到当前目录（单个文件 ≤ 50MB）"
              onClick={onUpload}
            >
              <Upload aria-hidden />
            </IconButton>
          )}
        </div>
      </nav>

      {/* 文件列表（实底；玻璃禁区）——三态复用 data-states 共享视觉 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <ListSkeleton rows={4} />}
        {!isLoading && isError && (
          <div className="flex flex-col items-center gap-3 px-4 py-10">
            <ErrorStateVisual
              error={error}
              retry={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isFetching}
                  onClick={() => void refetch()}
                >
                  {isFetching ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RefreshCw className="size-3.5" aria-hidden />
                  )}
                  重试
                </Button>
              }
            />
          </div>
        )}
        {!isLoading && !isError && isEmpty && (
          <div className="py-12">
            <EmptyStateVisual
              text={normalizedDir === '/' ? '该实例根目录下没有文件' : '此文件夹为空'}
              actions={
                onNewFile ? (
                  <>
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
                  </>
                ) : undefined
              }
            />
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
                onDownload={onDownload}
                downloadingPath={downloadingPath}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
