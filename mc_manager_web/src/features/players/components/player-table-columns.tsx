/**
 * PlayerTable 列定义 —— 10 列规格（自 player-table.tsx 拆出，纯搬移零行为变更）
 * 工厂参数化注入选择集与操作回调；依赖常量见 player-table-config.ts
 * 行内菜单交互口径（J15）：OP/白名单切换可逆 → 直执 + 5s 撤销；踢出无逆操作 → 直执 + 普通回执
 * compact（<1280px 容器）：10 列合计约 1016px，装不下时表格会横向溢出把勾选框与玩家名推出视野，
 * 故按列价值裁到核心四列（选择/玩家/状态/操作）；被裁列的字段在详情面板仍可查
 */
import type { ColumnDef } from '@tanstack/react-table'
import { Ban } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/format'
import type { Player } from '@/api/types'
import type { PlayerDetailTab } from '../store'
import { paginatePlayerRows } from '../player-pagination'
import { PlayerAvatar } from './player-avatar'
import { PlayerBadges } from './player-badges'
import { PlayerRowMenu } from './player-row-menu'
import { HeartsArmor } from './hearts-armor'
import { DIMENSION_META, GAME_MODE_LABELS, features } from './player-table-config'

/** 列优先级：容器装不下时按此集合裁剪（保留 选择/玩家/状态/操作 —— 身份、在线状态、行动入口） */
const SECONDARY_COLUMN_IDS = new Set(['gameMode', 'dimension', 'position', 'ping', 'onlineDuration', 'totalPlayTime'])

/** OP/白名单切换与踢出的行内执行回调（表格持有：执行 + 回执 + 撤销口径） */
interface PlayerColumnsDeps {
  selectedSet: Set<string>
  onOpenDetail: (name: string, tab?: PlayerDetailTab) => void
  onOpenBan: (player: Player) => void
  toggleSelect: (uuid: string) => void
  toggleSelectPage: (pageUuids: string[]) => void
  /** 可逆：直执 + 5s 撤销 */
  toggleOp: (player: Player) => void
  /** 可逆：直执 + 5s 撤销 */
  toggleWhitelist: (player: Player) => void
  /** 无逆操作：直执 + 普通回执 */
  kick: (player: Player) => void
  /** 分页状态（-1 = 「全部」档）：表头全选只能作用于当前页，见 select 列 header */
  pageSize: number
  pageIndex: number
  /** 窄容器：只留核心列（免横向滚动把勾选框/玩家名推出视野） */
  compact: boolean
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
  toggleOp,
  toggleWhitelist,
  kick,
  pageSize,
  pageIndex,
  compact,
}: PlayerColumnsDeps): ColumnDef<typeof features, Player>[] {
  const columns: ColumnDef<typeof features, Player>[] = [
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
                <button
                  type="button"
                  className={cn(
                    // 与其余单元格文字同款，仅补回 button 被 UA 设成居中所丢的对齐与指针
                    'cursor-pointer truncate text-left text-mcs-sm font-medium',
                    banned ? 'text-mcs-error-fg' : p.isOnline ? 'text-mcs-text-default' : 'text-mcs-text-muted',
                  )}
                  aria-label={`查看 ${p.name} 详情`}
                  onClick={(e) => {
                    // 行级 onClick 只服务指针便利；此处已处理，阻止冒泡避免重复调用
                    e.stopPropagation()
                    onOpenDetail(p.name)
                  }}
                >
                  {p.name}
                </button>
                <PlayerBadges player={p} />
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
      cell: ({ row }) => (
        <PlayerRowMenu
          player={row.original}
          onOpenDetail={onOpenDetail}
          onOpenBan={onOpenBan}
          toggleOp={toggleOp}
          toggleWhitelist={toggleWhitelist}
          kick={kick}
        />
      ),
      size: 48,
    },
  ]

  return compact ? columns.filter((c) => !SECONDARY_COLUMN_IDS.has(c.id ?? '')) : columns
}
