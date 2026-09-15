/**
 * PlayerBadges —— 玩家名后的状态徽标组（OP / AFK / 白名单 / 封禁）
 * 表格玩家列与窄屏卡片共用一份标记（自 player-table-columns 原样搬移，零样式变更）：
 * 徽标样式为既有的行内小标签写法，与表格单元格保持同一视觉语言
 */
import { ShieldCheck } from 'lucide-react'
import { formatBanRemaining } from '@/lib/mc-ban'
import type { Player } from '@/api/types'

export function PlayerBadges({ player: p }: { player: Player }) {
  const banned = p.isBanned || p.isIpBanned
  // 渲染期取当前时间为可接受权衡：剩余时间随列表数据刷新更新，非实时倒计时
  // eslint-disable-next-line react/purity
  const nowMs = Date.now()
  return (
    <>
      {p.isOp && <ShieldCheck className="size-3.5 shrink-0 text-mcs-purple-fg" aria-label="OP" />}
      {p.isAfk && (
        <span className="shrink-0 rounded-mcs-xs bg-mcs-bg-secondary px-1 text-mcs-2xs text-mcs-text-muted">
          AFK
        </span>
      )}
      {p.isWhitelisted && (
        <span className="shrink-0 rounded-mcs-xs bg-mcs-info-bg-subtle px-1 text-mcs-2xs text-mcs-info-fg">
          白名单
        </span>
      )}
      {banned && (
        <span className="shrink-0 rounded-mcs-xs bg-mcs-error-bg-subtle px-1 text-mcs-2xs text-mcs-error-fg">
          {p.isBanned && p.banExpiresAt
            ? `封禁·${formatBanRemaining(p.banExpiresAt, nowMs) ?? '即将解封'}`
            : '封禁'}
        </span>
      )}
    </>
  )
}
