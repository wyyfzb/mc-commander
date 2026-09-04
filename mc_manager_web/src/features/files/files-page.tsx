/**
 * FilesPage —— 文件页（双栏布局）：左栏文件列表（面包屑/工具栏/删除入口）+ 右栏 Monaco 编辑器
 * - 对话框群与上传/下载逻辑已拆至 components/ 与 use-* hooks（纯移动零行为变更）
 * - URL 深链接 ?dir=&file=（可分享、可刷新保持）；实例切换重置回初始态
 * - 编辑内容为组件 state，与 query 缓存隔离（保存成功由 mutation 失效列表/内容缓存）
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { ServerOff, MonitorSmartphone } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useSearchParams, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { queryKeys } from '@/api/queries'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard'
import { useServerStore } from '@/stores/server'
import { useUiStore } from '@/stores/ui'
import type { FileEntry } from '@/api/types'
import { FileList } from './components/file-list'
import { EditorSlot } from './components/editor-slot'
import { UploadProgressBar } from './components/upload-progress-bar'
import { UnsavedConfirmDialog } from './components/unsaved-confirm-dialog'
import { DeleteConfirmDialog } from './components/delete-confirm-dialog'
import { NamePromptDialog } from './components/name-prompt-dialog'
import { RenameDialog } from './components/rename-dialog'
import { UploadConflictDialog } from './components/upload-conflict-dialog'
import { useMediaQuery, BREAKPOINT_MOBILE, BREAKPOINT_NARROW } from './use-media-query'
import { useFileUpload } from './use-file-upload'
import { useFileDownload } from './use-file-download'
import { useFileEditor } from './use-file-editor'
import {
  useCreateDirectory,
  useDeleteFile,
  useFileContent,
  useRenameFile,
  useSaveFile,
  useUploadFile,
} from './queries'
import { EmptyState } from '@/components/mcs/empty-state'

/** 父目录（'/' 前缀风格；与 files/queries.ts 的 parentDirOf 同规则） */
function parentDirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

/** 名称校验：返回错误文案（null=通过）；空值/路径分隔符（文案与原实现逐字一致） */
function entryNameError(name: string, label: string): string | null {
  if (name.length === 0) return `${label}不能为空`
  if (name.includes('/') || name.includes('\\')) return `${label}不能包含路径分隔符`
  return null
}

