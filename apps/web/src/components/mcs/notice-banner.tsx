/**
 * NoticeBanner —— 提示条的唯一容器（快照/截断/降级/告警/在途等非阻断提示）
 * 容器面固定中性（容器描边 + 卡片底色），语义色只落在左缘 2px 导轨与图标上：
 * 满宽四档 tint 会把整条横幅变成一块色斑，同屏多条时反而降低告警辨识。
 * neutral 更彻底：连导轨也不给，用于「在途」这类既非成功也非失败的状态。
 * 级别：状态持续存在 ⇒ 常驻；一次性结果 ⇒ toast。
 *
 * 两形态由 `form` 选（条＝行内流 / 卡＝块级内容）。块级内容不得各自手写
 * border + tint + p-3（`rounded-mcs-md`/`sm` 与内外间距各写一份）——
 * 内距 / 图标对齐 / 字号三个维度会全漂移。
 * 图标垂直对齐由形态决定：条是行内流、居中即可；卡会折行、必须贴首行。
 */
import type { LucideIcon } from 'lucide-react'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { SemanticTone } from '@/components/mcs/tone'

type NoticeTone = Extract<SemanticTone, 'info' | 'warning' | 'error' | 'success'>

/**
 * `neutral` 与四档语义色并列：它不是第五种语义，而是「无语义」态。
 * 在途状态（正在部署/正在启动）用它——染成 info 蓝会读成「有消息要看」，
 * 而它要表达的只是「还没结束，请稍候」。
 */
type NoticeVariant = NoticeTone | 'neutral'

/** 导轨与图标共用同档语义色：语义只在两处着色，容器面保持中性 */
const TONE_RAILS: Record<NoticeTone, string> = {
  info: 'border-l-mcs-info-fg',
  warning: 'border-l-mcs-warning-fg',
  error: 'border-l-mcs-error-fg',
  success: 'border-l-mcs-success-fg',
}

const TONE_ICONS: Record<NoticeVariant, string> = {
  info: 'text-mcs-info-fg',
  warning: 'text-mcs-warning-fg',
  error: 'text-mcs-error-fg',
  success: 'text-mcs-success-fg',
  neutral: 'text-mcs-text-muted',
}

/** 无语义档不配图标；语义档即使调用点不传 icon 也必须留下非颜色载体 */
const DEFAULT_ICONS: Record<NoticeVariant, LucideIcon | null> = {
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
  success: CircleCheck,
  neutral: null,
}

const ROOT_CLASSES = 'border border-mcs-border-container bg-mcs-bg-muted text-mcs-text-default'

/**
 * 形态档：按**内容是不是块级**选（行内流 / 块级），不按「重不重要」也不按「文本多长」——
 * 长度给不出稳定边界（同一条文案换个容器宽度就从一行变三行）。两档都能承载 error。
 */
type NoticeForm = 'bar' | 'card'

const FORM_CLASSES: Record<NoticeForm, string> = {
  bar: 'items-center gap-1.5 rounded-mcs-sm px-2.5 py-1.5 text-mcs-xs',
  // 卡承载成段正文，取正文字号档与匀等内距；条是元数据级短语，留在 xs
  card: 'items-start gap-2 rounded-mcs-sm p-3 text-mcs-sm',
}

const ICON_CLASSES: Record<NoticeForm, string> = {
  bar: 'size-3.5 shrink-0',
  /* 卡会折行，图标须贴首行——items-center 会让它悬在多行文本的垂直中点，读起来像
     上一段内容的残留。mt-0.5 是 14px 正文行高（1.6）下的光学对齐修正。 */
  card: 'mt-0.5 size-4 shrink-0',
}

interface NoticeBannerProps {
  variant: NoticeVariant
  icon?: LucideIcon
  /** 图标追加类（如在途态加 `animate-spin`）：基座按形态给尺寸，状态性修饰由调用点声明 */
  iconClassName?: string
  children: ReactNode
  className?: string
  /** 形态档：默认 bar（行内流）；children 含块级元素（多段落 / dl / 标题+正文）时用 card */
  form?: NoticeForm
  /** 播报角色：错误/失败用 alert（打断式），普通提示用 status（默认） */
  role?: 'status' | 'alert'
}

export function NoticeBanner({
  variant,
  icon,
  iconClassName,
  children,
  className,
  form = 'bar',
  role = 'status',
}: NoticeBannerProps) {
  const Icon = icon ?? DEFAULT_ICONS[variant]
  return (
    <div
      role={role}
      className={cn(
        'flex',
        FORM_CLASSES[form],
        ROOT_CLASSES,
        // 侧边导轨必须排在 `border` 全边之后：twMerge 视后写者胜，反过来会把 2px 左轨吞掉
        variant !== 'neutral' && 'border-l-2',
        variant !== 'neutral' && TONE_RAILS[variant],
        className,
      )}
    >
      {Icon && (
        <Icon className={cn(ICON_CLASSES[form], TONE_ICONS[variant], iconClassName)} aria-hidden />
      )}
      {/* min-w-0：文案成块折行，不与右侧动作抢行（否则动作挤进文本流产生孤字换行）。
          用 div 而非 span：card 形态的 children 是块级内容（标题 + 正文段），
          塞进 span 会形成 span>div 的无效嵌套；根节点本就是 flex 容器（div），
          故此处换成 div 不改变任何既有布局。 */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * 横幅内动作按钮的唯一配方（重试 / 重连 / 查看进度）。
 * 横幅坐在中性容器面上：透明底按钮会与面融成一片，故面换成实底页面面、悬停留中性。
 *
 * 走中性描边档：横幅里的动作是「重试 / 去某页看」，不改变数据、不是危险操作。
 * 用危险色统一会让「查看进度」与「重连」同屏同级，用户分不出哪个是恢复动作；
 * 破坏性动作不放横幅里——那需要二次确认，归 ui/dialog。
 *
 * 文字色必须显式给：按钮基座不声明文字色，会继承横幅根节点；显式中性让按钮配方
 * 不随横幅语义色变化——按钮动作不是横幅语义的一部分。
 *
 * 面与边界都要带 `!`：outline 基座自带暗色档面 `bg-input/30` 与悬停边界
 * `hover:border-foreground/25`，两者选择器权重更高、产物里又排在后面。
 * 面不加 `!` 时暗色档仍是半透明覆盖层（与 banner 的 tint 融成一片）；
 * 边界不加 `!` 时悬停只剩 25% 前景线，对 error tint 实测 2.15:1（亮色 1.63:1），
 * 跌破交互边界 3:1——鼠标一放上去按钮就溶解在横幅里。
 */
export function NoticeBannerAction({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      className="shrink-0 border-mcs-border-default! bg-mcs-bg-default! text-mcs-text-default hover:border-mcs-border-default! hover:bg-mcs-state-hover!"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}
