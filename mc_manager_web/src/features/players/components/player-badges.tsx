/**
 * PlayerBadges —— 玩家名后的状态徽标组（OP / AFK / 白名单 / 封禁）
 * 表格玩家列与窄屏卡片共用一份标记（自 player-table-columns 原样搬移，零样式变更）：
 * 徽标样式为既有的行内小标签写法，与表格单元格保持同一视觉语言
 *
 * part 按「宽窄」拆两组，供承载面分开摆放（表格玩家列的窄列需要，卡片等宽裕面用默认 all）：
 * - `icons`（OP，14px）：从不挤压姓名，留在姓名同行
 * - `texts`（AFK/白名单/封禁，26–103px）：会在窄列里与 IP 争宽，独占姓名之下的次要行
 */
import { ShieldCheck } from 'lucide-react'
import { formatBanRemaining } from '@/lib/mc-ban'
import type { Player } from '@/api/types'

export function PlayerBadges({
  player: p,
  part = 'all',
}: {
  player: Player
  /** 只输出哪一组（默认两组都输出） */
  part?: 'all' | 'icons' | 'texts'
}) {
  const banned = p.isBanned || p.isIpBanned
  const withIcons = part !== 'texts'
  const withTexts = part !== 'icons'
  // 渲染期取当前时间为可接受权衡：剩余时间随列表数据刷新更新，非实时倒计时
  // eslint-disable-next-line react/purity
  const nowMs = Date.now()
  return (
    <>
      {withIcons && p.isOp && (
        <ShieldCheck className="size-3.5 shrink-0 text-mcs-purple-fg" aria-label="OP" />
      )}
      {withTexts && p.isAfk && (
        <span className="shrink-0 rounded-mcs-xs bg-mcs-bg-secondary px-1 text-mcs-2xs text-mcs-text-muted">
          AFK
        </span>
      )}
      {withTexts && p.isWhitelisted && (
        <span className="shrink-0 rounded-mcs-xs bg-mcs-info-bg-subtle px-1 text-mcs-2xs text-mcs-info-fg">
          白名单
        </span>
      )}
      {withTexts && banned && (
        <span className="shrink-0 rounded-mcs-xs bg-mcs-error-bg-subtle px-1 text-mcs-2xs text-mcs-error-fg">
          {p.isBanned && p.banExpiresAt
            ? `封禁·${formatBanRemaining(p.banExpiresAt, nowMs) ?? '即将解封'}`
            : '封禁'}
        </span>
      )}
    </>
  )
}
