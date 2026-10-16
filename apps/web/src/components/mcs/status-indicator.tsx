import { CircleOff, CloudOff, Cloud } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * StatusIndicator —— 状态三重编码
 * 颜色 + 图标 + 文字三通道同义，色盲用户仅靠图标/文字可区分
 * 唯一呼吸动画只给「连接中」这一个在途档
 *
 * 档位只在有真实生产者时才加：这里曾有一个 `warning`（「异常」）档，唯一生产者是顶栏把
 * 实例 TPS 偏低染上去——那属于把实例事实混进面板连接档位，已撤销（载体改为实例卡片的
 * TPS 指标）。当前五档里没有「面板侧异常」这一说法，需要时按那时的真实语义新增。
 */

export type IndicatorStatus = 'connected' | 'connecting' | 'disconnected' | 'degraded'

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
    dot: 'bg-mcs-text-muted',
    icon: CloudOff,
    label: '未连接',
  },
  /** 实时通道断开：只陈述可确知的事实（推送断了）。
      不写「延迟刷新」——那暗示轮询确实在刷新，而面板整体不可达时轮询同样失败、
      内容区已是错误态；能否取到数据由页面错误态如实呈现，此处不承诺 */
  degraded: {
    dot: 'bg-mcs-warning-fg',
    icon: Cloud,
    label: '实时推送已断',
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
        {/* 涟漪直径与起始不透明度即可感知门槛：与圆点同尺寸的 8px / 40% 在顶栏上几乎
            看不出；12px 起点展开到 24px。
            不透明度走 token（--mcs-ripple-opacity，亮色档更高）：顶栏玻璃面在亮色下亮得多，
            同一档位合成后只有 2.63:1，达不到图形 3:1 → 亮色升到 0.75（info 3.48 / warning 3.92）。
            check-contrast 的「pulse 涟漪」断言守住这两个数。颜色仍走状态色 token，
            reduced-motion 由 index.css 全局归零兜底 */}
        {config.pulse && (
          <span
            className={cn(
              'absolute inline-flex size-3 animate-ping rounded-full opacity-(--mcs-ripple-opacity)',
              config.dot,
            )}
          />
        )}
        <span className={cn('relative inline-flex size-2 rounded-full', config.dot)} />
      </span>
      <Icon className="size-3.5" aria-hidden />
      {config.label}
    </span>
  )
}
