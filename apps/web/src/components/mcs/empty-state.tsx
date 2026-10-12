import type { ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * EmptyState —— 页面/区块空态（图标 + 主标题 + 说明 + 可选 CTA）
 * 收敛「暂无服务器实例」「暂无数据」等各页重复内联空态；CTA 让空态可行动
 */

export interface EmptyStateAction {
  label: string
  onClick: () => void
}

/** CTA 风格：outline 描边（默认，次级行动）/ greenFilled 品牌绿实底（空态主行动入口） */
export type EmptyStateActionVariant = 'outline' | 'greenFilled'

interface EmptyStateProps {
  icon?: ComponentType<{ className?: string }>
  title: string
  hint?: React.ReactNode
  action?: EmptyStateAction
  actionVariant?: EmptyStateActionVariant
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  actionVariant = 'outline',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
    >
      {Icon && (
        <span className="flex size-16 items-center justify-center rounded-mcs-md bg-mcs-bg-muted shadow-mcs-card ring-1 ring-mcs-border-muted">
          <Icon className="size-7 text-mcs-text-muted" aria-hidden />
        </span>
      )}
      <p className="text-mcs-sm font-medium text-mcs-text-muted">{title}</p>
      {hint && <p className="text-mcs-xs text-mcs-text-muted">{hint}</p>}
      {action && (
        <Button
          variant={actionVariant === 'greenFilled' ? 'default' : 'outline'}
          size="sm"
          className="mt-2"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  )
}
