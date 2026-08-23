"use client"

/**
 * Slider —— shadcn/ui radix-nova 滑块基座（radix-ui Slider 封装，实例设置弹窗内存档位用）
 * 消费 Component 层映射 token（theme.css：primary=--mcs-accent / secondary=--mcs-bg-hover），组件内无硬编码
 */
import * as React from "react"
import { Slider as SliderPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Slider({
  className,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex w-full touch-none items-center select-none",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute h-full bg-primary"
        />
      </SliderPrimitive.Track>
      {/* radix 1.x：role=slider 与可访问名在 Thumb 上，Root 不接受 aria-label */}
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={ariaLabel}
        className="block size-4 shrink-0 rounded-full border border-primary/50 bg-background shadow-xs transition-[color,box-shadow] outline-none hover:bg-background focus-visible:ring-4 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
