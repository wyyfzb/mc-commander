/**
 * FilesPage —— 文件页（三栏布局）
 * - 左栏：目录树（DirTree，根 '/' 起逐层懒加载）
 * - 中栏：文件列表（面包屑 + 上级/刷新/新建文件工具栏 + 删除入口）
 * - 右栏：Monaco 编辑器（选中文件即打开；Ctrl+S 保存；脏标记；关闭确认）
 * - 删除确认对话框（目录红色警告递归删除）；新建文件对话框（PUT content 新路径）
 * - 编辑内容为组件 state，与 query 缓存隔离（保存成功由 mutation 失效列表/内容缓存）
 * - URL 深链接：?dir=/world&file=/world/level.dat（可分享、可刷新保持）
 * - 实例切换：目录/选中文件重置回初始态
 */
import { useEffect, useRef, useState } from 'react'
import { ServerOff } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { queryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard'
import { useServerStore } from '@/stores/server'
import { useUiStore } from '@/stores/ui'
import type { FileEntry } from '@/api/types'
import { DirTree } from './components/dir-tree'
import { FileList } from './components/file-list'
import { MonacoEditorPane } from './components/monaco-editor-pane'
import { useDeleteFile, useFileContent, useSaveFile } from './queries'
import { EmptyState } from '@/components/mcs/empty-state'
import { useNavigate } from 'react-router'

/** 父目录（'/' 前缀风格；与 files/queries.ts 的 parentDirOf 同规则） */
function parentDirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  // ── 编辑器内容（组件 state，与 query 隔离；originalRef 为已加载/已保存基线） ──
  const [draft, setDraft] = useState('')
  const originalRef = useRef<string | null>(null)

  // ── 对话框状态 ──
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null)
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)

  const contentQuery = useFileContent(instanceId, selectedPath)
  const saveMutation = useSaveFile(instanceId)
  const deleteMutation = useDeleteFile(instanceId)

  /** 内容加载完成 → 同步本地 draft 与基线 */
  useEffect(() => {
    if (contentQuery.data && contentQuery.data.path === selectedPath) {
      setDraft(contentQuery.data.content)
      originalRef.current = contentQuery.data.content
    }
  }, [contentQuery.data, selectedPath])

  const dirty = selectedPath !== null && draft !== originalRef.current

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

  /** 保存当前文件（Ctrl+S / 保存按钮共用） */
  const save = async () => {
    if (!selectedPath) return
    try {
      await saveMutation.mutateAsync({ path: selectedPath, content: draft })
      originalRef.current = draft
      // server.properties 经文件编辑器保存与 PUT /properties 热改通道区分
      if (selectedPath.endsWith('server.properties')) {
        toast.success('文件已保存，部分属性需重启服务器后生效')
      } else {
        toast.success('文件已保存')
      }
    } catch (e) {
      toast.error(`保存失败：${getFriendlyErrorText(e)}`)
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

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      {/* ── 左栏：目录树（220px，实底卡） ── */}
      <section className="flex h-full min-h-0 w-[220px] shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-mcs-border-subtle px-3">
          <span className="text-mcs-sm font-semibold text-mcs-text-default">目录</span>
        </header>
        <div className="min-h-0 flex-1">
          <DirTree instanceId={instanceId} currentPath={dir} onNavigate={setDir} />
        </div>
      </section>

      {/* ── 中栏：文件列表（实底卡） ── */}
      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
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
        />
      </section>

      {/* ── 右栏：Monaco 编辑器（实底卡） ── */}
      <section className="flex h-full min-h-0 w-[45%] shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
        <MonacoEditorPane
          path={selectedPath ?? ''}
          content={draft}
          encoding={contentQuery.data?.encoding ?? 'utf-8'}
          theme={theme}
          isLoading={contentQuery.isLoading && selectedPath !== null}
          loadError={contentQuery.isError ? '文件加载失败，请检查文件是否存在或稍后重试' : null}
          isSaving={saveMutation.isPending}
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

      {/* ── 关闭编辑器脏确认 ── */}
      {/* ── 未保存确认（关闭编辑器与路由守卫共用：guard.isBlocked 时离开即切页） ── */}
      <Dialog
        open={closeConfirmOpen || guard.isBlocked}
        onOpenChange={(open) => {
          if (!open) {
            setCloseConfirmOpen(false)
            guard.cancel()
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>放弃未保存的修改？</DialogTitle>
            <DialogDescription>
              当前文件有未保存的更改，{guard.isBlocked ? '离开页面' : '关闭'}后将丢失这些修改。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCloseConfirmOpen(false)
                guard.cancel()
              }}
            >
              留下
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setCloseConfirmOpen(false)
                setSelectedPath(null)
                originalRef.current = null
                setDraft('')
                guard.proceed()
              }}
            >
              放弃修改并离开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 删除确认（目录红色警告递归删除） ── */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除 {deleteTarget?.name}？</DialogTitle>
            <DialogDescription>
              {deleteTarget?.isDirectory === true
                ? `将递归删除目录「${deleteTarget.name}」及其全部内容，此操作不可撤销。`
                : `将删除文件「${deleteTarget?.name}」，此操作不可撤销。`}
            </DialogDescription>
          </DialogHeader>
          <div className="py-1">
            <p
              className="truncate rounded-mcs-xs bg-mcs-bg-muted px-2 py-1 font-mono text-mcs-2xs text-mcs-text-subtle"
              title={deleteTarget?.path}
            >
              {deleteTarget?.path}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <Button onClick={() => void createFile()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
