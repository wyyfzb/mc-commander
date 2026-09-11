import type { ReactNode } from 'react'
import { clsx, type ClassValue } from 'clsx'
import { toneClasses } from './tone'
// 不用 twMerge：mcs-* 自定义 token 类会被 tailwind-merge 误判为 text-*/bg-* 同组冲突，
// 吞掉 tone 色类（text-mcs-warning-fg 会被 text-mcs-xs 覆盖删除）；clsx 保留全部类，
// 冲突由 CSS 层解决（color 与 font-size 本就不同组，互不冲突）

/**
 * Chip —— 通用标签/切换chip（全 token；Tasteful Friction 系列）
 * - 无 onClick → 静态展示 chip（tone 决定语义色）
 * - 有 onClick + selected → 切换按钮（aria-pressed）
 * - 有 onClick 无 selected → 动作按钮（模板填充等）
 * - 只读状态展示请用 StatusPill（同一 tone 词表，形状与档位不同）
 */

export type ChipTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'error' | 'info' | 'purple'

/** 中性两档：Chip 的静态面用 bg-default、次级用 bg-subtle（语义六色走共用词表 mcs/tone） */
const NEUTRAL_TONE_CLASSES: Record<'default' | 'muted', string> = {
  default: 'border-mcs-border-muted bg-mcs-bg-default text-mcs-text-muted',
  muted: 'border-mcs-border-muted bg-mcs-bg-subtle text-mcs-text-muted',
}

const TONE_CLASSES: Record<ChipTone, string> = {
  ...NEUTRAL_TONE_CLASSES,
  accent: toneClasses('accent'),
  success: toneClasses('success'),
  warning: toneClasses('warning'),
  error: toneClasses('error'),
  info: toneClasses('info'),
  purple: toneClasses('purple'),
}

/** 选中态：边界承担「已选中」的可辨识信息 → 强档描边（弱档仅装饰） */
const SELECTED_CLASSES =
  'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle text-mcs-accent-fg'

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
  const toneClass = selected ? SELECTED_CLASSES : TONE_CLASSES[tone]
  const state =
    onClick != null
      ? 'cursor-pointer select-none hover:bg-mcs-state-hover active:bg-mcs-state-pressed disabled:cursor-not-allowed disabled:opacity-50'
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
