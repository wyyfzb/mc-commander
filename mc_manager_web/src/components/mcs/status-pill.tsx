import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ChipTone } from './chip'
import { toneClasses, toneOutlineClasses } from './tone'

/**
 * StatusPill —— 只读状态标识药丸（基于 Chip 8-tone 体系）
 * - 专用于只读状态展示（实例状态、命令结果、启用/禁用、版本与标签列表）
 * - 交互类标签（切换、选择）使用 Chip 组件；计数（数量/条数）使用 CountBadge
 * - variant="status"（默认）：带 bg-subtle 填充，用于突出状态
 * - variant="outline"：仅边框，用于低优先级标签/标识
 *
 * 中性两档视觉相同：default 是「未指定 tone」的兜底、muted 是「刻意弱化」，
 * 语义不同故都保留；语义六色统一取自 mcs/tone，勿在本文件再抄一份色值
 */

const NEUTRAL_STATUS_CLASSES: Record<'default' | 'muted', string> = {
  default: 'border-mcs-border-muted bg-mcs-bg-subtle text-mcs-text-muted',
  muted: 'border-mcs-border-muted bg-mcs-bg-subtle text-mcs-text-muted',
}

const STATUS_CLASSES: Record<ChipTone, string> = {
  ...NEUTRAL_STATUS_CLASSES,
  accent: toneClasses('accent'),
  success: toneClasses('success'),
  warning: toneClasses('warning'),
  error: toneClasses('error'),
  info: toneClasses('info'),
  purple: toneClasses('purple'),
}

const OUTLINE_CLASSES: Record<ChipTone, string> = {
  default: 'border-mcs-border-muted text-mcs-text-default',
  muted: 'border-mcs-border-muted text-mcs-text-muted',
  accent: toneOutlineClasses('accent'),
  success: toneOutlineClasses('success'),
  warning: toneOutlineClasses('warning'),
  error: toneOutlineClasses('error'),
  info: toneOutlineClasses('info'),
  purple: toneOutlineClasses('purple'),
}

export interface StatusPillProps {
  tone?: ChipTone
  variant?: 'status' | 'outline'
  className?: string
  /** 悬停完整内容提示（截断展示用） */
  title?: string
  children: ReactNode
}

export function StatusPill({
  tone = 'default',
  variant = 'status',
  className,
  title,
  children,
}: StatusPillProps) {
  const toneClass = variant === 'outline' ? OUTLINE_CLASSES[tone] : STATUS_CLASSES[tone]
  return (
    <span
      data-status-pill
      data-status-tone={tone}
      data-status-variant={variant}
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap',
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  )
}
