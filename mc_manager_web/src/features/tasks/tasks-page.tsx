/**
 * TasksPage —— 定时任务页
 * - 任务列表 30s 轮询 + 新建/编辑对话框 + 行内启停/立即执行/删除确认
 * - 实例切换：query key 含 instanceId 自动切换；无实例空态
 * - 对话框保存后 toast（任务已创建/已更新/已删除/已触发执行）
 */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { CommandPreview } from '@/components/mcs/command-preview'
import { useServerStore } from '@/stores/server'
import type { ScheduledTask, TaskCreatePayload } from '@/api/types'
import { useCreateTask, useDeleteTask, useRunTaskNow, useTasks, useUpdateTask } from './queries'
import { TaskDialog } from './components/task-dialog'
import { TaskList } from './components/task-list'
import { EmptyState } from '@/components/mcs/empty-state'
import { InstanceRequiredState } from '@/features/instances/components/instance-required-state'
import { PageHeader } from '@/components/mcs/page-header'

export function TasksPage() {
  const instanceId = useServerStore((s) => s.instanceId)

  // ── 对话框状态 ──
  const [dialogTask, setDialogTask] = useState<ScheduledTask | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null)
  const [runTarget, setRunTarget] = useState<ScheduledTask | null>(null)

  const tasksQuery = useTasks(instanceId)
  const createMutation = useCreateTask(instanceId)
  const updateMutation = useUpdateTask(instanceId)
  const deleteMutation = useDeleteTask(instanceId)
  const runMutation = useRunTaskNow(instanceId)
  /**
   * 正在立即执行的任务 id（行按钮 loading 态）。
   * 仅 isPending 时取 variables：mutation 成功后 TanStack Query 保留 variables，
   * 直接用 variables 会导致按钮永久 hourglass（结束后需复位）
   */
  const runningTaskId = runMutation.isPending ? (runMutation.variables ?? null) : null

  // 列表加载失败提示（TanStack Query 静默 → 页面补 error toast）
  const loadErrorShownRef = useRef(false)
  useEffect(() => {
    if (tasksQuery.isError && !loadErrorShownRef.current) {
      loadErrorShownRef.current = true
      toast.error(`加载失败：${getFriendlyErrorText(tasksQuery.error)}`)
    } else if (tasksQuery.isSuccess) {
      loadErrorShownRef.current = false
    }
  }, [tasksQuery.isError, tasksQuery.isSuccess, tasksQuery.error])

  // 无实例门：加载中/加载失败/真空态/待选中四态各自诚实（见 InstanceRequiredState）
  if (!instanceId) {
    return <InstanceRequiredState />
  }

  const openCreate = () => {
    setDialogTask(null)
    setDialogOpen(true)
  }

  const openEdit = (task: ScheduledTask) => {
    setDialogTask(task)
    setDialogOpen(true)
  }

  /** 新建/编辑保存（页面负责 mutation 与 toast） */
  const handleSave = async (payload: TaskCreatePayload) => {
    try {
      if (dialogTask) {
        await updateMutation.mutateAsync({ taskId: dialogTask.id, payload })
        toast.success('任务已更新')
      } else {
        await createMutation.mutateAsync(payload)
        toast.success('任务已创建')
      }
      setDialogOpen(false)
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
      throw e
    }
  }

  /** 行内启用开关切换 */
  const handleToggle = async (task: ScheduledTask, enabled: boolean) => {
    try {
      await updateMutation.mutateAsync({ taskId: task.id, payload: { isEnabled: enabled } })
      toast.success(`任务 "${task.name}" 已${enabled ? '启用' : '禁用'}`)
    } catch (e) {
      toast.error(`更新失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 立即执行：打开确认（含命令预览） */
  const handleRunNow = (task: ScheduledTask) => {
    setRunTarget(task)
  }

  /** 执行确认：待 mutation 完成后再关闭对话框（与删除流程时序一致，loading 态可见） */
  const handleRunConfirm = async () => {
    if (!runTarget) return
    const target = runTarget
    try {
      await runMutation.mutateAsync(target.id)
      toast.success(`任务 "${target.name}" 已触发执行`)
      setRunTarget(null)
    } catch (e) {
      toast.error(`执行失败：${getFriendlyErrorText(e)}`)
      setRunTarget(null)
    }
  }

  /** 删除确认执行 */
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      await deleteMutation.mutateAsync(target.id)
      toast.success('任务已删除')
    } catch (e) {
      toast.error(`删除失败：${getFriendlyErrorText(e)}`)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="定时任务"
        description="自动化执行服务器重启、备份、命令等操作"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void tasksQuery.refetch()}
              disabled={tasksQuery.isLoading}
            >
              <RefreshCw aria-hidden />
              刷新
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus aria-hidden />
              新建任务
            </Button>
          </div>
        }
      />

      {/* ── 任务列表 ── */}
      <div className="min-h-0 flex-1">
        {tasksQuery.isError && !tasksQuery.isLoading ? (
          <EmptyState
            icon={AlertTriangle}
            title="加载失败"
            hint={`无法获取定时任务列表：${getFriendlyErrorText(tasksQuery.error)}`}
            action={{ label: '重试', onClick: () => void tasksQuery.refetch() }}
          />
        ) : (
          <TaskList
            tasks={tasksQuery.data ?? []}
            isLoading={tasksQuery.isLoading}
            runningTaskId={runningTaskId}
            onToggle={(t, v) => void handleToggle(t, v)}
            onRunNow={(t) => void handleRunNow(t)}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
            onNewTask={openCreate}
          />
        )}
      </div>

      {/* ── 新建/编辑对话框（恒开组件，条件渲染控制显隐） ── */}
      {dialogOpen && (
        <TaskDialog
          task={dialogTask}
          onClose={() => setDialogOpen(false)}
          onSave={handleSave}
          saving={createMutation.isPending || updateMutation.isPending}
        />
      )}

      {/* ── 删除确认 ── */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`删除任务 "${deleteTarget?.name ?? ''}"？`}
        description={`确定要删除任务 "${deleteTarget?.name ?? ''}" 吗？`}
        warning="此操作不可撤销"
        confirmText="删除"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => void handleDeleteConfirm()}
      />

      {/* ── 执行确认（命令类型任务含命令预览） ── */}
      <ConfirmDialog
        open={runTarget !== null}
        onOpenChange={(open) => !open && setRunTarget(null)}
        title="确认执行任务"
        description={`确定要立即执行任务 "${runTarget?.name ?? ''}" 吗？`}
        confirmText="执行"
        loading={runMutation.isPending}
        onConfirm={() => void handleRunConfirm()}
      >
        {runTarget?.command && <CommandPreview command={runTarget.command} />}
      </ConfirmDialog>
    </div>
  )
}
