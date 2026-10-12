/**
 * 「数据刷新时机」这条实例事实的唯一声明源（判据 / 文案 / tone）。
 *
 * 载体各按自己的宽度选形态（侧栏短标签、卡片药丸），但同一事实只在这里声明——各写一份必然
 * 出现「卡片说轮询、侧栏说实时」这类自相矛盾。
 * 门控保守：实时通道断开或推送读数未知时两档都不给，此时轮询是否真在刷新无从判定。
 */
import { FALLBACK_POLL_INTERVAL_MS } from '@/api/queries'
import type { ChipTone } from '@/components/mcs/chip'

export interface InstanceRefreshMark {
  /** 短标签（两字）：侧栏实例迷你卡在状态行尾追加用——那里实测可用宽仅 149px */
  short: string
  /** 完整标签：实例卡片用。卡片上空间足够，明说「推送」以免被读成运行状态的一部分 */
  label: string
  /** 完整说明：只作不可见文本（title / sr-only），可见处一律只放标签 */
  description: string
  /** 轮询是文档化的回落档、不是故障 ⇒ 中性档；实时取 success */
  tone: ChipTone
}

export function instanceRefreshMark(
  socketConnected: boolean,
  pushConnected: boolean | undefined,
): InstanceRefreshMark | null {
  if (!socketConnected || pushConnected === undefined) return null
  if (pushConnected) {
    return {
      short: '实时',
      label: '实时推送',
      description: '实时推送已连通，服务器的状态变化会立即到达面板',
      tone: 'success',
    }
  }
  return {
    short: '轮询',
    label: '轮询刷新',
    description: `实时推送未连通，面板每 ${FALLBACK_POLL_INTERVAL_MS / 1000} 秒刷新一次状态`,
    tone: 'muted',
  }
}
