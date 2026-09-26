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
 * - 虚拟滚动：长目录（世界 region/ 可达数千条）只渲染视口内的行；行高恒定见 ROW_HEIGHT
 * - 设计纪律：全部 --mcs-* 语义 token；表格/列表实底，禁硬编码色值/间距/圆角
 */
import { Fragment, useMemo, useRef } from 'react'
// TanStack Virtual 自管内部缓存，与 React Compiler 互斥（官方不兼容清单），不可自动 memo 化
// eslint-disable-next-line react/incompatible-library
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle,
  Archive,
  ArrowUp,
  Braces,
  ChevronRight,
  Download,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
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
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { cn } from '@/lib/utils'
import { fileIconName, formatFileSize, formatModifiedAt, isEditableFile } from '@/lib/mc-files'
import { EmptyStateVisual, ErrorStateVisual, ListSkeleton } from '@/components/mcs/data-states'
import { useFileList } from '../queries'
import type { FileEntry } from '@/api/types'

/**
 * 行高（px，含行自带的下边框）：两行文本撑出来的实高取整到 4px 刻度 ——
 * 姓名 14×1.6＝22.4（实测 22.39）+ 间距 2 + 元数据 12×1.5＝18 → 42.4，故取 44（h-11）。
 * 行盒用 `height` 而非 `min-h`：**虚拟滚动按本值累加绝对偏移，行比它高就会逐行错位**
 * （实测按 40 定位、实际 42.39 时，第 120 行已错开 290px，底部内容滚不到）。
 * 两行都是 truncate（nowrap + 溢出裁切），故实高有上界、不会撑破行盒；
 * 玩家表同理（`player-table-row.tsx` 的 `height: ROW_HEIGHT`）。
 * 改字号档/内距档必须同步改本值——实高与行距由 e2e 锁（files.spec.ts「长目录虚拟滚动」）。
 */
const ROW_HEIGHT = 44

/** 启用虚拟滚动的条目数阈值（约两屏）：低于它保持原 DOM 形状（jsdom 下无布局引擎，
 *  滚动容器恒 0 高，走虚拟会让既有用例找不到行） */
const VIRTUAL_THRESHOLD = 40

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
  /** 行级「移动到…」（换父目录；服务端由 rename 端点承担） */
  onMove?: (entry: FileEntry) => void
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
  /** 行级「移动到…」（未提供则不渲染按钮） */
  onMove?: (entry: FileEntry) => void
  /** 行级「下载」（文件行；未提供则不渲染按钮） */
  onDownload?: (entry: FileEntry) => void
  /** 正在下载的文件路径（行内按钮转 spinner 并禁用） */
  downloadingPath: string | null
  /** 目录末条：分隔线只画在行与行之间（末条画了会悬在列表尾部空白上方） */
  isLast: boolean
}

