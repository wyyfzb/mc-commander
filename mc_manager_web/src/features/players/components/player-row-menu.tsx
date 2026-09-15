/**
 * PlayerRowMenu —— 表格行与窄屏卡片共用的操作菜单
 * 共用单一事实源：两种承载形态（表格行 / 卡片）渲染同一菜单，避免两套菜单各自漂移
 * J71 口径：需在线的项（传送/给予物品/踢出）用 onSelect——radix 的 disabled 只拦 onSelect，
 * 用 onClick 时禁用只剩 data-disabled:pointer-events-none 的 CSS 兜底
 */
import { Ban, Eye, Gift, MoreHorizontal, Send, ShieldCheck, ShieldX, UserX } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import type { Player } from '@/api/types'
import type { PlayerDetailTab } from '../store'

interface PlayerRowMenuProps {
  player: Player
  onOpenDetail: (name: string, tab?: PlayerDetailTab) => void
  onOpenBan: (player: Player) => void
  /** 可逆：直执 + 5s 撤销 */
  toggleOp: (player: Player) => void
  /** 可逆：直执 + 5s 撤销 */
  toggleWhitelist: (player: Player) => void
  /** 无逆操作：直执 + 普通回执 */
  kick: (player: Player) => void
}

export function PlayerRowMenu({
  player: p,
  onOpenDetail,
  onOpenBan,
  toggleOp,
  toggleWhitelist,
  kick,
}: PlayerRowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`${p.name} 操作菜单`}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onOpenDetail(p.name, 'overview')}>
          <Eye aria-hidden />
          详情
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!p.isOnline} onSelect={() => onOpenDetail(p.name, 'teleport')}>
          <Send aria-hidden />
          传送
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!p.isOnline} onSelect={() => onOpenDetail(p.name, 'give')}>
          <Gift aria-hidden />
          给予物品
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => toggleOp(p)}>
          {p.isOp ? <ShieldX aria-hidden /> : <ShieldCheck aria-hidden />}
          {p.isOp ? '取消 OP' : '设为 OP'}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => toggleWhitelist(p)}>
          {p.isWhitelisted ? <ShieldX aria-hidden /> : <ShieldCheck aria-hidden />}
          {p.isWhitelisted ? '移除白名单' : '加入白名单'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!p.isOnline} onSelect={() => kick(p)}>
          <UserX aria-hidden />
          踢出
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onOpenBan(p)}>
          <Ban aria-hidden />
          封禁…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
