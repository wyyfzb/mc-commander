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
    dot: 'bg-mcs-text-muted',
    icon: CloudOff,
    label: '未连接',
  },
  warning: {
    dot: 'bg-mcs-warning-fg',
    icon: CircleOff,
    label: '异常',
    pulse: true,
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
  /** 追加在状态文字之后的短标签（如「实时更新」「每 30 秒刷新」）；只放短语 */
  suffix?: string
  /** 与 suffix 配套的完整解释：句子只进 title/aria-label，不占可见文本的字号档位 */
  suffixDescription?: string
  className?: string
}

export function StatusIndicator({
  status,
  suffix,
  suffixDescription,
  className,
}: StatusIndicatorProps) {
  const config = STATUS_CONFIG[status]
  const Icon = config.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-mcs-xs font-medium text-mcs-text-muted',
        className,
      )}
      data-status={status}
      // 完整解释走两处：title 供指针悬停，sr-only 供读屏——可见文本只放短语（12px 下中文
      // 句子屏显太挤）。不用 aria-label：span 是 role=generic，按规范禁止命名，
      // 实测 Chromium 无障碍树里只取到可见文本，那句解释等于对读屏用户不存在
      title={suffix ? suffixDescription : undefined}
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
      {suffix && ` · ${suffix}`}
      {suffix && suffixDescription && <span className="sr-only">，{suffixDescription}</span>}
    </span>
  )
}
