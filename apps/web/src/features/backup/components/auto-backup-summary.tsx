/**
 * AutoBackupSummary —— 备份页顶部「自动备份」只读摘要条
 *
 * 只做两件事：如实交代自动备份的**现状**，给一个去改它的出口。
 * 频率配置留在任务页（`/tasks`）——那条路径是低频的，把 cron 表单搬进高频页面会让
 * 同一件事出现两个配置源。
 *
 * 四态必须互相可区分，尤其「读取失败」不能显示成「没设置」：后者是**肯定式的假话**
 * （我们并不知道有没有），用户会据此以为自动备份没配，然后去建第二条任务。
 */
import { ArrowRight, CalendarClock, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { StatusPill } from '@/components/mcs/status-pill'
import { useTasks } from '@/features/tasks/queries'
import type { ScheduledTask } from '@/api/types'

/** 摘要条最多点名几条任务，其余折成「还有 N 条」——多条本身可能是重复建的故障信号 */
const NAMED_TASKS = 2

export function AutoBackupSummary({ instanceId }: { instanceId: string | null }) {
  const tasksQuery = useTasks(instanceId)

  // 加载：占位高度与结果态同高，避免内容到达时页面跳动
  if (tasksQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-mcs-sm border border-mcs-border-subtle px-2.5 py-1.5">
        <Skeleton className="size-3.5 rounded-mcs-xs" />
        <Skeleton className="h-3 w-48 rounded-mcs-xs" />
      </div>
    )
  }

  // 读取失败：说「读不到」并给重试，**不降级成「未配置」**
  if (tasksQuery.isError) {
    return (
      <NoticeBanner variant="warning" icon={TriangleAlert} role="alert">
        自动备份状态读取失败，无法确认是否已配置　
        <button
          type="button"
          className="cursor-pointer underline underline-offset-2 hover:text-mcs-warning-fg"
          onClick={() => void tasksQuery.refetch()}
        >
          重试
        </button>
      </NoticeBanner>
    )
  }

  const backupTasks = (tasksQuery.data ?? []).filter((t: ScheduledTask) => t.type === 'backup')

  // 未配置：给出口，而不是留一条空白
  if (backupTasks.length === 0) {
    return (
      <SummaryShell>
        <CalendarClock className="size-3.5 shrink-0 text-mcs-text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-text-muted">
          还没设置自动备份
        </span>
        <SummaryLink />
      </SummaryShell>
    )
  }

  const enabled = backupTasks.filter((t) => t.isEnabled)
  const named = enabled.slice(0, NAMED_TASKS)
  const rest = enabled.length - named.length

  return (
    <SummaryShell>
      <CalendarClock className="size-3.5 shrink-0 text-mcs-text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-text-muted">
        {enabled.length === 0 ? (
          // 全部停用 ≠ 没配置：任务还在，只是关着，用户回去打开即可
          <>自动备份已关闭（{backupTasks.length} 条任务均已停用）</>
        ) : (
          <>
            自动备份：
            {named.map((t, i) => (
              <span key={t.id}>
                {i > 0 && '、'}
                <span className="font-mono text-mcs-text-default">{t.cronExpression}</span>
                （由任务「{t.name}」提供）
              </span>
            ))}
            {rest > 0 && `，还有 ${rest} 条`}
          </>
        )}
      </span>
      {enabled.length > 1 && (
        // 多条启用的 backup 任务会各自触发保留策略清理，互相淘汰历史快照
        <StatusPill tone="warning" className="text-mcs-2xs">
          {enabled.length} 条启用中
        </StatusPill>
      )}
      <SummaryLink />
    </SummaryShell>
  )
}

function SummaryShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-mcs-sm border border-mcs-border-subtle px-2.5 py-1.5">
      {children}
    </div>
  )
}

function SummaryLink() {
  return (
    <Link
      to="/tasks"
      className="flex shrink-0 items-center gap-0.5 text-mcs-xs text-mcs-accent-fg hover:underline"
    >
      去调整
      <ArrowRight className="size-3" aria-hidden />
    </Link>
  )
}
