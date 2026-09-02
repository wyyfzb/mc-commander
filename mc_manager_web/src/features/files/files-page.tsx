/**
 * FilesPage —— 文件页（三栏布局）
 * - 左栏：目录树（DirTree，根 '/' 起逐层懒加载）
 * - 中栏：文件列表（面包屑 + 上级/刷新/新建文件工具栏 + 删除入口）
 * - 右栏：Monaco 编辑器（选中文件即打开；Ctrl+S 保存；脏标记；关闭确认）
 * - 删除确认对话框（目录红色警告递归删除）；新建文件对话框（PUT content 新路径）
 * - feat-3：新建目录对话框（mkdir recursive）/ 重命名对话框（原子 rename）/
 *   上传（隐藏 file input multipart 直传，服务端落地到当前浏览目录；同名冲突弹确认）
 * - 编辑内容为组件 state，与 query 缓存隔离（保存成功由 mutation 失效列表/内容缓存）
 * - URL 深链接：?dir=/world&file=/world/level.dat（可分享、可刷新保持）
 * - 实例切换：目录/选中文件重置回初始态
 */
import { useEffect, useRef, useState, useSyncExternalStore, useCallback, useMemo, type ChangeEvent } from 'react'
import { ServerOff, PanelLeftClose, MonitorSmartphone } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { apiDownloadFile } from '@/api/files'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { isBinaryFileName } from '@/lib/mc-files'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { LoadingButton } from '@/components/mcs/loading-button'
import { Input } from '@/components/ui/input'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard'
import { useSnapshotSave } from '@/hooks/use-snapshot-save'
import { useServerStore } from '@/stores/server'
import { useUiStore } from '@/stores/ui'
import type { FileEntry } from '@/api/types'
import { DirTree } from './components/dir-tree'
import { FileList } from './components/file-list'
import { MonacoEditorPane } from './components/monaco-editor-pane'
import {
  useCreateDirectory,
  useDeleteFile,
  useFileContent,
  useFileList,
  useRenameFile,
  useSaveFile,
  useUploadFile,
} from './queries'
import { EmptyState } from '@/components/mcs/empty-state'
import { useNavigate } from 'react-router'

/** 父目录（'/' 前缀风格；与 files/queries.ts 的 parentDirOf 同规则） */
function parentDirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

/** 响应式媒体查询 hook（useSyncExternalStore：无 setState-in-effect 级联，首渲染即真实值） */
function useMediaQuery(query: string, initialValue = false): boolean {
  const subscribe = (onStoreChange: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener('change', onStoreChange)
    return () => mql.removeEventListener('change', onStoreChange)
  }
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => initialValue)
}

/** 断点常量（与 Tailwind md/lg 断点对齐） */
const BREAKPOINT_MOBILE = '(max-width: 767px)'
const BREAKPOINT_NARROW = '(min-width: 768px) and (max-width: 1023px)'

