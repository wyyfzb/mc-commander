/**
 * 「数据刷新时机」这条**实例事实**的唯一声明源。
 *
 * 判据、文案与 tone 此前散在三处（顶栏状态点的不可见说明、顶栏窄屏药丸、侧栏实例迷你卡），
 * 再挂上实例卡片就是四处各写一份：同一事实四处声明，改一处必然出现「卡片说轮询、侧栏说实时」
 * 这类自相矛盾。载体可以各按自己的宽度选形态（短标签 / 药丸），但文案与门控只在这里声明。
 *
 * 门控刻意保守：面板到后端的实时通道断开、或推送读数未知时**两档都不给**——此时轮询是否真在
 * 刷新无从判定，宁可不说也不说错（降级横幅已据实写明间隔，两处都写会重复）。
 * 秒数取 `api/queries` 的常量：写死一处就会与真实间隔漂移。
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