function FileListRow({
  entry,
  isSelected,
  onSelectFile,
  onOpenDir,
  onDelete,
  onRename,
  onMove,
  onDownload,
  downloadingPath,
  isLast,
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
        // 分隔线挂在行盒的 border 上（不是容器 divide-y）：虚拟分支的行是绝对定位的，
        // 容器级 divide-y 对它们不生效；两分支共用同一份行配方才能视觉一致。
        // 末条不画（否则一条线悬在列表尾部空白上方）——由 isLast 显式传入，
        // 不用 last: 选择器：虚拟分支每行都是各自包装盒的独子，last: 会命中所有行。
        'flex cursor-pointer items-center gap-3 border-b border-mcs-border-subtle px-4 transition-colors duration-mcs-fast focus-visible:bg-mcs-state-focus',
        isLast && 'border-b-0',
        isDir
          ? 'hover:bg-mcs-state-hover'
          : cn('hover:bg-mcs-state-hover', isSelected && 'bg-mcs-accent-bg-subtle'),
      )}
      /* 行盒高度钉死 = ROW_HEIGHT（含下边框，border-box）：虚拟滚动按此值累加偏移，
         用内容高度兜底会让行比偏移量高、逐行错位。见 ROW_HEIGHT 注释 */
      style={{ height: ROW_HEIGHT }}
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
      {onMove && (
        <IconButton
          aria-label={`移动 ${entry.name}`}
          title="移动到…"
          className="text-mcs-text-muted hover:text-mcs-text-default"
          onClick={(e) => {
            e.stopPropagation()
            onMove(entry)
          }}
        >
          <FolderInput className="size-3.5" aria-hidden />
        </IconButton>
      )}
      <IconButton
        aria-label={`删除 ${entry.name}`}
        className="text-mcs-error-fg hover:bg-mcs-state-hover-error"
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
  onMove,
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

  /** 服务端因条目数上限截断了结果（契约字段，旧服务端不返回即视为未截断） */
  const truncated = data !== undefined && 'truncated' in data && data.truncated === true

  /* 虚拟滚动容器：世界 region/ 一类目录可达数千条，全量渲染会让每次键盘/选中态变化
     都重排整棵列表。行高恒定（见 ROW_HEIGHT），故 estimateSize 可信。
     注意与玩家表的差异：本列表**不换行、无动画**，故不需要 measureElement 的逐行实测；
     视口高度由外层 flex 决定（滚动条在本元素上）。 */
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const virtualItems = rowVirtualizer.getVirtualItems()
  /* 仅在「条目数明显多于一屏」时启用虚拟化：短列表走虚拟反而让 DOM 空一层、
     且 jsdom 下（无布局引擎、滚动容器恒 0 高）会让既有用例找不到行。
     阈值取 40 行（约两屏），低于它的目录由 virtualizer 判定也基本全渲染，
     取阈值是为了让「短列表保持原 DOM 形状」这件事显式可读。 */
  const useVirtual = entries.length >= VIRTUAL_THRESHOLD
  /* 两分支都产出同形参数，渲染层不必分叉处理行参数。
     `isLast` 取**全列表**末条（不是本次渲染到的末行）——虚拟分支的可见窗口下方
     还有未渲染的条目，若按「可见末行」判定会把线断在窗口边界上。 */
  const visibleEntries: Array<{ entry: FileEntry; offset: number; isLast: boolean }> = useVirtual
    ? virtualItems.map((v) => ({
        entry: entries[v.index]!,
        offset: v.start,
        isLast: v.index === entries.length - 1,
      }))
    : entries.map((entry, i) => ({
        entry,
        offset: i * ROW_HEIGHT,
        isLast: i === entries.length - 1,
      }))

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

      {/* 截断降级提示（服务端条目数达上限时回报）：少列出来的文件与「本来就没有」
          在列表上无法区分，必须明说，否则用户会以为某个文件丢了 */}
      {truncated && (
        <NoticeBanner variant="warning" icon={AlertTriangle}>
          {`该目录条目过多，仅显示前 ${entries.length} 项；请用「上传/下载」或 SSH 处理其余文件`}
        </NoticeBanner>
      )}

      {/* 文件列表（实底；玻璃禁区）——三态复用 data-states 共享视觉 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
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
        {!isLoading &&
          !isError &&
          !isEmpty &&
          (useVirtual ? (
            /* 虚拟列表：总高由 virtualizer 给，可见行用 translateY 定位。
               分隔线在行盒的 border 上（绝对定位的行上 divide-y 不生效） */
            <div style={{ height: rowVirtualizer.getTotalSize() }} className="relative">
              {visibleEntries.map(({ entry, offset, isLast }) => (
                <div
                  key={entry.path}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${offset}px)` }}
                >
                  <FileListRow
                    entry={entry}
                    isSelected={selectedPath === entry.path}
                    onSelectFile={onSelectFile}
                    onOpenDir={onOpenDir}
                    onDelete={onDelete}
                    onRename={onRename}
                    onMove={onMove}
                    onDownload={onDownload}
                    downloadingPath={downloadingPath}
                    isLast={isLast}
                  />
                </div>
              ))}
            </div>
          ) : (
            /* 与虚拟分支共用同一份行配方（含分隔线），故容器上不再用 divide-y */
            <div>
              {visibleEntries.map(({ entry, isLast }) => (
                <FileListRow
                  key={entry.path}
                  entry={entry}
                  isSelected={selectedPath === entry.path}
                  onSelectFile={onSelectFile}
                  onOpenDir={onOpenDir}
                  onDelete={onDelete}
                  onRename={onRename}
                  onMove={onMove}
                  onDownload={onDownload}
                  downloadingPath={downloadingPath}
                  isLast={isLast}
                />
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}
