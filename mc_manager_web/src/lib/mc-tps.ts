/**
 * TPS 阈值与分级的**唯一声明源**。
 *
 * 展示（仪表盘统计卡的文字色）与告警（`notifications.ts` 的 TPS 过低通知）必须同源：
 * 此前一处写「≥19 健康 / ≥15 卡顿」、另一处写「tpsLow: 15」并再带一个 `?? 15` 兜底，
 * 同一个 15 出现在三处——改一处就会让「卡片显示健康、却同时弹低 TPS 告警」这种
 * 自相矛盾的状态出现。
 */

/** 健康下界：≥ 此值为健康 */
export const TPS_HEALTHY_MIN = 19

/** 告警下界：< 此值即「严重卡顿」，也是默认告警阈值 */
export const TPS_WARNING_MIN = 15

export type TpsLevel = 'healthy' | 'warning' | 'critical'

/**
 * TPS 分级。展示与告警都从这里取判据，不再各自比大小。
 * @param tps 每秒刻数；服务端未采集到时为 null
 */
export function tpsLevel(tps: number): TpsLevel {
  if (tps >= TPS_HEALTHY_MIN) return 'healthy'
  if (tps >= TPS_WARNING_MIN) return 'warning'
  return 'critical'
}
