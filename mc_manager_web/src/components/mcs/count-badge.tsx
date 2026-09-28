import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * CountBadge —— 只读计数徽章（数量/条数）。
 *
 * 与 StatusPill 的分工是语义而非外形：状态答「怎么了」（运行中/失败/已启用），
 * 计数答「有几个」（已选 N）。版本号、百分比、带单位规格值与分类/依赖标签都属状态与标识口径，
 * 不要因为「都是一小段字」塞进来（见 AGENTS.md「标签与状态展示」）；需要语义色的计数
 * （图标未读浮标、实底徽章）不属这里的中性档形状，仍就地着色。
 *
 * 形状刻意与 StatusPill 中性档逐类一致：现有计数点从 `StatusPill tone="muted"` 迁来时
 * 零视觉变化；用例锁定这份一致，任一方漂移即红。
 */

const COUNT_BADGE_CLASSES =
  'inline-flex h-5 shrink-0 items-center rounded-full border border-mcs-border-muted bg-mcs-bg-subtle px-2 text-xs font-medium whitespace-nowrap text-mcs-text-muted'

interface CountBadgeProps {
  className?: string
  /** 悬停完整内容提示（截断展示用） */
  title?: string
  children: ReactNode
}

export function CountBadge({ className, title, children }: CountBadgeProps) {
  return (
    <span data-count-badge title={title} className={cn(COUNT_BADGE_CLASSES, className)}>
      {children}
    </span>
  )
}
