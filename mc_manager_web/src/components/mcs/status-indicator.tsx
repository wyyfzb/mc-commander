import { CircleOff, CloudOff, Cloud } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * StatusIndicator —— 状态三重编码（设计文档 P1 / 审查清单维度 1）
 * 颜色 + 图标 + 文字三通道同义，色盲用户仅靠图标/文字可区分
 * 唯一呼吸动画只给故障/降级状态（设计文档 §4.7）
 */

export type IndicatorStatus = 'connected' | 'connecting' | 'disconnected' | 'warning' | 'degraded'

const STATUS_CONFIG: Record<
  IndicatorStatus,
  { dot: string; icon: typeof CircleOff; label: string; pulse?: boolean }
> = {
  connected: {
    dot: 'bg-mcs-success-fg',
    icon: Cloud,
    label: '已连接',
  },
  connecting: {
    dot: 'bg-mcs-info-fg',
    icon: Cloud,
    label: '连接中',
    pulse: true,
  },
  disconnected: {
    dot: 'bg-mcs-text-subtle',
    icon: CloudOff,
    label: '未连接',
  },
  warning: {
    dot: 'bg-mcs-warning-fg',
    icon: CircleOff,
    label: '异常',
    pulse: true,
  },
  /** 实时通道断开，轮询保底中（HTTP 数据仍可用） */
  degraded: {
    dot: 'bg-mcs-warning-fg',
    icon: Cloud,
    label: '延迟刷新',
  },
}

interface StatusIndicatorProps {
  status: IndicatorStatus
  className?: string
}

export function StatusIndicator({ status, className }: StatusIndicatorProps) {
  const config = STATUS_CONFIG[status]
  const Icon = config.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-mcs-xs font-medium text-mcs-text-muted',
        className,
      )}
      data-status={status}
    >
      <span className="relative flex size-2 items-center justify-center" aria-hidden>
        {config.pulse && (
          <span
            className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-40', config.dot)}
          />
        )}
        <span className={cn('relative inline-flex size-2 rounded-full', config.dot)} />
      </span>
      <Icon className="size-3.5" aria-hidden />
      {config.label}
    </span>
  )
}
