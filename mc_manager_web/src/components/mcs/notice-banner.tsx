/**
 * NoticeBanner —— 通用提示条（快照/截断/降级等非阻断提示）
 * 变体四色走 --mcs-* 状态 token（12% alpha 容器底 + 状态色文字），三重编码由调用方图标承担
 * 级别选用（何时该常驻、何时用 toast）见 docs/design-review-guidelines.md §反馈级别三级口径
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { toneClasses, type SemanticTone } from '@/components/mcs/tone'

type NoticeVariant = Extract<SemanticTone, 'info' | 'warning' | 'error' | 'success'>

const VARIANT_CLASSES: Record<NoticeVariant, string> = {
  info: toneClasses('info'),
  warning: toneClasses('warning'),
  error: toneClasses('error'),
  success: toneClasses('success'),
}

interface NoticeBannerProps {
  variant: NoticeVariant
  icon?: LucideIcon
  children: ReactNode
  className?: string
  /** 播报角色：错误/失败用 alert（打断式），普通提示用 status（默认） */
  role?: 'status' | 'alert'
}

export function NoticeBanner({
  variant,
  icon: Icon,
  children,
  className,
  role = 'status',
}: NoticeBannerProps) {
  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-1.5 rounded-mcs-sm border px-2.5 py-1.5 text-mcs-xs',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {Icon && <Icon className="mt-px size-3.5 shrink-0" aria-hidden />}
      {/* flex-1：内容区占满剩余宽度，children 内可做两端对齐的操作区布局 */}
      <span className="flex-1">{children}</span>
    </div>
  )
}
