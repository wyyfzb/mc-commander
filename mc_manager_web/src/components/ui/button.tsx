import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/utils'
import { TONE_SELECTED_CLASSES } from '@/components/mcs/tone'

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition select-none focus-visible:outline-2 focus-visible:outline-mcs-focus-ring focus-visible:outline-offset-2 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:outline-2 aria-invalid:outline-destructive/40 aria-invalid:outline-offset-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // CTA：翠绿同色相渐变 + 亮边高光 + 微辉光，hover 辉光增强（品牌克制：辉光仅 CTA）
        default:
          'mcs-bg-accent-gradient text-mcs-on-accent shadow-mcs-accent-button hover:shadow-mcs-glow-accent-strong',
        outline:
          // 亮色主题用交互边框（--mcs-border-default）：--border 为 8% 发丝线，可交互元素边界不达标（独立审查必改项）
          'border-input bg-background hover:bg-muted hover:border-foreground/25 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        // 选中态（筛选开关/分段控件）：淡底 + 强档描边 + accent 文字，与 Chip 选中态同口径。
        // 实底渐变+辉光只给每页唯一主操作，开关借 CTA 会让一屏出现多个发光实底绿
        selected: `${TONE_SELECTED_CLASSES} hover:bg-mcs-state-hover active:bg-mcs-state-pressed`,
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
        destructive:
          'border-mcs-error-border-strong bg-mcs-error-bg-subtle text-mcs-error-fg hover:shadow-mcs-glow-error focus-visible:outline-mcs-error-fg',
        // 危险浅档＝outline 档换危险语义：面与中性次操作同源（--mcs-bg-secondary 就是
        // 「比卡片亮一档/压灰一档」的 chip 面），故同为次操作时两者只差语义色。
        // 描边与文字取危险色、危险底只在悬停时出现——与实底 destructive 拉开权重，
        // 避免把低频次操作升格成实底红、在同一屏跟主操作抢视觉唯一性。
        // 边界取强档：弱档 --mcs-error-border 是 25% 装饰线，不满足控件边界 ≥3:1（同 accent 弱档口径）。
        // 面档用 token 而非 dark: 覆写：dark: 前缀类在 ui/ 外被门禁拦（token 自带明暗），
        // 且产物里 dark:* 排在 hover:* 之后，一旦引入 dark: 面档就会吃掉悬停的危险底。
        'destructive-outline':
          'border-mcs-error-border-strong bg-mcs-bg-secondary text-mcs-error-fg hover:bg-mcs-error-bg-subtle focus-visible:outline-mcs-error-fg',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default:
          'h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-mcs-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-11 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        icon: 'size-10',
        'icon-xs':
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        'icon-sm':
          'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
