/**
 * TaskList —— 定时任务列表
 * - 行结构：36px 类型 tone 图标（浅底）→ 名称 + 类型徽章（同 tone）
 *   → cron mono + 命令（有则 Terminal 图标）→「上次运行/下次运行」时间行 → 右侧启用
 *   Switch / 立即执行 / 编辑 / 删除
 * - TASK_TYPE_TONES：restart→warning / backup→info / command→purple /
 *   stop→error / start→success；tone 类统一 bg-mcs-{tone}-bg-subtle + text-mcs-{tone}-fg +
 *   border-mcs-{tone}-border（token 唯一来源 src/styles/）
 * - 时间行 formatTaskDate（MM-DD HH:mm 本地时区；null → '从未'）
 * - 容器：实底卡（风格 A 列表实底，禁 backdrop-blur）+ 行分隔；空态含新建任务按钮；加载骨架行
 */
import { AlertCircle, Clock, Hourglass, Pencil, Play, Terminal, Timer, Trash2 } from 'lucide-react'
import { IconButton } from '@/components/mcs/icon-button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusPill } from '@/components/mcs/status-pill'
import { EmptyState } from '@/components/mcs/empty-state'
import {
  TASK_TYPE_LABELS,
  TASK_TYPE_TONES,
  formatNextRunCountdown,
  formatTaskDate,
  type TaskTypeTone,
} from '@/lib/mc-deploy'
import { useNow } from '@/hooks/use-now'
import type { ScheduledTask } from '@/api/types'

export interface TaskListProps {
  tasks: ScheduledTask[]
  isLoading: boolean
  /** 正在立即执行的任务 id（对应行「立即执行」按钮禁用 + hourglass） */
  runningTaskId: number | null
  /** 启用开关切换 */
  onToggle: (task: ScheduledTask, enabled: boolean) => void
  /** 立即执行 */
  onRunNow: (task: ScheduledTask) => void
  /** 编辑 */
  onEdit: (task: ScheduledTask) => void
  /** 删除 */
  onDelete: (task: ScheduledTask) => void
  /** 空态「新建任务」按钮（页面打开创建对话框） */
  onNewTask: () => void
}

/** tone → 图标/徽章类（完整字面量类名，Tailwind 主题色静态生成；全 token 引用） */
const TONE_CLASSES: Record<TaskTypeTone, string> = {
  warning: 'bg-mcs-warning-bg-subtle text-mcs-warning-fg border-mcs-warning-border',
  info: 'bg-mcs-info-bg-subtle text-mcs-info-fg border-mcs-info-border',
  purple: 'bg-mcs-purple-bg-subtle text-mcs-purple-fg border-mcs-purple-border',
  error: 'bg-mcs-error-bg-subtle text-mcs-error-fg border-mcs-error-border',
  success: 'bg-mcs-success-bg-subtle text-mcs-success-fg border-mcs-success-border',
}

/**
 * 上次运行结果标记：语义色圆点 + 短文本，服主扫一眼即知成败
 * 语义映射：成功→success / 失败→error / 跳过→warning；never（未运行）不渲染标记
 * 圆点模式与 connection-form 状态行一致（rounded-full bg-mcs-{语义}-fg），
 * 此处 size-1.5（列表密度更高，圆点更小）
 */
const LAST_RUN_STATUS: Record<
  ScheduledTask['lastRunStatus'],
  { dot: string; text: string; label: string } | null
> = {
  success: { dot: 'bg-mcs-success-fg', text: 'text-mcs-success-fg', label: '成功' },
  failed: { dot: 'bg-mcs-error-fg', text: 'text-mcs-error-fg', label: '失败' },
  skipped: { dot: 'bg-mcs-warning-fg', text: 'text-mcs-warning-fg', label: '跳过' },
  never: null,
}

