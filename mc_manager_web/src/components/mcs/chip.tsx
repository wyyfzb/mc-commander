import type { ReactNode } from 'react'
import { clsx, type ClassValue } from 'clsx'
// 不用 twMerge：mcs-* 自定义 token 类会被 tailwind-merge 误判为 text-*/bg-* 同组冲突，
// 吞掉 tone 色类（text-mcs-warning-fg 会被 text-mcs-xs 覆盖删除）；clsx 保留全部类，
// 冲突由 CSS 层解决（color 与 font-size 本就不同组，互不冲突）

/**
 * Chip —— 通用标签/切换chip（全 token；Tasteful Friction 系列）
 * - 无 onClick → 静态展示 chip（tone 决定语义色）
 * - 有 onClick + selected → 切换按钮（aria-pressed）
 * - 有 onClick 无 selected → 动作按钮（模板填充等）
 */

export type ChipTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'error' | 'info' | 'purple'

const TONE_CLASSES: Record<ChipTone, string> = {
  default:
    'border-mcs-border-muted bg-mcs-bg-default text-mcs-text-muted',
  muted:
    'border-mcs-border-muted bg-mcs-bg-subtle text-mcs-text-subtle',
  accent:
    'border-mcs-accent-border bg-mcs-accent-bg-subtle text-mcs-accent-fg',
  success:
    'border-mcs-success-border bg-mcs-success-bg-subtle text-mcs-success-fg',
  warning:
    'border-mcs-warning-border bg-mcs-warning-bg-subtle text-mcs-warning-fg',
  error:
    'border-mcs-error-border bg-mcs-error-bg-subtle text-mcs-error-fg',
  info:
    'border-mcs-info-border bg-mcs-info-bg-subtle text-mcs-info-fg',
  purple:
    'border-mcs-purple-border bg-mcs-purple-bg-subtle text-mcs-purple-fg',
}

interface ChipProps {
  tone?: ChipTone
  /** 选中态（accent 强调）；仅切换类 chip 使用 */
  selected?: boolean
  disabled?: boolean
  /** 提供 onClick 才渲染为 button */
  onClick?: () => void
  ariaLabel?: string
  /** 悬停完整内容提示（截断展示用） */
  title?: string
  className?: string
  children: ReactNode
  /** 指针事件透传（命令预览悬停等场景） */
  onPointerEnter?: (e: React.PointerEvent) => void
  onPointerLeave?: (e: React.PointerEvent) => void
}

export function Chip({
  tone = 'default',
  selected,
  disabled = false,
  onClick,
  ariaLabel,
  title,
  className,
  children,
  onPointerEnter,
  onPointerLeave,
}: ChipProps) {
  const base =
    'inline-flex h-6 max-w-full items-center justify-center gap-1 truncate rounded-mcs-sm border px-2 text-mcs-xs transition-colors'
  const toneClass = selected ? TONE_CLASSES.accent : TONE_CLASSES[tone]
  const state =
    onClick != null
      ? 'cursor-pointer select-none hover:bg-mcs-state-hover disabled:cursor-not-allowed disabled:opacity-50'
      : ''
  const all = (...parts: ClassValue[]) => clsx(parts)

  if (onClick != null) {
    return (
      <button
        type="button"
        onClick={onClick}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        disabled={disabled}
        aria-pressed={selected != null ? (selected ? 'true' : 'false') : undefined}
        aria-label={ariaLabel}
        title={title}
        className={all(base, toneClass, state, className)}
      >
        {children}
      </button>
    )
  }
  return (
    <span
      title={title}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={all(base, toneClass, className)}
    >
      {children}
    </span>
  )
}
