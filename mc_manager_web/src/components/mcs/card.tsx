import type { CSSProperties, ElementType, ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

/**
 * Card —— 卡片容器基座（卡片容器的类名声明处，配 AGENTS.md「卡片容器」与「间距」的容器档位）
 * 只承载「卡片面」本身（圆角 + 描边 + 卡片底色 + 卡阴影）；padding 与内部布局
 * 一律留给调用点 className——各卡的内容档位不同（p-6/p-4/p-3/px-4 py-3/无内边距外壳），
 * 基座代劳就会逼调用点放弃自己的 flex/padding 布局。
 *
 * 默认 `<section>`：本仓既有卡片容器绝大多数是 section（卡片是主题分组，不该降级为无语义块）；
 * 元素语义不同时用 `as` 声明（div/main/button），基座不替调用点改标签。
 *
 * 圆角固定 `rounded-mcs-md`：twMerge 未登记 `rounded-mcs-*` 词汇表（同 font-size 曾有过的缺陷），
 * 调用点传其它圆角档会两个类并存、胜负交给样式表顺序——需要非 md 圆角的卡片面先补词汇表。
 */

const CARD_SURFACE = 'rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted shadow-mcs-card'

type CardElement = 'section' | 'div' | 'main' | 'button'

interface CardProps {
  as?: CardElement
  className?: string
  children?: ReactNode
  /** 透传 role、aria 属性、tabIndex 等：交互型卡片（单选组成员）的语义由调用点持有 */
  role?: string
  'aria-label'?: string
  'aria-checked'?: boolean
  'aria-live'?: 'off' | 'assertive' | 'polite'
  'aria-busy'?: boolean
  tabIndex?: number
  type?: 'button' | 'submit' | 'reset'
  style?: CSSProperties
  title?: string
  onClick?: () => void
  ref?: Ref<HTMLElement>
  /** 任意 data-* 钩子（测试与 e2e 定位依赖，基座不得吞掉） */
  [key: `data-${string}`]: unknown
}

export function Card({ as = 'section', className, children, ...rest }: CardProps) {
  const Tag = as as ElementType
  return (
    <Tag className={cn(CARD_SURFACE, className)} {...rest}>
      {children}
    </Tag>
  )
}

/**
 * 卡片标题行（标题 + 右侧角标/操作）。
 * 只固定「横向 + 垂直居中」：对齐方式（justify-between / ml-auto）、间距、分隔线与
 * 内边距按各卡内容走，钉死 justify-between 会把「图标 + 标题 + ml-auto 操作」推散。
 */
export function CardHeader({ className, children }: { className?: string; children?: ReactNode }) {
  return <header className={cn('flex items-center', className)}>{children}</header>
}

/**
 * 卡片标题文字（默认 h3 = 页头 h2 之下的卡片标题档）。
 * 层级由调用点按所在页面给：钉死单一层级会让卡片标题与页头抢级或与子面板并列。
 */
export function CardTitle({
  as: Tag = 'h3',
  className,
  children,
}: {
  as?: 'h2' | 'h3' | 'h4'
  className?: string
  children?: ReactNode
}) {
  return (
    <Tag className={cn('text-mcs-sm font-medium text-mcs-text-muted', className)}>{children}</Tag>
  )
}

/**
 * 卡片内容体槽位（标题行之外的内容）。
 * 刻意零默认类：内容档位各卡不同（`px-4 py-2` / `flex flex-col px-4` / `p-3`），
 * 基座代办即改掉调用点布局；它的价值是给「哪一块是卡片内容体」一个稳定锚点。
 */
export function CardBody({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn(className)}>{children}</div>
}
