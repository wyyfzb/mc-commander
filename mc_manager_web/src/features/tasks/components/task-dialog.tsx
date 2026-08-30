/**
 * TaskDialog —— 定时任务新建/编辑对话框
 * - 新建/编辑双模式：task=null 新建（空表单）；task 非空编辑（回填初始值）
 * - cron 实时中文描述（cronDescription）+ 可视化编辑器开关（CronEditor）+ 7 预置 chip（CRON_PRESETS）
 * - 命令输入仅 type==='command' 时显示；启用 Switch
 * - 校验：名称/cron 任一为空 → toast.warning「请填写任务名称和 Cron 表达式」不发 onSave
 * - dirty 关闭拦截：表单有改动（对比初始值）时点遮罩/ESC/关闭/取消 → 弹确认（继续编辑/放弃修改）；
 *   无改动直接关闭。保存中（saving）禁止关闭
 */
import { useState } from 'react'
import { ChevronUp, Info, Loader2, SlidersHorizontal } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
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
import { toast } from 'sonner'
import { CRON_PRESETS, cronDescription } from '@/lib/mc-cron'
import { TASK_TYPE_OPTIONS, type TaskType } from '@/lib/mc-deploy'
import { CronEditor } from './cron-editor'
import type { ScheduledTask, TaskCreatePayload } from '@/api/types'

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
    if (name.trim().length === 0 || cron.trim().length === 0) {
      toast.warning('请填写任务名称和 Cron 表达式')
      return
    }
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
                onChange={(e) => setName(e.target.value)}
                placeholder="如：每日自动重启"
              />
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
                  onChange={(e) => setCron(e.target.value)}
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
              <p className="text-mcs-xs text-mcs-text-subtle">格式：分 时 日 月 周（* 表示任意）</p>
              {cronDesc.length > 0 && (
                <p className="flex items-start gap-1 text-mcs-xs text-mcs-text-subtle">
                  <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>{cronDesc}</span>
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
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="animate-spin" aria-hidden />}
              {isEdit ? '保存' : '创建'}
            </Button>
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