export function FilesPage() {
  const instanceId = useServerStore((s) => s.instanceId)
  const theme = useUiStore((s) => s.theme)
  const connection = useConnectionStore()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  // ── 导航状态（URL 深链接初始化；?dir= 目录 / ?file= 选中文件） ──
  const [dir, setDirState] = useState(() => searchParams.get('dir') ?? '/')
  const [selectedPath, setSelectedPathState] = useState<string | null>(
    () => searchParams.get('file'),
  )

  /** 目录切换：state + URL（根目录时移除参数） */
  const setDir = (path: string) => {
    setDirState(path)
    const next = new URLSearchParams(searchParams)
    if (path === '/') next.delete('dir')
    else next.set('dir', path)
    setSearchParams(next, { replace: true })
  }

  /** 选中文件切换：state + URL（null 时移除参数） */
  const setSelectedPath = (path: string | null) => {
    setSelectedPathState(path)
    const next = new URLSearchParams(searchParams)
    if (path === null) next.delete('file')
    else next.set('file', path)
    setSearchParams(next, { replace: true })
  }

  // 实例切换：目录/选中文件重置（跳过首次挂载）
  const prevInstanceRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevInstanceRef.current !== null && prevInstanceRef.current !== instanceId) {
      setDir('/')
      setSelectedPath(null)
      originalRef.current = null
      setDraft('')
    }
    prevInstanceRef.current = instanceId
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- setDir/setSelectedPath 是 React 稳定 setter，省略不影响语义
  }, [instanceId])

  // ── 编辑器内容（组件 state，与 query 隔离；originalRef 为已加载/已保存基线） ──
  const [draft, setDraft] = useState('')
  const originalRef = useRef<string | null>(null)

  // ── 对话框状态 ──
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null)
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  // feat-3：新建目录 / 重命名 / 上传
  const [newDirOpen, setNewDirOpen] = useState(false)
  const [newDirName, setNewDirName] = useState('')
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const uploadInputRef = useRef<HTMLInputElement>(null)
  // feat-9：正在下载的文件路径（行内 spinner + 防重复点击）
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null)
  // 上传同名冲突确认（对齐插件市场 40912 冲突流程）
  const [uploadConflictTarget, setUploadConflictTarget] = useState<File | null>(null)

  // ── 响应式断点 ──
  const isMobile = useMediaQuery(BREAKPOINT_MOBILE)
  const isNarrowDesktop = useMediaQuery(BREAKPOINT_NARROW)
  // 移动端：目录树 Sheet 抽屉
  const [dirTreeOpen, setDirTreeOpen] = useState(false)

  const contentQuery = useFileContent(instanceId, selectedPath)
  const saveMutation = useSaveFile(instanceId)
  const deleteMutation = useDeleteFile(instanceId)
  const createDirMutation = useCreateDirectory(instanceId)
  const renameMutation = useRenameFile(instanceId)
  const uploadMutation = useUploadFile(instanceId)

  /** 当前目录文件列表（上传前探测同名冲突；仅目录列表有 .files） */
  const fileListQuery = useFileList(instanceId, dir)
  const existingFileNames = useMemo(
    () => new Set(
      (fileListQuery.data && 'files' in fileListQuery.data
        ? fileListQuery.data.files
        : []
      ).map((f: { name: string }) => f.name),
    ),
    [fileListQuery.data],
  )

  /** 保存竞态守卫：连续快速保存时只有最后一次结果被采纳（hook 须在早返回前调用） */
  const fileSave = useSnapshotSave<{ path: string; content: string }>({
    onSave: async (snapshot) => {
      await saveMutation.mutateAsync(snapshot)
    },
    onSaved: (snapshot) => {
      originalRef.current = snapshot.content
      if (snapshot.path.endsWith('server.properties')) {
        toast.success('文件已保存，部分属性需重启服务器后生效')
      } else {
        toast.success('文件已保存')
      }
    },
    onError: (e) => {
      toast.error(`保存失败：${getFriendlyErrorText(e)}`)
    },
  })

  /** 保存当前文件（Ctrl+S / 保存按钮共用；竞态守卫） */
  const save = useCallback(() => {
    if (!selectedPath) return
    fileSave.save({ path: selectedPath, content: draft })
  }, [selectedPath, draft, fileSave])

  /** 内容加载完成 → 同步本地 draft 与基线 */
  useEffect(() => {
    if (contentQuery.data && contentQuery.data.path === selectedPath) {
      setDraft(contentQuery.data.content)
      originalRef.current = contentQuery.data.content
    }
  }, [contentQuery.data, selectedPath])

  const dirty = selectedPath !== null && draft !== originalRef.current

  /**
   * 二进制文件深链接守卫（feat-9）：URL ?file=/world/level.dat 直达二进制时，
   * 文本编辑器本就打不开（服务端 40006），主动清选择并提示改用下载，
   * 避免“编辑器 + 报错”的误导态。
   */
  useEffect(() => {
    const name = selectedPath?.split('/').pop() ?? ''
    if (selectedPath && isBinaryFileName(name)) {
      toast.info('二进制文件无法在线编辑，可使用行内下载按钮导出到本地', {
        description: selectedPath,
      })
      setSelectedPath(null)
    }
  }, [selectedPath])

  /** 路由切换守卫：编辑未保存切页确认 */
  const guard = useUnsavedGuard(dirty)
  const navigate = useNavigate()

  if (!instanceId) {
    return (
      <EmptyState
        icon={ServerOff}
        title="暂无服务器实例"
        hint="请先在服务端创建 MC 服务器实例"
        action={{ label: '前往实例管理', onClick: () => navigate('/instances') }}
      />
    )
  }

  const selectFile = (path: string) => {
    setSelectedPath(path)
  }

  /** 关闭编辑器：脏则先确认 */
  const requestClose = () => {
    if (dirty) {
      setCloseConfirmOpen(true)
    } else {
      setSelectedPath(null)
    }
  }


  /** 删除确认（目录红色警告递归删除） */
  const confirmDelete = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      await deleteMutation.mutateAsync({ path: target.path })
      toast.success(`已删除 ${target.name}`)
      // 当前目录被删 → 回父目录；编辑器打开的文件在删除目录内 → 关闭编辑器
      if (dir === target.path || dir.startsWith(`${target.path}/`)) {
        setDir(parentDirOf(target.path))
      }
      if (selectedPath && (selectedPath === target.path || selectedPath.startsWith(`${target.path}/`))) {
        setSelectedPath(null)
        originalRef.current = null
        setDraft('')
      }
    } catch (e) {
      toast.error(`删除失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 新建文件：PUT content 新路径（空内容）→ 打开编辑器 */
  const createFile = async () => {
    const name = newFileName.trim()
    if (name.length === 0) {
      toast.error('文件名不能为空')
      return
    }
    if (name.includes('/') || name.includes('\\')) {
      toast.error('文件名不能包含路径分隔符')
      return
    }
    const path = dir === '/' ? `/${name}` : `${dir}/${name}`
    try {
      await saveMutation.mutateAsync({ path, content: '' })
      setNewFileOpen(false)
      setNewFileName('')
      toast.success(`已创建文件 ${name}`)
      setSelectedPath(path)
    } catch (e) {
      toast.error(`创建失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 新建目录：POST /files/mkdir（recursive 支持多级，如 plugins/SomePlugin/config） */
  const createDirectory = async () => {
    const name = newDirName.trim()
    if (name.length === 0) {
      toast.error('目录名不能为空')
      return
    }
    if (name.includes('\\')) {
      toast.error('目录名不能包含反斜杠')
      return
    }
    const dirPath = name.startsWith('/') ? name : dir === '/' ? `/${name}` : `${dir}/${name}`
    try {
      await createDirMutation.mutateAsync({ dirPath })
      setNewDirOpen(false)
      setNewDirName('')
      toast.success(`已创建目录 ${name}`)
    } catch (e) {
      toast.error(`创建目录失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 重命名：POST /files/rename 原子操作；编辑器打开的目标改名后跟随新路径 */
  const confirmRename = async () => {
    if (!renameTarget) return
    const newName = renameValue.trim()
    if (newName.length === 0) {
      toast.error('名称不能为空')
      return
    }
    if (newName.includes('/') || newName.includes('\\')) {
      toast.error('名称不能包含路径分隔符')
      return
    }
    if (newName === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    const newPath = `${parentDirOf(renameTarget.path)}/${newName}`
    try {
      await renameMutation.mutateAsync({ oldPath: renameTarget.path, newPath })
      // 编辑器正打开被重命名文件且无未保存修改 → 跟随新路径；脏状态保留在旧 draft，用户可自行选择
      if (selectedPath === renameTarget.path && !dirty) {
        setSelectedPath(newPath)
      } else if (selectedPath === renameTarget.path) {
        setSelectedPath(null)
        originalRef.current = null
        setDraft('')
      }
      toast.success(`已重命名为 ${newName}`)
      setRenameTarget(null)
    } catch (e) {
      toast.error(`重命名失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 上传：触发隐藏 file input（服务端落地到当前浏览目录，同名覆盖） */
  const openUploadPicker = () => {
    uploadInputRef.current?.click()
  }

  /**
   * 下载文件到本地（feat-9）：blob → a[download] 触发保存。
   * toast 复用同一 id 展示进度（>5% 才刷新，避免大文件高频重渲染）；
   * 二进制/大文件是下载能力的主要受益者（编辑器对二进制不可用）。
   */
  const downloadFile = async (entry: FileEntry) => {
    if (downloadingPath) return
    setDownloadingPath(entry.path)
    const toastId = `download-${entry.path}`
    let lastPct = 0
    try {
      toast.loading(`正在下载 ${entry.name}…`, { id: toastId })
      const { fileName } = await apiDownloadFile(connection, instanceId, entry, {
        onProgress: (pct) => {
          if (pct - lastPct >= 5 || pct === 100) {
            lastPct = pct
            toast.loading(`正在下载 ${entry.name} ${pct}%`, { id: toastId })
          }
        },
      })
      toast.success(`已下载 ${fileName}`, { id: toastId })
    } catch (err) {
      toast.error(`下载失败：${getFriendlyErrorText(err)}`, { id: toastId })
    } finally {
      setDownloadingPath(null)
    }
  }

  /** 执行上传（冲突确认后调用或无冲突直接调用） */
  const doUpload = async (file: File) => {
    const toastId = `upload-${file.name}`
    let lastPct = 0
    try {
      toast.loading(`正在上传 ${file.name}…`, { id: toastId })
      const result = await uploadMutation.mutateAsync({
        file,
        targetDir: dir,
        onProgress: (pct) => {
          if (pct - lastPct >= 5 || pct === 100) {
            lastPct = pct
            toast.loading(`正在上传 ${file.name} ${pct}%`, { id: toastId })
          }
        },
      })
      toast.success(`已上传 ${result.path}（${(result.size / 1024).toFixed(1)} KB）`, { id: toastId })
    } catch (err) {
      toast.error(`上传失败：${getFriendlyErrorText(err)}`, { id: toastId })
    }
  }

  const handleUploadChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复上传同名文件
    if (!file) return
    if (uploadMutation.isPending) return // 在途保护：上传中忽略重复触发
    // 同名冲突探测：当前目录已有同名文件 → 弹确认（对齐插件市场 40912 流程）
    if (existingFileNames.has(file.name)) {
      setUploadConflictTarget(file)
      return
    }
    await doUpload(file)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {/* ── 桌面窄窗降级条（≥768px <1024px） ── */}
      {isNarrowDesktop && (
        <div className="shrink-0 px-3 pt-1">
          <NoticeBanner variant="info" icon={MonitorSmartphone}>
            窗口较窄，部分内容可能被截断，建议使用更宽的视图以获得最佳体验
          </NoticeBanner>
        </div>
      )}

      {/* ── 移动端：目录树 Sheet 抽屉 ── */}
      <Sheet open={isMobile && dirTreeOpen} onOpenChange={setDirTreeOpen}>
        <SheetContent side="left" className="w-[280px] gap-0 p-0" showCloseButton={false}>
          <SheetHeader className="border-b border-mcs-border-subtle px-3 py-2">
            <SheetTitle className="text-mcs-sm font-semibold">目录</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1">
            <DirTree instanceId={instanceId} currentPath={dir} onNavigate={(path) => {
              setDir(path)
              setDirTreeOpen(false)
            }} />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── 三栏主体 ── */}
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        {/* 左栏：目录树（桌面端内联，移动端隐藏） */}
        {!isMobile && (
          <section className="flex h-full min-h-0 w-[220px] shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
            <header className="flex h-10 shrink-0 items-center gap-2 border-b border-mcs-border-subtle px-3">
              <span className="text-mcs-sm font-semibold text-mcs-text-default">目录</span>
            </header>
            <div className="min-h-0 flex-1">
              <DirTree instanceId={instanceId} currentPath={dir} onNavigate={setDir} />
            </div>
          </section>
        )}

        {/* 中栏：文件列表（移动端全宽，桌面端 flex-1） */}
        <section className="flex h-full min-h-0 min-w-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
          {isMobile && (
            <div className="flex h-8 shrink-0 items-center border-b border-mcs-border-subtle px-3">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="打开目录树"
                onClick={() => setDirTreeOpen(true)}
              >
                <PanelLeftClose aria-hidden />
              </Button>
            </div>
          )}
          <FileList
            instanceId={instanceId}
            dir={dir}
            selectedPath={selectedPath}
            onSelectFile={selectFile}
            onOpenDir={setDir}
            onDelete={setDeleteTarget}
            onGoUp={() => setDir(parentDirOf(dir))}
            onRefresh={() => {
              if (instanceId) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.files(instanceId, dir) })
              }
            }}
            onNewFile={() => setNewFileOpen(true)}
            onCreateDirectory={() => setNewDirOpen(true)}
            onUpload={openUploadPicker}
            onRename={(entry) => {
              setRenameTarget(entry)
              setRenameValue(entry.name)
            }}
            onDownload={(entry) => void downloadFile(entry)}
            downloadingPath={downloadingPath}
          />
        </section>

        {/* 右栏：Monaco 编辑器（桌面端内联，移动端隐藏由全屏覆盖替代） */}
        {!isMobile && (
          <section className="flex h-full min-h-0 w-[45%] shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
            <MonacoEditorPane
              path={selectedPath ?? ''}
              content={draft}
              encoding={contentQuery.data?.encoding ?? 'utf-8'}
              theme={theme}
              isLoading={contentQuery.isLoading && selectedPath !== null}
              loadError={
                contentQuery.isError
                  ? `文件加载失败：${getFriendlyErrorText(contentQuery.error)}`
                  : null
              }
              isSaving={fileSave.isSaving}
              dirty={dirty}
              onChange={setDraft}
              onSave={() => void save()}
              onRestore={() => {
                if (originalRef.current != null) {
                  setDraft(originalRef.current)
                  toast.info('已恢复到上次保存版本')
                }
              }}
              onClose={requestClose}
              onRetry={() => void contentQuery.refetch()}
            />
          </section>
        )}
      </div>

      {/* ── 移动端：编辑器全屏覆盖 ── */}
      {isMobile && selectedPath !== null && (
        <div className="fixed inset-0 z-40 flex flex-col bg-mcs-bg-muted">
          <MonacoEditorPane
            path={selectedPath}
            content={draft}
            encoding={contentQuery.data?.encoding ?? 'utf-8'}
            theme={theme}
            isLoading={contentQuery.isLoading}
            loadError={
              contentQuery.isError
                ? `文件加载失败：${getFriendlyErrorText(contentQuery.error)}`
                : null
            }
            isSaving={fileSave.isSaving}
            dirty={dirty}
            onChange={setDraft}
            onSave={() => void save()}
            onRestore={() => {
              if (originalRef.current != null) {
                setDraft(originalRef.current)
                toast.info('已恢复到上次保存版本')
              }
            }}
            onClose={requestClose}
            onRetry={() => void contentQuery.refetch()}
          />
        </div>
      )}

      {/* ── 未保存确认（关闭编辑器与路由守卫共用：guard.isBlocked 时离开即切页） ── */}
      <ConfirmDialog
        open={closeConfirmOpen || guard.isBlocked}
        onOpenChange={(open) => {
          if (!open) {
            setCloseConfirmOpen(false)
            guard.cancel()
          }
        }}
        title="放弃未保存的修改？"
        description={`当前文件有未保存的更改，${guard.isBlocked ? '离开页面' : '关闭'}后将丢失这些修改。`}
        cancelText="留下"
        confirmText="放弃修改并离开"
        danger
        onConfirm={() => {
          setCloseConfirmOpen(false)
          setSelectedPath(null)
          originalRef.current = null
          setDraft('')
          guard.proceed()
        }}
      />

      {/* ── 删除确认（ConfirmDialog danger 模式） ── */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`删除 ${deleteTarget?.name ?? ''}？`}
        description={deleteTarget?.isDirectory === true ? `将递归删除目录「${deleteTarget?.name}」及其全部内容。` : `将删除文件「${deleteTarget?.name}」。`}
        confirmText="删除"
        danger
        warning="此操作不可撤销"
        loading={deleteMutation.isPending}
        onConfirm={() => void confirmDelete()}
      >
        <div className="py-1">
          <p
            className="truncate rounded-mcs-xs bg-mcs-bg-muted px-2 py-1 font-mono text-mcs-2xs text-mcs-text-subtle"
            title={deleteTarget?.path}
          >
            {deleteTarget?.path}
          </p>
        </div>
      </ConfirmDialog>

      {/* ── 新建文件对话框 ── */}
      <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建文件</DialogTitle>
            <DialogDescription>将在「{dir}」目录下创建空文件。</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="文件名，如 example.txt"
              aria-label="文件名"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFile()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFileOpen(false)}>
              取消
            </Button>
            <LoadingButton onClick={() => void createFile()} loading={saveMutation.isPending} loadingText="创建中…">
              创建
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 新建目录对话框（feat-3） ── */}
      <Dialog open={newDirOpen} onOpenChange={setNewDirOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建目录</DialogTitle>
            <DialogDescription>
              将在「{dir}」目录下创建；支持多级路径（如 plugins/Essentials/config）。
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              placeholder="目录名，如 plugins 或 plugins/Essentials"
              aria-label="目录名"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createDirectory()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewDirOpen(false)}>
              取消
            </Button>
            <LoadingButton onClick={() => void createDirectory()} loading={createDirMutation.isPending} loadingText="创建中…">
              创建
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 重命名对话框（feat-3） ── */}
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重命名 {renameTarget?.name}</DialogTitle>
            <DialogDescription>
              {renameTarget?.isDirectory === true ? '目录' : '文件'}路径：{renameTarget?.path}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="新名称"
              aria-label="新名称"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmRename()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <LoadingButton onClick={() => void confirmRename()} loading={renameMutation.isPending} loadingText="重命名中…">
              重命名
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 上传同名冲突确认（覆盖/跳过，对齐插件市场冲突流程） ── */}
      <ConfirmDialog
        open={uploadConflictTarget !== null}
        onOpenChange={(o) => { if (!o) setUploadConflictTarget(null) }}
        title="同名文件已存在"
        description={`当前目录已存在「${uploadConflictTarget?.name ?? ''}」，上传将覆盖原文件内容。`}
        confirmText="覆盖"
        cancelText="跳过"
        danger
        loading={false}
        onConfirm={() => {
          const f = uploadConflictTarget
          setUploadConflictTarget(null)
          if (f) void doUpload(f)
        }}
      />

      {/* ── 隐藏上传 input（feat-3：multipart 直传，服务端落地到当前浏览目录） ── */}
      <input
        ref={uploadInputRef}
        type="file"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => void handleUploadChange(e)}
      />
    </div>
  )
}
