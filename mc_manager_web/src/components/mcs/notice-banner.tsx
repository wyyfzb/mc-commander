/**
 * NoticeBanner —— 通用提示条（快照/截断/降级等非阻断提示）
 * 变体四色走 --mcs-* 状态 token（12% alpha 容器底 + 状态色文字），三重编码由调用方图标承担
 * 级别选用（何时该常驻、何时用 toast）见 docs/design-review-guidelines.md §反馈级别三级口径
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toneClasses, type SemanticTone } from '@/components/mcs/tone'

type NoticeVariant = Extract<SemanticTone, 'info' | 'warning' | 'error' | 'success'>

const VARIANT_CLASSES: Record<NoticeVariant, string> = {
  info: toneClasses('info'),
  warning: toneClasses('warning'),
  error: toneClasses('error'),
  success: toneClasses('success'),
}

interface NoticeBannerProps {
  variant: NoticeVariant
  icon?: LucideIcon
  children: ReactNode
  className?: string
  /** 播报角色：错误/失败用 alert（打断式），普通提示用 status（默认） */
  role?: 'status' | 'alert'
}

export function NoticeBanner({
  variant,
  icon: Icon,
  children,
  className,
  role = 'status',
}: NoticeBannerProps) {
  return (
    <div
      role={role}
      className={cn(
        // 图标垂直居中而非贴首行：横幅文案可能折行，贴首行会让图标悬在
        // 多行文本的左上角，读起来像两段内容的残留
        'flex items-center gap-1.5 rounded-mcs-sm border px-2.5 py-1.5 text-mcs-xs',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
      {/* min-w-0：文案成块折行，不与右侧动作抢行（否则动作挤进文本流产生孤字换行） */}
      <span className="min-w-0 flex-1">{children}</span>
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