export function FilesPage() {
  const instanceId = useServerStore((s) => s.instanceId)
  const theme = useUiStore((s) => s.theme)
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

  /** 选中文件切换：state + URL（null 时移除参数）；useCallback 稳定引用（effect 依赖） */
  const setSelectedPath = useCallback((path: string | null) => {
    setSelectedPathState(path)
    const next = new URLSearchParams(searchParams)
    if (path === null) next.delete('file')
    else next.set('file', path)
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // 实例切换：目录/选中文件重置（跳过首次挂载；draft/基线重置见下方 useFileEditor 解构）
  const prevInstanceRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevInstanceRef.current !== null && prevInstanceRef.current !== instanceId) {
      setDir('/')
      setSelectedPath(null)
      originalRef.current = null
      setDraft('')
    }
    prevInstanceRef.current = instanceId
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- setDir 为渲染期重建的包装函数，实例切换后 effect 重跑仅重复幂等赋值，省略不影响语义
  }, [instanceId])

  // ── 对话框状态 ──
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null)
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  // feat-3：新建目录 / 重命名
  const [newDirOpen, setNewDirOpen] = useState(false)
  const [newDirName, setNewDirName] = useState('')
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // ── 响应式断点 ──
  const isMobile = useMediaQuery(BREAKPOINT_MOBILE)
  const isNarrowDesktop = useMediaQuery(BREAKPOINT_NARROW)

  const contentQuery = useFileContent(instanceId, selectedPath)
  const saveMutation = useSaveFile(instanceId)
  const deleteMutation = useDeleteFile(instanceId)
  const createDirMutation = useCreateDirectory(instanceId)
  const renameMutation = useRenameFile(instanceId)
  const uploadMutation = useUploadFile(instanceId)

  // ── 上传（进度/冲突/取消，含同名探测与卸载中断）与下载（进度 toast）逻辑 hook ──
  const {
    uploading,
    uploadConflictTarget,
    setUploadConflictTarget,
    uploadInputRef,
    openUploadPicker,
    doUpload,
    cancelUpload,
    handleUploadChange,
  } = useFileUpload(instanceId, dir, uploadMutation)
  const { downloadingPath, downloadFile } = useFileDownload(instanceId)

  // ── 编辑器内容状态（draft/基线/保存竞态守卫/脏判定/还原/二进制深链接守卫）hook ──
  const { draft, setDraft, originalRef, fileSave, save, dirty, restoreDraft } = useFileEditor({
    selectedPath,
    setSelectedPath,
    contentQuery,
    saveMutation,
  })

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
    const nameError = entryNameError(name, '文件名')
    if (nameError) {
      toast.error(nameError)
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
    const nameError = entryNameError(newName, '名称')
    if (nameError) {
      toast.error(nameError)
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

      {/* ── 双栏主体 ── */}
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        {/* 左栏：文件列表（桌面/移动同构：面包屑 + 工具栏导航）；flex-1 吃满编辑器以外宽度 */}
        <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
          {/* ── 上传进度条（对齐插件页交互：progressbar ARIA + 取消） ── */}
          {uploading && <UploadProgressBar uploading={uploading} onCancel={cancelUpload} />}
          <FileList
            instanceId={instanceId}
            dir={dir}
            selectedPath={selectedPath}
            onSelectFile={setSelectedPath}
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
          <EditorSlot
            variant="desktop"
            selectedPath={selectedPath}
            contentQuery={contentQuery}
            draft={draft}
            theme={theme}
            isSaving={fileSave.isSaving}
            dirty={dirty}
            onChange={setDraft}
            onSave={save}
            onRestore={restoreDraft}
            onClose={requestClose}
            onRetry={() => void contentQuery.refetch()}
          />
        )}
      </div>

      {/* ── 移动端：编辑器全屏覆盖 ── */}
      {isMobile && selectedPath !== null && (
        <EditorSlot
          variant="fullscreen"
          selectedPath={selectedPath}
          contentQuery={contentQuery}
          draft={draft}
          theme={theme}
          isSaving={fileSave.isSaving}
          dirty={dirty}
          onChange={setDraft}
          onSave={save}
          onRestore={restoreDraft}
          onClose={requestClose}
          onRetry={() => void contentQuery.refetch()}
        />
      )}

      {/* ── 未保存确认（关闭编辑器与路由守卫共用：guard.isBlocked 时离开即切页） ── */}
      <UnsavedConfirmDialog
        open={closeConfirmOpen || guard.isBlocked}
        isBlocked={guard.isBlocked}
        onCancel={() => {
          setCloseConfirmOpen(false)
          guard.cancel()
        }}
        onConfirm={() => {
          setCloseConfirmOpen(false)
          setSelectedPath(null)
          originalRef.current = null
          setDraft('')
          guard.proceed()
        }}
      />

      {/* ── 删除确认（目录红色警告递归删除） ── */}
      <DeleteConfirmDialog
        target={deleteTarget}
        loading={deleteMutation.isPending}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteTarget(null)}
      />

      {/* ── 新建文件对话框 ── */}
      <NamePromptDialog
        open={newFileOpen}
        onOpenChange={setNewFileOpen}
        title="新建文件"
        description={`将在「${dir}」目录下创建空文件。`}
        inputLabel="文件名"
        placeholder="文件名，如 example.txt"
        value={newFileName}
        onValueChange={setNewFileName}
        submitting={saveMutation.isPending}
        onSubmit={createFile}
      />

      {/* ── 新建目录对话框（feat-3） ── */}
      <NamePromptDialog
        open={newDirOpen}
        onOpenChange={setNewDirOpen}
        title="新建目录"
        description={`将在「${dir}」目录下创建；支持多级路径（如 plugins/Essentials/config）。`}
        inputLabel="目录名"
        placeholder="目录名，如 plugins 或 plugins/Essentials"
        value={newDirName}
        onValueChange={setNewDirName}
        submitting={createDirMutation.isPending}
        onSubmit={createDirectory}
      />

      {/* ── 重命名对话框（feat-3） ── */}
      <RenameDialog
        target={renameTarget}
        value={renameValue}
        onValueChange={setRenameValue}
        submitting={renameMutation.isPending}
        onSubmit={confirmRename}
        onClose={() => setRenameTarget(null)}
      />

      {/* ── 上传同名冲突确认（覆盖/跳过，对齐插件市场冲突流程） ── */}
      <UploadConflictDialog
        target={uploadConflictTarget}
        onConfirm={(f) => void doUpload(f)}
        onClose={() => setUploadConflictTarget(null)}
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
