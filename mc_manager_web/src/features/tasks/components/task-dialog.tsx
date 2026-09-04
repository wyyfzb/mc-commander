/**
 * TaskDialog —— 定时任务新建/编辑对话框
 * - 新建/编辑双模式：task=null 新建（空表单）；task 非空编辑（回填初始值）
 * - cron 实时中文描述（cronDescription）+ 可视化编辑器开关（CronEditor）+ 7 预置 chip（CRON_PRESETS）
 * - 命令输入仅 type==='command' 时显示；启用 Switch
 * - 校验：名称/cron 任一为空 → 行内错误提示（对齐 deploy-dialog 范式），不发 onSave
 * - dirty 关闭拦截：表单有改动（对比初始值）时点遮罩/ESC/关闭/取消 → 弹确认（继续编辑/放弃修改）；
 *   无改动直接关闭。保存中（saving）禁止关闭
 */
import { useState } from 'react'
import { ChevronUp, CircleAlert, Info, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getFriendlyErrorText } from '@/api/errors'
import { LoadingButton } from '@/components/mcs/loading-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { Chip } from '@/components/mcs/chip'
import { CRON_PRESETS, cronDescription, formatNextRun } from '@/lib/mc-cron'
import { formatDurationMs, formatUtcNaive } from '@/lib/format'
import { TASK_TYPE_OPTIONS, type TaskType } from '@/lib/mc-deploy'
import { CronEditor } from './cron-editor'
import { useTaskHistory } from '../queries'
import type { ScheduledTask, TaskCreatePayload, TaskRunHistory } from '@/api/types'

export interface TaskDialogProps {
  /** null=新建；非空=编辑（回填初始值） */
  task: ScheduledTask | null
  /** 关闭回调（保存/取消后由页面调用） */
  onClose: () => void
  /** 保存回调：页面负责 mutation（create/update），失败抛错由页面 toast */
  onSave: (payload: TaskCreatePayload) => Promise<void>
  /** 保存中（页面 mutation pending） */
  saving: boolean
}

