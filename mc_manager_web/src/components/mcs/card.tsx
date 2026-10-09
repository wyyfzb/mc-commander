import type { CSSProperties, ElementType, ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

/**
 * Card —— 卡片容器基座（卡片容器的类名声明处，配 AGENTS.md「卡片容器」与「间距」的容器档位）
 * 只承载「卡片面」本身（圆角 + 描边 + 卡片底色 + 卡阴影）；内距与内部布局由调用点按容器档位给。
 *
 * **内距默认给（opt-out）**：不写 `size` 就是标准卡（`default`）。原因是「忘了给内距」这个
 * 缺陷形态在 opt-in 下**无门禁可拦**——正像素不违规、也不触发任何静态规则，而症状是文字贴着
 * 卡片描边，一眼看去像坏了（实测发生过）。反过来，真的不要内距的现场（卡片面里装的是自带内距的
 * 表格/列表/分栏）写 `size="flush"` 即可，那种现场的特征明显、审查时看得见。
 * `className` 里的 `p-*` 仍覆盖基座档（twMerge）。
 *
 * 默认 `<section>`：本仓既有卡片容器绝大多数是 section（卡片是主题分组，不该降级为无语义块）；
 * 元素语义不同时用 `as` 声明（div/main/button），基座不替调用点改标签。
 *
 * 圆角固定 `rounded-mcs-md`：twMerge 未登记 `rounded-mcs-*` 词汇表（同 font-size 曾有过的缺陷），
 * 调用点传其它圆角档会两个类并存、胜负交给样式表顺序——需要非 md 圆角的卡片面先补词汇表。
 */

const CARD_SURFACE = 'rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted shadow-mcs-card'

/**
 * 卡片内距档位表（唯一声明处）。只收**卡片自己的**档位——Card 承载的是卡片面，
 * 卡内的工具条 / 嵌块 / 代码块不是卡片面，它们的内距不归这里管（那三类的切档维度见
 * mc_manager_web/docs/design-review-guidelines.md「容器内距」一节）。
 *
 * 命名按角色不按像素：选档时问的是「这张卡多重」，不是「我要几 px」。
 * 间距无门禁（口径＝审查时判，见 AGENTS.md「间距」），本表是规范不是拦截。
 */
export const CARD_SIZE_CLASSES = {
  /** 大面板：AppShell 级区块 */
  panel: 'p-6',
  /** 标准卡（不写 `size` 即此档） */
  default: 'p-4',
  /** 紧凑卡 */
  compact: 'p-3',
  /** 面壳：卡片面里装的是自带内距的结构（表格/列表/分栏），内距由子元素自己给——不是「不要内距」 */
  flush: '',
} as const

export type CardSize = keyof typeof CARD_SIZE_CLASSES

type CardElement = 'section' | 'div' | 'main' | 'button'

interface CardProps {
  as?: CardElement
  className?: string
  children?: ReactNode
  /**
   * 内距档位：取值见 CARD_SIZE_CLASSES，**不传即标准卡**（默认给内距，见文件头）。
   * 真的不要内距的现场显式写 `flush`；className 里的 p-* 仍会覆盖它（twMerge）。
   */
  size?: CardSize
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

export function Card({
  as = 'section',
  size = 'default',
  className,
  children,
  ...rest
}: CardProps) {
  const Tag = as as ElementType
  return (
    <Tag className={cn(CARD_SURFACE, CARD_SIZE_CLASSES[size], className)} {...rest}>
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
 * 卡片标题的角色轴档位表（角色由「这段文字承担什么」决定，与卡片视觉样式无关）：
 * `heading` = 区块/内容标题，占标题档；`label` = 数据卡（KPI/指标卡）的标签行，只占标签档。
 * 单档基座会把真区块标题压到与标签行同级，同屏只剩页头与正文两档可辨（AGENTS.md 标题口径
 * 「区块与卡片标题 lg」）。命名取 variant 而非 role：role 在 JSX 里是 ARIA 属性名，同名会与
 * 透传语义混淆。门禁第 23 条从本表读档并按调用点 variant 分类，改表即改口径。
 */
const CARD_TITLE_TIER = {
  heading: 'text-mcs-lg',
  label: 'text-mcs-sm',
} as const

/**
 * 各角色的字重与文字色（字号档在 CARD_TITLE_TIER，两表合起来才是完整配方）。
 * 基座是配方的唯一声明处：仓内手写的 `h3 text-mcs-lg` 与基座 heading 必须三项同配方，
 * 否则「同一个 lg 档」会有两套观感，调用点迁入基座也不再是零视觉变化。
 * label 是数据卡标签行，必须弱于同卡的数值：字重与文字色都不得升到 heading 档。
 */
const CARD_TITLE_RECIPE = {
  heading: 'font-semibold text-mcs-text-default',
  label: 'font-medium text-mcs-text-muted',
} as const

/**
 * 卡片标题文字（默认 h3 = 页头 h2 之下的卡片标题档）。
 * 元素语义（as）与层级（className 覆盖基座档）仍由调用点持有：钉死单一层级会让卡片标题
 * 与页头抢级或与子面板并列。
 */
export function CardTitle({
  as: Tag = 'h3',
  variant = 'heading',
  className,
  children,
}: {
  as?: 'h2' | 'h3' | 'h4'
  /** heading = 区块/内容标题（默认）；label = 数据卡标签行 */
  variant?: keyof typeof CARD_TITLE_TIER
  className?: string
  children?: ReactNode
}) {
  return (
    <Tag className={cn(CARD_TITLE_TIER[variant], CARD_TITLE_RECIPE[variant], className)}>
      {children}
    </Tag>
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
