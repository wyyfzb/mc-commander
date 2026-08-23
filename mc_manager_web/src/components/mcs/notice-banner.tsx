/**
 * NoticeBanner —— 通用提示条（快照/截断/降级等非阻断提示）
 * 变体四色走 --mcs-* 状态 token（12% alpha 容器底 + 状态色文字），三重编码由调用方图标承担
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type NoticeVariant = 'info' | 'warning' | 'error' | 'success'

const VARIANT_CLASSES: Record<NoticeVariant, string> = {
  info: 'border-mcs-info-border bg-mcs-info-bg-subtle text-mcs-info-fg',
  warning: 'border-mcs-warning-border bg-mcs-warning-bg-subtle text-mcs-warning-fg',
  error: 'border-mcs-error-border bg-mcs-error-bg-subtle text-mcs-error-fg',
  success: 'border-mcs-success-border bg-mcs-success-bg-subtle text-mcs-success-fg',
}

interface NoticeBannerProps {
  variant: NoticeVariant
  icon?: LucideIcon
  children: ReactNode
  className?: string
}

export function NoticeBanner({ variant, icon: Icon, children, className }: NoticeBannerProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-1.5 rounded-mcs-sm border px-2.5 py-1.5 text-mcs-xs',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {Icon && <Icon className="mt-px size-3.5 shrink-0" aria-hidden />}
      <span>{children}</span>
    </div>
  )
}
