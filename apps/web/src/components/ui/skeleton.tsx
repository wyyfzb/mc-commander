import { cn } from '@/lib/utils'

/** 骨架配色面：`default` 跟随主题；`terminal` 用于深底容器（终端），亮暗主题下都取终端色阶 */
export type SkeletonTone = 'default' | 'terminal'

const TONE_CLASSES: Record<SkeletonTone, string> = {
  default:
    'bg-[linear-gradient(100deg,var(--mcs-bg-muted)_40%,var(--mcs-bg-secondary)_50%,var(--mcs-bg-muted)_60%)]',
  // 终端底是深色固定面（亮暗同值），骨架取同族亮阶的低对比组合
  terminal:
    'bg-[linear-gradient(100deg,color-mix(in_oklch,var(--mcs-terminal-fg)_10%,transparent)_40%,color-mix(in_oklch,var(--mcs-terminal-fg)_20%,transparent)_50%,color-mix(in_oklch,var(--mcs-terminal-fg)_10%,transparent)_60%)]',
}

function Skeleton({
  className,
  tone = 'default',
  ...props
}: React.ComponentProps<'div'> & { tone?: SkeletonTone }) {
  return (
    <div
      data-slot="skeleton"
      // 流光扫过替代明暗脉冲：加载态更「进行中」，与进度条同一语言
      className={cn(
        'animate-mcs-shimmer rounded-mcs-md bg-[length:200%_100%]',
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
