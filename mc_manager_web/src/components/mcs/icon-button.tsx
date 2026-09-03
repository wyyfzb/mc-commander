import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * IconButton —— 纯图标按钮抽象（Tasteful Friction 系列）
 * - 无可见文本按钮必须有无障碍名：aria-label 编译期强制必填（TS 报错兜底）
 * - tooltip 提供时包 Tooltip 展示悬停提示；缺省 title 透传保留原生提示能力
 * - 消化散落各页的「Button size=icon* + aria-label (+ Tooltip)」三件套重复
 */
export interface IconButtonProps extends Omit<ComponentProps<typeof Button>, "size"> {
  /** icon 系列尺寸（默认 icon-sm，与现有高频用法一致） */
  size?: 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'
  /** 悬停提示内容（缺省走原生 title） */
  tooltip?: ReactNode
  /** tooltip 弹出方位（透传 TooltipContent side） */
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
  /** 无障碍名必填（icon 按钮无可见文本） */
  'aria-label': string
  children: ReactNode
}

export function IconButton({
  size = 'icon-sm',
  variant = 'ghost',
  tooltip,
  tooltipSide,
  className,
  children,
  ...props
}: IconButtonProps) {
  const button = (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      {...props}
    >
      {children}
    </Button>
  )

  if (tooltip != null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
      </Tooltip>
    )
  }
  return button
}