export function TaskList({
  tasks,
  isLoading,
  runningTaskId,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
  onNewTask,
}: TaskListProps) {
  // 列表级单一倒计时时钟（每行独立 useNow 会每行一个 60s 定时器）
  const now = useNow()
  return (
    <div className="overflow-hidden rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted shadow-mcs-card">
      {isLoading ? (
        /* 骨架行 */
        <div data-testid="task-skeletons" className="space-y-1 p-4" aria-label="加载任务中">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <Skeleton className="size-9 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : tasks.length === 0 ? (
        /* 空态（EmptyState 统一组件；绿实底 CTA 为页面主行动） */
        <EmptyState
          icon={Clock}
          title="暂无定时任务"
          hint="创建定时任务以自动执行重启、备份等操作"
          action={{ label: '新建任务', onClick: onNewTask }}
          actionVariant="greenFilled"
        />
      ) : (
        <div className="divide-y divide-mcs-border-subtle">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              now={now}
              running={runningTaskId === task.id}
              onToggle={onToggle}
              onRunNow={onRunNow}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 单行任务 */
function TaskRow({
  task,
  now,
  running,
  onToggle,
  onRunNow,
  onEdit,
  onDelete,
}: {
  task: ScheduledTask
  /** 列表级倒计时时钟（TaskList 单一 useNow 下传，避免每行一个定时器） */
  now: number
  /** runningTaskId 命中：立即执行禁用 + hourglass */
  running: boolean
  onToggle: (task: ScheduledTask, enabled: boolean) => void
  onRunNow: (task: ScheduledTask) => void
  onEdit: (task: ScheduledTask) => void
  onDelete: (task: ScheduledTask) => void
}) {
  const tone = TASK_TYPE_TONES[task.type]
  const toneClasses = TONE_CLASSES[tone]
  const lastRunMeta = LAST_RUN_STATUS[task.lastRunStatus]
  /** 下次执行倒计时文案（null → 保持「从未」） */
  const nextRunCountdown = formatNextRunCountdown(task.nextRunAt, now)

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* 36px 类型图标（tone 浅底 + tone 前景） */}
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-mcs-sm', toneClasses)}
        aria-hidden
      >
        <Clock className="size-4.5" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        {/* 名称 + 类型徽章（同 tone） */}
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-mcs-sm font-semibold text-mcs-text-default" title={task.name}>
            {task.name}
          </span>
          <StatusPill tone={tone} className="text-mcs-xs">
            {TASK_TYPE_LABELS[task.type]}
          </StatusPill>
        </div>

        {/* cron mono + 命令（有则 Terminal 图标） */}
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-mcs-xs">
          <Timer className="size-3 shrink-0 text-mcs-text-subtle" aria-hidden />
          <span className="shrink-0 font-mono text-mcs-text-muted">{task.cronExpression}</span>
          {task.command !== null && task.command.length > 0 && (
            <>
              <Terminal className="size-3 shrink-0 text-mcs-text-subtle" aria-hidden />
              <span className="truncate font-mono text-mcs-text-muted" title={task.command}>
                {task.command}
              </span>
            </>
          )}
        </div>

        {/* 上次/下次运行时间行（formatTaskDate；null → 从未）；结果标记（never 不渲染）
            下次运行追加倒计时（useNow 每分钟刷新；null → 保持「从未」） */}
        <p className="mt-0.5 truncate text-mcs-xs text-mcs-text-muted">
          {`上次运行: ${formatTaskDate(task.lastRunAt)}`}
          {lastRunMeta && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'ml-1.5 inline-flex items-center gap-1 font-medium',
                    lastRunMeta.text,
                    task.lastRunStatus === 'failed' && task.lastRunError && 'cursor-help underline decoration-dashed underline-offset-2',
                  )}
                >
                  <span className={cn('size-1.5 rounded-full', lastRunMeta.dot)} aria-hidden />
                  {lastRunMeta.label}
                  {task.lastRunStatus === 'failed' && task.lastRunError && (
                    <AlertCircle className="size-3" aria-hidden />
                  )}
                </span>
              </TooltipTrigger>
              {task.lastRunStatus === 'failed' && task.lastRunError && (
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="text-mcs-xs font-medium text-mcs-error-fg">失败原因</p>
                  <p className="mt-1 text-xs text-mcs-text-default">{task.lastRunError}</p>
                </TooltipContent>
              )}
            </Tooltip>
          )}
          {`  ·  下次运行: ${nextRunCountdown === null ? '从未' : `${formatTaskDate(task.nextRunAt)}（${nextRunCountdown}）`}`}
        </p>
      </div>

      {/* 右侧操作：启用 / 立即执行 / 编辑 / 删除 */}
      <div className="flex shrink-0 items-center gap-0.5">
        <Switch
          checked={task.isEnabled}
          onCheckedChange={(checked) => onToggle(task, checked)}
          aria-label={`${task.name} 启用开关`}
        />
        <IconButton
          disabled={running}
          aria-label={`${task.name} 立即执行`}
          className="text-mcs-accent-fg"
          onClick={() => onRunNow(task)}
        >
          {running ? <Hourglass className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
        </IconButton>
        <IconButton
          aria-label={`${task.name} 编辑`}
          className="text-mcs-text-muted hover:text-mcs-text-default"
          onClick={() => onEdit(task)}
        >
          <Pencil className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton
          aria-label={`${task.name} 删除`}
          className="text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
          onClick={() => onDelete(task)}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </IconButton>
      </div>
    </div>
  )
}