export function TaskDialog({ task, onClose, onSave, saving }: TaskDialogProps) {
  const isEdit = task !== null
  /** 初始值（新建=空表单默认：类型重启、未启用） */
  const initial = {
    name: task?.name ?? '',
    type: (task?.type ?? 'restart') as TaskType,
    cron: task?.cronExpression ?? '',
    command: task?.command ?? '',
    enabled: task?.isEnabled ?? true,
  }

  const [name, setName] = useState(initial.name)
  const [type, setType] = useState<TaskType>(initial.type)
  const [cron, setCron] = useState(initial.cron)
  const [command, setCommand] = useState(initial.command)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [showEditor, setShowEditor] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [nameError, setNameError] = useState('')
  const [cronError, setCronError] = useState('')

  /** 表单相对初始值是否有改动（dirty 关闭拦截依据） */
  const dirty =
    name !== initial.name ||
    type !== initial.type ||
    cron !== initial.cron ||
    command !== initial.command ||
    enabled !== initial.enabled

  /** 所有关闭路径（遮罩/ESC/X/取消按钮）统一入口：dirty → 确认，否则直接关 */
  const handleOpenChange = (next: boolean) => {
    if (next || saving) return
    if (dirty) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  const handleSave = async () => {
    let valid = true
    if (name.trim().length === 0) { setNameError('请填写任务名称'); valid = false }
    else { setNameError('') }
    if (cron.trim().length === 0) { setCronError('请填写 Cron 表达式'); valid = false }
    else { setCronError('') }
    if (!valid) return
    try {
      await onSave({
        name: name.trim(),
        type,
        cronExpression: cron.trim(),
        command: type === 'command' ? command.trim() : null,
        isEnabled: enabled,
      })
      // 保存成功后由页面调用 onClose（契约：保存/取消后由页面调用）
    } catch {
      // 失败 toast 由页面处理；保持弹窗打开供调整
    }
  }

  const cronDesc = cronDescription(cron)
  const nextRunHint = formatNextRun(cron)

  return (
    <>
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? '编辑任务' : '新建定时任务'}</DialogTitle>
            <DialogDescription>设置任务名称、触发时间与执行内容。</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3.5">
            {/* 任务名称 */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-name">任务名称</Label>
              <Input
                id="task-name"
                value={name}
                onChange={(e) => { setName(e.target.value); setNameError('') }}
                placeholder="如：每日自动重启"
              />
              {nameError !== '' && (
                <p className="text-mcs-xs text-mcs-error-fg">{nameError}</p>
              )}
            </div>

            {/* 任务类型 */}
            <div className="flex flex-col gap-1.5">
              <Label>任务类型</Label>
              <Select value={type} onValueChange={(v) => setType(v as TaskType)}>
                <SelectTrigger aria-label="任务类型" className="w-full">
                  <SelectValue placeholder="任务类型" />
                </SelectTrigger>
                <SelectContent>
                  {TASK_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Cron 表达式 + 实时描述 + 可视化编辑器 + 预置 */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-cron">Cron 表达式</Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="task-cron"
                  value={cron}
                  onChange={(e) => { setCron(e.target.value); setCronError('') }}
                  placeholder="如：0 4 * * * （每天 4:00）"
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="可视化编辑"
                  aria-pressed={showEditor}
                  onClick={() => setShowEditor((v) => !v)}
                >
                  {showEditor ? <ChevronUp aria-hidden /> : <SlidersHorizontal aria-hidden />}
                </Button>
              </div>
              {cronError !== '' && (
                <p className="text-mcs-xs text-mcs-error-fg">{cronError}</p>
              )}
              <p className="text-mcs-xs text-mcs-text-subtle">格式：分 时 日 月 周（* 表示任意）</p>
              {cronDesc.length > 0 && (
                <p className="flex items-start gap-1 text-mcs-xs text-mcs-text-subtle">
                  <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>{cronDesc}</span>
                </p>
              )}
              {nextRunHint.length > 0 && (
                <p className="flex items-start gap-1 text-mcs-xs text-mcs-text-subtle">
                  <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>下次运行约 {nextRunHint}</span>
                </p>
              )}
              {showEditor && <CronEditor value={cron} onChange={setCron} />}
              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((preset) => {
                  const active = cron.trim() === preset.value
                  return (
                    <Chip
                      key={preset.value}
                      onClick={() => {
                        setCron(preset.value)
                        setCronError('')
                        if (name.trim() === '') {
                          const typeLabel = TASK_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type
                          setName(`${preset.label} ${typeLabel}`)
                        }
                      }}
                      selected={active}
                    >
                      {preset.label}
                    </Chip>
                  )
                })}
              </div>
            </div>

            {/* 命令输入（仅 type==='command'） */}
            {type === 'command' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="task-command">执行的命令</Label>
                <Input
                  id="task-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="如：say 服务器即将重启"
                  className="font-mono"
                />
              </div>
            )}

            {/* 启用 */}
            <div className="flex items-center justify-between">
              <Label htmlFor="task-enabled">启用</Label>
              <Switch
                id="task-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
                aria-label="启用"
              />
            </div>

            {/* 最近执行（仅编辑模式；排障时间线，服务端 task_run_history） */}
            {isEdit && task && <TaskRunHistory taskId={task.id} />}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <LoadingButton onClick={() => void handleSave()} loading={saving}>
              {isEdit ? '保存' : '创建'}
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* dirty 关闭确认：允许关闭但需显式确认 */}
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={(next) => {
          if (!next) setConfirmClose(false)
        }}
        title="放弃未保存的修改？"
        description="表单有未保存的修改，关闭对话框将丢失这些修改。"
        confirmText="放弃修改"
        cancelText="继续编辑"
        onConfirm={() => {
          setConfirmClose(false)
          onClose()
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  )
}

/**
 * 执行结果语义色映射（与 task-list LAST_RUN_STATUS 同源）。
 * 历史表只落真实执行结果，无 never。
 */
const RUN_STATUS_META: Record<TaskRunHistory['status'], { dot: string; text: string; label: string }> = {
  success: { dot: 'bg-mcs-success-fg', text: 'text-mcs-success-fg', label: '成功' },
  failed: { dot: 'bg-mcs-error-fg', text: 'text-mcs-error-fg', label: '失败' },
  skipped: { dot: 'bg-mcs-warning-fg', text: 'text-mcs-warning-fg', label: '跳过' },
}

/**
 * 最近执行时间线（编辑模式）：倒序最近 10 条，
 * 状态语义色圆点 + 触发时间 + 耗时 + 失败原因（截断，悬停看全文）。
 */
function TaskRunHistory({ taskId }: { taskId: number }) {
  const { data: runs, isLoading, isError, error, refetch } = useTaskHistory(taskId)

  return (
    <div className="flex flex-col gap-1.5" data-testid="task-run-history">
      <Label>最近执行</Label>
      {isLoading ? (
        <div className="space-y-1.5" aria-label="加载执行历史中">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-start gap-1.5 py-1">
          <p className="flex items-center gap-1 text-mcs-xs text-mcs-error-fg">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            执行历史加载失败：{getFriendlyErrorText(error)}
          </p>
          <Button variant="outline" size="sm" className="h-6 text-mcs-2xs" onClick={() => void refetch()}>
            重试
          </Button>
        </div>
      ) : !runs || runs.length === 0 ? (
        <p className="text-mcs-xs text-mcs-text-subtle">暂无执行记录</p>
      ) : (
        <ul
          className="max-h-40 space-y-1.5 overflow-y-auto rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-2 shadow-mcs-card"
          aria-label="最近执行列表"
        >
          {runs.map((run) => {
            const meta = RUN_STATUS_META[run.status]
            return (
              <li key={run.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5 text-mcs-xs">
                  <span className={`size-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
                  <span className={meta.text}>{meta.label}</span>
                  <span className="text-mcs-text-muted">{formatUtcNaive(run.runAt)}</span>
                  {run.durationMs !== null && (
                    <span className="text-mcs-text-subtle">· {formatDurationMs(run.durationMs)}</span>
                  )}
                </div>
                {run.error && (
                  <p
                    className="truncate pl-3 text-mcs-xs text-mcs-error-fg"
                    title={run.error}
                  >
                    {run.error}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
