/**
 * DataStates —— 统一数据状态视觉（空态 / 错误态 / 失败留旧值告警 / 列表加载骨架）
 * 由 DataTableShell（表格行内态）与列表页（区块态）共享，
 * 保证各态在表格与列表两种载体下视觉语言一致。
 * 相位判定本身不在这里——见 lib/query-phase.ts，本文件只管「某一相长什么样」。
 * 纪律：视觉组件不携带外边距，由载体（td / 区块）控制留白。
 */
import type { ReactNode } from 'react'
import { AlertTriangle, Inbox } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { getFriendlyErrorText } from '@/api/errors'

/** 统一空态视觉：居中图标 + 文案 + 可选操作按钮组 */
export function EmptyStateVisual({ text, actions }: { text: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 text-mcs-text-muted">
      <Inbox className="size-8 opacity-60" aria-hidden />
      <p className="text-mcs-sm">{text}</p>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

/** 统一错误态视觉：警示图标 + 友好错误文案 + 可选重试区 */
export function ErrorStateVisual({
  error,
  retry,
}: {
  error: unknown
  /** 重试操作区（通常为 Button），不传则不渲染 */
  retry?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <AlertTriangle aria-hidden className="h-5 w-5 text-mcs-error-fg" />
      <span className="text-mcs-sm text-mcs-error-fg">加载失败：{getFriendlyErrorText(error)}</span>
      {retry}
    </div>
  )
}

/**
 * 失败但仍有上一轮数据时的非阻断告警——主体保留旧值，这里只说明「看到的是旧数据」并给重试。
 * 与 ErrorStateVisual 的分工：后者替换主体（无数据可留），本件与主体共存。
 * 级别取 warning 不取 error：界面没有坏，坏的是上游，而用户手上的数据仍然可用。
 */
export function StaleQueryNotice({
  error,
  onRetry,
  className,
}: {
  error: unknown
  onRetry: () => void
  className?: string
}) {
  return (
    <NoticeBanner variant="warning" icon={AlertTriangle} className={className}>
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span>更新失败，当前显示上一轮结果：{getFriendlyErrorText(error)}</span>
        <Button size="xs" variant="outline" onClick={onRetry}>
          重试
        </Button>
      </span>
    </NoticeBanner>
  )
}

/** 列表加载骨架（图标块 + 双行文字），用于非表格列表 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-1 p-4" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <Skeleton className="size-5 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}
