import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      // 流光扫过替代明暗脉冲：加载态更「进行中」，与进度条同一语言
      className={cn(
        'animate-mcs-shimmer rounded-mcs-md bg-[linear-gradient(100deg,var(--mcs-bg-muted)_40%,var(--mcs-bg-secondary)_50%,var(--mcs-bg-muted)_60%)] bg-[length:200%_100%]',
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
