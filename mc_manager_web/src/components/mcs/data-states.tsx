/**
 * DataStates —— 统一数据状态视觉（空态 / 错误态 / 列表加载骨架）
 * 由 DataTableShell（表格行内态）与列表页（区块态）共享，
 * 保证三态在表格与列表两种载体下视觉语言一致。
 * 纪律：视觉组件不携带外边距，由载体（td / 区块）控制留白。
 */
import type { ReactNode } from 'react'
import { AlertTriangle, Inbox } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
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
