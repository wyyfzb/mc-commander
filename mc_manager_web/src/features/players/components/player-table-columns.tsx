/**
 * PlayerTable 列定义 —— 10 列规格（自 player-table.tsx 拆出，纯搬移零行为变更）
 * 工厂参数化注入选择集与操作回调；依赖常量见 player-table-config.ts
 */
import type { ColumnDef } from '@tanstack/react-table'
import {
  Ban,
  Eye,
  Gift,
  MoreHorizontal,
  Send,
  ShieldCheck,
  ShieldX,
  UserX,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/format'
import { formatBanRemaining } from '@/lib/mc-ban'
import type { Player } from '@/api/types'
import type { PlayerDetailTab } from '../store'
import { paginatePlayerRows } from '../player-pagination'
import { PlayerAvatar } from './player-avatar'
import { HeartsArmor } from './hearts-armor'
import { DIMENSION_META, GAME_MODE_LABELS, features } from './player-table-config'

/** OP/白名单切换确认状态（主表格持有，操作列触发） */
export interface ConfirmToggleState {
  type: 'op' | 'whitelist'
  player: Player
}

interface PlayerColumnsDeps {
  selectedSet: Set<string>
  onOpenDetail: (name: string, tab?: PlayerDetailTab) => void
  onOpenBan: (player: Player) => void
  toggleSelect: (uuid: string) => void
  toggleSelectPage: (pageUuids: string[]) => void
  setConfirmToggle: (v: ConfirmToggleState | null) => void
  setKickTarget: (v: Player | null) => void
  /** 分页状态（-1 = 「全部」档）：表头全选只能作用于当前页，见 select 列 header */
  pageSize: number
  pageIndex: number
}

/** 在线时长短格式（Xh Ym） */
function formatOnlineTimeShort(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** 总时长短格式（Xh Ym） */
function formatTotalPlayTimeShort(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function buildPlayerColumns({
  selectedSet,
  onOpenDetail,
  onOpenBan,
  toggleSelect,
  toggleSelectPage,
  setConfirmToggle,
  setKickTarget,
  pageSize,
  pageIndex,
}: PlayerColumnsDeps): ColumnDef<typeof features, Player>[] {
  return [
    {
      id: 'select',
      enableSorting: false, // 无排序语义，且避免排序按钮嵌套 Checkbox（非法 HTML）
      header: ({ table }) => {
        // 分页由外层手动切片（table 未注册分页 feature，其 rows 是全量），
        // 故此处按同一规则复算当前页，避免「全选当前页」实际选中全部筛选结果
        const pageIds = paginatePlayerRows(table.getRowModel().rows, pageSize, pageIndex).rows
          .map((r) => r.original.uuid)
        const allSelected = pageIds.length > 0 && pageIds.every((u) => selectedSet.has(u))
        const someSelected = pageIds.some((u) => selectedSet.has(u))
        return (
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={() => toggleSelectPage(pageIds)}
            aria-label={pageSize === -1 ? '全选全部筛选结果' : '全选当前页'}
          />
        )
      },
      cell: ({ row }) => (
        <Checkbox
          checked={selectedSet.has(row.original.uuid)}
          onCheckedChange={() => toggleSelect(row.original.uuid)}
          aria-label={`选择 ${row.original.name}`}
        />
      ),
      size: 40,
    },
    {
      id: 'player',
      header: '玩家',
      accessorFn: (p) => p.name,
      cell: ({ row }) => {
        const p = row.original
        const banned = p.isBanned || p.isIpBanned
        return (
          <div className="flex min-w-0 items-center gap-2.5">
            <PlayerAvatar name={p.name} isOnline={p.isOnline} isFakePlayer={p.isFakePlayer} size={28} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'truncate text-mcs-sm font-medium',
                    banned ? 'text-mcs-error-fg' : p.isOnline ? 'text-mcs-text-default' : 'text-mcs-text-muted',
                  )}
                >
                  {p.name}
                </span>
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
                      ? `封禁·${formatBanRemaining(p.banExpiresAt, Date.now()) ?? '即将解封'}`
                      : '封禁'}
                  </span>
                )}
              </div>
              {p.isOnline && p.ip && (
                <div className="truncate font-mono text-mcs-2xs text-mcs-text-muted">{p.ip}</div>
              )}
            </div>
          </div>
        )
      },
      minSize: 200,
    },
    {
      id: 'gameMode',
      header: '模式',
      accessorFn: (p) => (p.gameMode ? GAME_MODE_LABELS[p.gameMode] ?? p.gameMode : ''),
      cell: ({ getValue }) => (
        <span className="text-mcs-xs text-mcs-text-muted">{String(getValue() || '--')}</span>
      ),
      size: 72,
    },
    {
      id: 'dimension',
      header: '维度',
      accessorFn: (p) =>
        p.dimension ? DIMENSION_META[p.dimension as keyof typeof DIMENSION_META]?.label ?? p.dimension : '',
      cell: ({ row }) => {
        const dim = row.original.dimension as keyof typeof DIMENSION_META | null
        const meta = dim ? DIMENSION_META[dim] : null
        return meta ? (
          <span className="inline-flex items-center gap-1.5 text-mcs-xs text-mcs-text-muted">
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: `var(${meta.token})` }}
              aria-hidden
            />
            {meta.label}
          </span>
        ) : (
          <span className="text-mcs-xs text-mcs-text-muted">--</span>
        )
      },
      size: 96,
    },
    {
      id: 'position',
      header: '坐标',
      cell: ({ row }) => {
        const pos = row.original.position
        return pos ? (
          <span className="font-mono text-mcs-xs text-mcs-text-muted">
            {Math.round(pos.x)}, {Math.round(pos.y)}, {Math.round(pos.z)}
          </span>
        ) : (
          <span className="text-mcs-xs text-mcs-text-muted">--</span>
        )
      },
      size: 120,
    },
    {
      id: 'status',
      header: '状态',
      cell: ({ row }) => {
        const p = row.original
        if (!p.isOnline) {
          return p.isBanned || p.isIpBanned ? (
            <span className="inline-flex items-center gap-1 text-mcs-xs text-mcs-error-fg">
              <Ban className="size-3" aria-hidden />
              已封禁
            </span>
          ) : (
            <span className="text-mcs-xs text-mcs-text-muted">离线</span>
          )
        }
        return <HeartsArmor health={p.health} maxHealth={p.maxHealth} armor={p.armor} />
      },
      // 心行 10×11px + 护甲数字角标 = 157px（heartsArmorContentWidth 断言防裁剪），留出 px-2 余量
      size: 192,
    },
    {
      id: 'ping',
      header: '延迟',
      accessorFn: (p) => p.ping,
      cell: ({ row }) => {
        const ping = row.original.ping
        // 服务端从不返回 ping（RCON 不暴露）——undefined 同样视为「需插件」
        if (ping == null) {
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help text-mcs-xs text-mcs-text-muted">需插件</span>
              </TooltipTrigger>
              <TooltipContent>原版 RCON 不暴露玩家 ping</TooltipContent>
            </Tooltip>
          )
        }
        const color =
          ping < 50 ? 'var(--mcs-success-fg)' : ping < 150 ? 'var(--mcs-warning-fg)' : 'var(--mcs-error-fg)'
        return (
          <span className="inline-flex items-center justify-end gap-1.5 font-mono text-mcs-xs tabular-nums text-mcs-text-muted">
            <span className="inline-block size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
            {ping}
          </span>
        )
      },
      size: 72,
    },
    {
      id: 'onlineDuration',
      header: '在线时长',
      cell: ({ row }) => {
        const p = row.original
        return (
          <span className="block text-right text-mcs-xs text-mcs-text-muted">
            {p.isOnline ? formatOnlineTimeShort(p.onlineTime) : formatRelativeTime(p.lastSeen ?? null, Date.now(), '从未')}
          </span>
        )
      },
      size: 88,
    },
    {
      id: 'totalPlayTime',
      header: '总时长',
      accessorFn: (p) => p.totalPlayTime,
      cell: ({ getValue }) => (
        <span className="block text-right font-mono text-mcs-xs tabular-nums text-mcs-text-muted">
          {formatTotalPlayTimeShort(Number(getValue()))}
        </span>
      ),
      size: 88,
    },
    {
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: ({ row }) => {
        const p = row.original
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
              <DropdownMenuItem disabled={!p.isOnline} onClick={() => onOpenDetail(p.name, 'teleport')}>
                <Send aria-hidden />
                传送
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!p.isOnline} onClick={() => onOpenDetail(p.name, 'give')}>
                <Gift aria-hidden />
                给予物品
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setConfirmToggle({ type: 'op', player: p })}>
                {p.isOp ? <ShieldX aria-hidden /> : <ShieldCheck aria-hidden />}
                {p.isOp ? '取消 OP' : '设为 OP'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setConfirmToggle({ type: 'whitelist', player: p })}>
                {p.isWhitelisted ? <ShieldX aria-hidden /> : <ShieldCheck aria-hidden />}
                {p.isWhitelisted ? '移除白名单' : '加入白名单'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!p.isOnline} onClick={() => setKickTarget(p)}>
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
      },
      size: 48,
    },
  ]
}
