import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import type { ChipTone } from './chip'

/**
 * StatusPill —— 只读状态标识药丸（基于 Chip 8-tone 体系）
 * - 专用于只读状态展示（实例状态、命令结果、启用/禁用等）
 * - 交互类标签（切换、选择）使用 Chip 组件
 * - variant="status"（默认）：带 bg-subtle 填充，用于突出状态
 * - variant="outline"：仅边框，用于低优先级标签/标识
 */

const STATUS_CLASSES: Record<ChipTone, string> = {
  default: 'border-mcs-border-muted bg-mcs-bg-subtle text-mcs-text-subtle',
  muted: 'border-mcs-border-muted bg-mcs-bg-subtle text-mcs-text-subtle',
  accent: 'border-mcs-accent-border bg-mcs-accent-bg-subtle text-mcs-accent-fg',
  success: 'border-mcs-success-border bg-mcs-success-bg-subtle text-mcs-success-fg',
  warning: 'border-mcs-warning-border bg-mcs-warning-bg-subtle text-mcs-warning-fg',
  error: 'border-mcs-error-border bg-mcs-error-bg-subtle text-mcs-error-fg',
  info: 'border-mcs-info-border bg-mcs-info-bg-subtle text-mcs-info-fg',
  purple: 'border-mcs-purple-border bg-mcs-purple-bg-subtle text-mcs-purple-fg',
}

const OUTLINE_CLASSES: Record<ChipTone, string> = {
  default: 'border-mcs-border-muted text-mcs-text-default',
  muted: 'border-mcs-border-muted text-mcs-text-subtle',
  accent: 'border-mcs-accent-border text-mcs-accent-fg',
  success: 'border-mcs-success-border text-mcs-success-fg',
  warning: 'border-mcs-warning-border text-mcs-warning-fg',
  error: 'border-mcs-error-border text-mcs-error-fg',
  info: 'border-mcs-info-border text-mcs-info-fg',
  purple: 'border-mcs-purple-border text-mcs-purple-fg',
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
      className={clsx(
        'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap',
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  )
}
