/**
 * InfoHint —— 说明性文字的唯一浮层载体（信息图标 + Popover 正文）
 *
 * 说明句常驻在页头描述行时，窄屏会把标题列压到只剩一个字宽（实测 433px 下标题列 40px，
 * 「插件管理」逐字竖排四行），整句换行还会把首屏高度吃掉一大截。
 * 正文移进浮层后可见行只留标题与关键计数，信息不减少——打开即全文进入可访问性树。
 *
 * 用 Popover 而不是 Tooltip：Tooltip 对触屏指针不响应（点按只聚焦、随后的 click 又被当作关闭），
 * 说明会只剩鼠标与键盘可达；Popover 点按与 Enter/Space 均能打开、Escape 或点外部关闭。
 * 这条理由同样约束 inline 档——行内术语的解释也不许退回 Tooltip。
 * 图标尺寸须小于所在文字行的行高（12px × 1.5 = 18px），否则会把页头撑高。
 */
import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface InfoHintProps {
  /**
   * icon 档：入口按钮与浮层的可访问名称（读屏与测试都取这里）。
   * inline 档：**被解释的词本身**（它就是可见文本，也是触发器）。
   */
  label: string
  /** 浮层正文 */
  children: ReactNode
  /**
   * inline 档的**可见触发内容**；缺省用 `label` 文本。被解释的东西不是纯文本时
   * （如一枚状态徽标）走这里，而按钮与浮层的可访问名仍取 `label`。
   */
  term?: ReactNode
  /**
   * `icon`（默认）= 信息图标按钮，挂在标题/标签之后。
   * `inline` = 把被解释的词做成触发器（虚线下划线 + 可聚焦），用于表格单元格、
   * 行内术语——那里塞不进一个图标，且词本身就是落点；此前这类现场直接写
   * `Tooltip` + 不可聚焦的 `<span>`，键盘与触屏就拿不到解释了（本组件注释里
   * 已写明 Tooltip 对触屏指针不响应，那条理由同样适用于它们）。
   */
  variant?: 'icon' | 'inline'
}

/** 虚线下划线：「这里可以取解释」的可见记号（口径见 docs/design-review-guidelines.md） */
const INLINE_TRIGGER =
  'rounded-mcs-xs underline decoration-dashed underline-offset-2 transition-colors ' +
  'hover:text-mcs-text-default focus-visible:outline-2 focus-visible:-outline-offset-2 ' +
  'focus-visible:outline-mcs-focus-ring'

export function InfoHint({ label, term, children, variant = 'icon' }: InfoHintProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        {variant === 'inline' ? (
          <button
            type="button"
            aria-label={label}
            className={cn('cursor-help text-inherit', INLINE_TRIGGER)}
          >
            {term ?? label}
          </button>
        ) : (
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-mcs-xs align-middle text-mcs-text-muted transition-colors hover:text-mcs-text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mcs-focus-ring"
          >
            <Info className="size-3.5" aria-hidden />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        aria-label={label}
        // inline 档挂在被解释词的上方（词在正文流里，向下会压住下一行）；icon 档向下
        side={variant === 'inline' ? 'top' : 'bottom'}
        className="w-72 max-w-[calc(100vw-2rem)] p-3 text-mcs-xs text-mcs-text-default"
        // 纯文本提示：不把焦点搬进浮层，键盘用户的落点留在入口上（Escape 仍可关闭）
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
