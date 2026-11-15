'use client'

import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    /* 轨道 36×24：高度取 24px 而不是 20px，因为 WCAG 2.2 SC 2.5.8 要求指针目标 ≥24×24，
       而「靠间距豁免」依赖每个调用点的布局上下文（密集面板里 switch 可能挨得很近），
       基座自己达标才不会在某个页面破功。宽度与滑块位移不变，只是轨道上下各多 2px。 */
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-6 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-colors outline-none',
        // 未选中态需轨道背景（--mcs-border-default）：透明轨道在明暗主题均不可见（独立审查必改项）
        'data-unchecked:bg-input data-checked:bg-primary data-checked:shadow-in',
        'focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'dark:data-checked:bg-primary dark:data-checked:hover:bg-primary/90',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background shadow-mcs-thumb ring-0 transition-transform',
          'data-checked:translate-x-4 data-unchecked:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
