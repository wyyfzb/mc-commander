/**
 * AlertBanner —— 常驻告警条（TPS / CPU 超标中）
 *
 * 与通知中心的区别：通知是**事件**（「TPS 过低」发生了一次），本条是**状态**
 * （此刻仍在超标）。告警状态机（lib/notifications.ts 的 buildAlertNotifications）
 * 本来就是跨事件存续的，但此前只用来发一次性通知，算完的 activeAlerts 全仓无消费点
 * ——状态算出来了却没有载体，用户离开通知中心就看不出服务器正在异常。
 *
 * 级别取常驻（design-review-guidelines.md 的反馈级别三级）：状态在超标期间**持续存在**，
 * 需用户反复可见，故不能用 toast（几秒即散）。
 */
import { AlertTriangle } from 'lucide-react'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import type { AlertType } from '@/lib/notifications'

/** 告警类型 → 展示文案（顺序即展示顺序：TPS 直接决定玩家手感，排最前） */
const ALERT_LABELS: Array<{ type: AlertType; label: string }> = [
  { type: 'lowTps', label: 'TPS 过低' },
  { type: 'highCpu', label: 'CPU 使用率过高' },
  /* highMemory 保留：状态机与阈值都在（lib/notifications.ts），但输入链路暂无可靠分母
     （进程 RSS ÷ 整机 RAM 是失真比例，见 use-server-socket 的 payload 注释），
     故它当前不会置位；服务端补上真实堆指标后本条自动生效，无需再改这里。 */
  { type: 'highMemory', label: '内存使用率过高' },
]

export function AlertBanner({ alerts }: { alerts: ReadonlySet<AlertType> }) {
  const active = ALERT_LABELS.filter((a) => alerts.has(a.type))
  if (active.length === 0) return null

  /* 文案到「服务器正在异常」为止，不复述阈值与读数：读数在统计卡上是活的（30s 轮询 +
     WS 推送），横幅里抄一份就会与卡上不一致（横幅只在跃迁时更新）。 */
  return (
    <NoticeBanner variant="warning" icon={AlertTriangle}>
      {`服务器状态异常：${active.map((a) => a.label).join('、')}（指标恢复正常后本条自动消失）`}
    </NoticeBanner>
  )
}
