/**
 * NoticeBanner —— 提示条的唯一容器（快照/截断/降级/告警/在途等非阻断提示）
 * 变体走 --mcs-* token：四档语义色是不透明 tint 容器底 + 同档文字；neutral 是无语义档
 * （边框/底/文字全取中性面），用于「在途」这类既非成功也非失败的状态。
 * 级别选用（何时该常驻、何时用 toast）见 docs/design-review-guidelines.md §反馈级别三级口径
 *
 * 两形态由 `form` 选（条＝行内流 / 卡＝块级内容）。此前基座只支持条，块级内容只能
 * 各自手写 border + tint + p-3（`rounded-mcs-md`/`sm` 与内外间距各写一份），
 * 内距 / 图标对齐 / 字号三个维度全漂移。
 * 图标垂直对齐由形态决定：条是行内流、居中即可；卡会折行、必须贴首行。
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toneClasses, type SemanticTone } from '@/components/mcs/tone'

type NoticeTone = Extract<SemanticTone, 'info' | 'warning' | 'error' | 'success'>

/**
 * `neutral` 与四档语义色并列：它不是第五种语义，而是「无语义」态。
 * 在途状态（正在部署/正在启动）用它——染成 info 蓝会读成「有消息要看」，
 * 而它要表达的只是「还没结束，请稍候」。
 */
type NoticeVariant = NoticeTone | 'neutral'

const VARIANT_CLASSES: Record<NoticeVariant, string> = {
  info: toneClasses('info'),
  warning: toneClasses('warning'),
  error: toneClasses('error'),
  success: toneClasses('success'),
  neutral: 'border-mcs-border-muted bg-mcs-bg-muted text-mcs-text-muted',
}

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
  icon: Icon,
  iconClassName,
  children,
  className,
  form = 'bar',
  role = 'status',
}: NoticeBannerProps) {
  return (
    <div
      role={role}
      className={cn('flex border', FORM_CLASSES[form], VARIANT_CLASSES[variant], className)}
    >
      {Icon && <Icon className={cn(ICON_CLASSES[form], iconClassName)} aria-hidden />}
      {/* min-w-0：文案成块折行，不与右侧动作抢行（否则动作挤进文本流产生孤字换行）。
          用 div 而非 span：card 形态的 children 是块级内容（标题 + 正文段），
          塞进 span 会形成 span>div 的无效嵌套；根节点本就是 flex 容器（div），
          故此处换成 div 不改变任何既有布局。 */}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * 横幅内动作按钮的唯一配方（重试 / 重连等）。
 * 横幅坐在 tint 面上：透明底按钮会与面融成一片，故面换成实底页面面、悬停留在
 * 中性档（同色悬停会让按钮在横幅上失去轮廓）。各处横幅的动作必须走这里——
 * 此前 WS 横幅用描边档、查询失败横幅用 ghost 档，同屏两个动作两种长相。
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
      variant="destructive-outline"
      size="xs"
      className="shrink-0 bg-mcs-bg-default hover:bg-mcs-state-hover"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}
