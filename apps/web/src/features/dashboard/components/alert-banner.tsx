/**
 * AlertBanner —— 常驻告警条（TPS / CPU 超标中）
 *
 * 与通知中心的区别：通知是**事件**（「TPS 过低」发生了一次），本条是**状态**
 * （此刻仍在超标）。告警状态机（lib/notifications.ts 的 buildAlertNotifications）
 * 算出的 activeAlerts 必须由常驻载体消费——只发一次性通知的话，用户离开通知中心
 * 就看不出服务器正在异常。
 *
 * 级别取常驻：状态在超标期间**持续存在**，
 * 需用户反复可见，故不能用 toast（几秒即散）。
 */
import { AlertTriangle } from 'lucide-react'
import { NoticeBanner, NoticeBannerAction } from '@/components/mcs/notice-banner'
import { useUiStore } from '@/stores/ui'
import { useServerStore } from '@/stores/server'
import type { AlertType } from '@/lib/notifications'

/**
 * 告警类型 → 展示文案。用 Record 而非数组：新增 AlertType 时编译器会强制在这里补一条，
 * 否则新告警会静默地没有常驻载体（只剩一次性 toast）。
 * 顺序即展示顺序（TPS 直接决定玩家手感，排最前）。
 */
const ALERT_LABELS: Record<AlertType, string> = {
  lowTps: 'TPS 过低',
  highCpu: 'CPU 使用率过高',
  /* highMemory 的口径是**整机**内存使用率（`systemStatsUpdate.memoryPercent`，
     读数与阈值同源来自服务端 config.memoryAlert）——不是 MC 进程内存，也不是 JVM 堆。
     「进程 RSS ÷ 整机 RAM」那种分子分母不同源的比值才是失真比例，本告警不用它。 */
  highMemory: '内存使用率过高',
  highDisk: '磁盘空间不足',
  criticalDisk: '磁盘空间严重不足',
}

/** 展示顺序固定为上面 Record 的键序 */
const ALERT_ORDER = Object.keys(ALERT_LABELS) as AlertType[]

/**
 * 哪些告警值得给「查是否性能导致」的入口。
 *
 * 磁盘两类**刻意不给**：磁盘占用与 TPS/CPU/内存是两回事，性能快照里没有任何磁盘指标，
 * 点进去只会得到「没发现瓶颈」，把一次明确处置（清备份 / 扩盘）引到错误的排查方向。
 */
const PERF_RELEVANT: ReadonlySet<AlertType> = new Set<AlertType>([
  'lowTps',
  'highCpu',
  'highMemory',
])

export function AlertBanner({ alerts }: { alerts: ReadonlySet<AlertType> }) {
  const setPerfSheetInstanceId = useUiStore((s) => s.setPerfSheetInstanceId)
  // 告警由当前实例的性能读数驱动，故诊断目标就是当前实例；不用 lastOutputInstanceId
  // （那是末尾日志弹窗自己的开关，两者同时打开时会被一起改掉）
  const instanceId = useServerStore((s) => s.instanceId)

  const active = ALERT_ORDER.filter((t) => alerts.has(t))
  if (active.length === 0) return null

  const perfRelevant = active.some((t) => PERF_RELEVANT.has(t))

  /* 文案到「服务器正在异常」为止，不复述阈值与读数：读数在统计卡上是活的（30s 轮询 +
     WS 推送），横幅里抄一份就会与卡上不一致（横幅只在跃迁时更新）。 */
  return (
    <NoticeBanner variant="warning" icon={AlertTriangle}>
      {/* 按钮靠右且不参与文本流：窄容器下文案折行时按钮独占一行，而不是挤在最后一个词
          右侧、把整句压成两三个字一行 */}
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="min-w-0">
          {`服务器状态异常：${active.map((t) => ALERT_LABELS[t]).join('、')}（指标恢复正常后本条自动消失）`}
        </span>
        {perfRelevant && (
          <NoticeBannerAction onClick={() => setPerfSheetInstanceId(instanceId)}>
            查是否性能导致
          </NoticeBannerAction>
        )}
      </span>
    </NoticeBanner>
  )
}
