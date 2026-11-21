import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * 输入控件基座：inset 填充面 + 交互描边；focus 用 2px 环补偿 1px 边框的可见性。
 * inset 对画布只有 1.03:1，画布上的表单需先包一层 muted 嵌块（见 coord-teleport-form）。
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-10 w-full min-w-0 rounded-mcs-sm border border-input bg-mcs-bg-inset px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-mcs-bg-subtle disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/80 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
