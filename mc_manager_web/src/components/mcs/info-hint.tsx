/**
 * InfoHint —— 说明性文字的唯一浮层载体（信息图标 + Popover 正文）
 *
 * 说明句常驻在页头描述行时，窄屏会把标题列压到只剩一个字宽（实测 433px 下标题列 40px，
 * 「插件管理」逐字竖排四行），整句换行还会把首屏高度吃掉一大截。
 * 正文移进浮层后可见行只留标题与关键计数，信息不减少——打开即全文进入可访问性树。
 *
 * 用 Popover 而不是 Tooltip：Tooltip 对触屏指针不响应（点按只聚焦、随后的 click 又被当作关闭），
 * 说明会只剩鼠标与键盘可达；Popover 点按与 Enter/Space 均能打开、Escape 或点外部关闭。
 * 图标尺寸须小于所在文字行的行高（12px × 1.5 = 18px），否则会把页头撑高。
 */
import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface InfoHintProps {
  /** 说明主题：同时作为入口按钮与浮层的可访问名称（读屏与测试都取这里） */
  label: string
  /** 浮层正文 */
  children: ReactNode
}

export function InfoHint({ label, children }: InfoHintProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-mcs-xs align-middle text-mcs-text-muted transition-colors hover:text-mcs-text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mcs-focus-ring"
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={label}
        side="bottom"
        className="w-72 max-w-[calc(100vw-2rem)] p-3 text-mcs-xs text-mcs-text-default"
        // 纯文本提示：不把焦点搬进浮层，键盘用户的落点留在入口上（Escape 仍可关闭）
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
