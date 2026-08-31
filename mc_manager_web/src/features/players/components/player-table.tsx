/**
 * PlayerTable —— 玩家表格（10 列规格，TanStack Table）
 * - 默认排序 = 收敛规则（在线>离线 → OP → lastSeen → 总时长，applyPlayersFilter 预排）
 * - 列头点击启用单列排序（Web 增强）；分页 10/20/50/全部（「全部」档 react-virtual 虚拟滚动）
 * - 行内溢出菜单：详情/传送/给予物品/OP 切换/白名单切换/踢出/封禁（设计文档 §3.2 重排）
 */
import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  columnSizingFeature,
  columnVisibilityFeature,
  flexRender,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type Row,
  type SortingState,
} from '@tanstack/react-table'
import {
  Ban,
  CircleAlert,
  ChevronLeft,
  ChevronRight,
  Eye,
  Gift,
  MoreHorizontal,
  Send,
  ShieldCheck,
  ShieldX,
  UserX,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { cn } from '@/lib/utils'
import { formatBanRemaining } from '@/lib/mc-ban'
import type { Player } from '@/api/types'
import { usePlayersUiStore, type PlayerDetailTab } from '../store'
import type { PlayerActionRequest } from '../mutations'
import { PlayerAvatar } from './player-avatar'
import { HeartsArmor } from './hearts-armor'

const PAGE_SIZE_OPTIONS = [10, 20, 50, -1] as const // -1 = 全部
const ROW_HEIGHT = 40 // 对齐设计文档 §4.3 default 档密度

const GAME_MODE_LABELS: Record<string, string> = {
  survival: '生存',
  creative: '创造',
  adventure: '冒险',
  spectator: '旁观',
}

// v9 features 需模块级静态定义（官方建议）：排序 + 列尺寸（getSize）/列可见（getVisibleCells）
const features = tableFeatures({
  rowSortingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
})

const DIMENSION_META = {
  overworld: { label: '主世界', token: '--mcs-dimension-overworld' },
  nether: { label: '下界', token: '--mcs-dimension-nether' },
  end: { label: '末地', token: '--mcs-dimension-end' },
} as const

interface PlayerTableProps {
  /** 已过滤+排序的玩家列表 */
  players: Player[]
  isLoading: boolean
  /** 加载失败时显示错误提示 + 重试按钮 */
  isError?: boolean
  onRetry?: () => void
  /** 未筛选总数（空态双文案判断：0=暂无玩家，>0=无匹配） */
  totalCount: number
  isRconConnected: boolean
  onOpenDetail: (name: string, tab?: PlayerDetailTab) => void
  onOpenBan: (player: Player) => void
  /** 行内菜单与批量共用的操作回调（OP/白名单/踢出等；错误 toast 由调用方处理） */
  onAction: (req: PlayerActionRequest) => Promise<void>
  /** 踢出成功后的额外回调（toast 等） */
  onKicked: () => void
}

export function PlayerTable({
  players,
  isLoading,
  isError,
  onRetry,
  totalCount,
  isRconConnected,
  onOpenDetail,
  onOpenBan,
  onAction,
  onKicked,
}: PlayerTableProps) {
  const selectedUuids = usePlayersUiStore((s) => s.selectedUuids)
  const toggleSelect = usePlayersUiStore((s) => s.toggleSelect)
  const toggleSelectPage = usePlayersUiStore((s) => s.toggleSelectPage)
  const [sorting, setSorting] = useState<SortingState>([])
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(20)
  const [pageIndex, setPageIndex] = useState(0)
  const [kickTarget, setKickTarget] = useState<Player | null>(null)
  /** OP/白名单切换确认 */
  const [confirmToggle, setConfirmToggle] = useState<{ type: 'op' | 'whitelist'; player: Player } | null>(null)
  /** 行内确认提交中（防确认期间重复点击产生重复 kick/op 请求） */
  const [confirmPending, setConfirmPending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const selectedSet = useMemo(() => new Set(selectedUuids), [selectedUuids])

  const columns = useMemo<ColumnDef<typeof features, Player>[]>(
    () => [
      {
        id: 'select',
        enableSorting: false, // 无排序语义，且避免排序按钮嵌套 Checkbox（非法 HTML）
        header: ({ table }) => {
          const pageIds = table.getRowModel().rows.map((r) => r.original.uuid)
          const allSelected = pageIds.length > 0 && pageIds.every((u) => selectedSet.has(u))
          const someSelected = pageIds.some((u) => selectedSet.has(u))
          return (
            <Checkbox
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={() => toggleSelectPage(pageIds)}
              aria-label="全选当前页"
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
                    <span className="shrink-0 rounded-mcs-xs bg-mcs-bg-hover px-1 text-mcs-2xs text-mcs-text-muted">
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
                  <div className="truncate font-mono text-mcs-2xs text-mcs-text-subtle">{p.ip}</div>
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
            <span className="text-mcs-xs text-mcs-text-subtle">--</span>
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
            <span className="text-mcs-xs text-mcs-text-subtle">--</span>
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
                  <span className="cursor-help text-mcs-xs text-mcs-text-subtle">需插件</span>
                </TooltipTrigger>
                <TooltipContent>原版 RCON 不暴露玩家 ping</TooltipContent>
              </Tooltip>
            )
          }
          const color =
            ping < 50 ? 'var(--mcs-accent)' : ping < 150 ? 'var(--mcs-warning-fg)' : 'var(--mcs-error-fg)'
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
              {p.isOnline ? formatOnlineTimeShort(p.onlineTime) : formatLastSeenShort(p.lastSeen)}
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
    ],
    [selectedSet, onOpenDetail, onAction, onOpenBan, toggleSelect, toggleSelectPage],
  )

  const table = useTable(
    {
      features,
      data: players,
      columns,
      state: { sorting },
      onSortingChange: setSorting,
    },
  )

  const allRows = table.getRowModel().rows
  const totalPages = pageSize === -1 ? 1 : Math.max(1, Math.ceil(allRows.length / pageSize))
  const safePageIndex = Math.min(pageIndex, totalPages - 1)
  const visibleRows =
    pageSize === -1 ? allRows : allRows.slice(safePageIndex * pageSize, (safePageIndex + 1) * pageSize)

  const rowVirtualizer = useVirtualizer({
    count: pageSize === -1 ? allRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  /** 页码集合：{1, total, current±2} + 省略号 */
  const pageNumbers = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const set = new Set<number>([
      1,
      totalPages,
      safePageIndex + 1,
      safePageIndex,
      safePageIndex - 1,
      safePageIndex + 2,
      safePageIndex - 2,
    ])
    const sorted = [...set].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b)
    const withGaps: Array<number | '…'> = []
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i]! - sorted[i - 1]! > 1) withGaps.push('…')
      withGaps.push(sorted[i]!)
    }
    return withGaps
  }, [totalPages, safePageIndex])

  const virtualItems = rowVirtualizer.getVirtualItems()
  const topPadding = virtualItems.length > 0 ? virtualItems[0]!.start : 0
  const bottomPadding =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1]?.end ?? 0)
      : 0

  const rowsToRender = pageSize === -1 ? virtualItems.map((v) => allRows[v.index]) : visibleRows

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" data-density="compact">
        <table className="w-full border-collapse text-left" style={{ tableLayout: 'fixed' }}>
          <thead className="sticky top-0 z-10 bg-mcs-bg-default">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-mcs-border-muted">
                {headerGroup.headers.map((header) => {
                  // 数值列（延迟/在线时长/总时长）表头与 cell 同向右对齐
                  const rightAlign = ['ping', 'onlineDuration', 'totalPlayTime'].includes(header.column.id)
                  return (
                    <th
                      key={header.id}
                      style={{ width: header.getSize() }}
                      className={cn(
                        'h-9 px-2 text-mcs-xs font-medium text-mcs-text-subtle',
                        rightAlign && 'text-right',
                      )}
                    >
                      {header.isPlaceholder
                        ? null
                        : header.column.getCanSort()
                          ? (
                            <button
                              type="button"
                              className={cn(
                                'flex cursor-pointer items-center gap-1 hover:text-mcs-text-muted',
                                rightAlign && 'w-full justify-end',
                              )}
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {header.column.getIsSorted() === 'asc' && <span aria-hidden>↑</span>}
                              {header.column.getIsSorted() === 'desc' && <span aria-hidden>↓</span>}
                            </button>
                          )
                          : (
                            <span className={cn('flex items-center gap-1', rightAlign && 'justify-end')}>
                              {flexRender(header.column.columnDef.header, header.getContext())}
                            </span>
                          )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {isLoading &&
              // 加载骨架行（设计规范 4.7/8：骨架屏而非空白，结构对齐真实列）
              Array.from({ length: 5 }, (_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-mcs-border-subtle" style={{ height: ROW_HEIGHT }} aria-hidden>
                  {table.getHeaderGroups()[0]!.headers.map((h) => (
                    <td key={h.id} className="px-2">
                      <Skeleton className="h-3.5 w-3/4" />
                    </td>
                  ))}
                </tr>
              ))}
            {!isLoading && pageSize === -1 && topPadding > 0 && <tr style={{ height: topPadding }} aria-hidden />}
            {!isLoading &&
              rowsToRender.map((row) =>
                row ? (
                  <PlayerRow
                    key={row.id}
                    row={row}
                    selected={selectedSet.has(row.original.uuid)}
                    onOpenDetail={onOpenDetail}
                  />
                ) : null,
              )}
            {!isLoading && pageSize === -1 && bottomPadding > 0 && <tr style={{ height: bottomPadding }} aria-hidden />}
          </tbody>
        </table>
        {isError && !isLoading && allRows.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2">
            <CircleAlert className="size-6 text-mcs-text-subtle" aria-hidden />
            <p className="text-mcs-sm text-mcs-text-muted">加载玩家列表失败</p>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                重试
              </Button>
            )}
          </div>
        ) : !isLoading && allRows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-mcs-sm text-mcs-text-subtle">
            {totalCount === 0 ? '暂无在线玩家' : '没有匹配的玩家'}
          </div>
        ) : null}
      </div>

      {/* 分页器（非「全部」档） */}
      {pageSize !== -1 && (
        <div
          className="flex items-center justify-between border-t border-mcs-border-muted px-4 py-2"
          data-density="compact"
        >
          <div className="flex items-center gap-2 text-mcs-xs text-mcs-text-subtle">
            每页
            <select
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number])
                setPageIndex(0)
              }}
              className="rounded-mcs-xs border border-mcs-border-default bg-mcs-bg-muted px-1.5 py-0.5 text-mcs-xs text-mcs-text-default"
              aria-label="每页行数"
            >
              {PAGE_SIZE_OPTIONS.filter((s) => s !== -1).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value={-1}>全部</option>
            </select>
            <span>
              共 {allRows.length} 条 · 第 {safePageIndex + 1}/{totalPages} 页
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={safePageIndex === 0}
              onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              aria-label="上一页"
            >
              <ChevronLeft aria-hidden />
            </Button>
            {pageNumbers.map((n, i) =>
              n === '…' ? (
                <span key={`gap${i}`} className="px-1 text-mcs-xs text-mcs-text-subtle">
                  …
                </span>
              ) : (
                <Button
                  key={n}
                  variant={safePageIndex + 1 === n ? 'default' : 'ghost'}
                  size="icon-sm"
                  onClick={() => setPageIndex(n - 1)}
                  aria-label={`第 ${n} 页`}
                >
                  {n}
                </Button>
              ),
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={safePageIndex >= totalPages - 1}
              onClick={() => setPageIndex((p) => Math.min(totalPages - 1, p + 1))}
              aria-label="下一页"
            >
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
      )}

      {/* OP/白名单切换确认 */}
      <ConfirmDialog
        open={confirmToggle !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmToggle(null)
        }}
        title={
          confirmToggle
            ? confirmToggle.type === 'op'
              ? confirmToggle.player.isOp
                ? '确认取消 OP'
                : '确认设为 OP'
              : confirmToggle.player.isWhitelisted
                ? '确认移除白名单'
                : '确认加入白名单'
            : ''
        }
        description={
          confirmToggle
            ? confirmToggle.type === 'op'
              ? confirmToggle.player.isOp
                ? `即将取消 ${confirmToggle.player.name} 的 OP 权限`
                : `即将设置 ${confirmToggle.player.name} 为 OP`
              : confirmToggle.player.isWhitelisted
                ? `即将移除 ${confirmToggle.player.name} 的白名单`
                : `即将添加 ${confirmToggle.player.name} 至白名单`
            : ''
        }
        confirmText="确认操作"
        loading={confirmPending}
        onConfirm={async () => {
          if (!confirmToggle) return
          const { type, player } = confirmToggle
          setConfirmPending(true)
          try {
            if (type === 'op') {
              await onAction({ kind: player.isOp ? 'deop' : 'op', playerName: player.name })
            } else {
              await onAction({
                kind: player.isWhitelisted ? 'whitelistRemove' : 'whitelistAdd',
                playerName: player.name,
              })
            }
            setConfirmToggle(null)
          } finally {
            setConfirmPending(false)
          }
        }}
      />

      {/* 踢出确认 */}
      <ConfirmDialog
        open={kickTarget !== null}
        onOpenChange={(open) => {
          if (!open) setKickTarget(null)
        }}
        title="确认踢出"
        description={`即将踢出 ${kickTarget?.name ?? ''}`}
        warning="此操作不可撤销"
        confirmText="确认操作"
        danger
        loading={confirmPending}
        onConfirm={async () => {
          if (!kickTarget) return
          setConfirmPending(true)
          try {
            await onAction({ kind: 'kick', playerName: kickTarget.name })
            setKickTarget(null)
            onKicked()
          } finally {
            setConfirmPending(false)
          }
        }}
      />
      <span className="sr-only">{isRconConnected ? 'rcon' : 'no-rcon'}</span>
    </div>
  )
}

function PlayerRow({
  row,
  selected,
  onOpenDetail,
}: {
  row: Row<typeof features, Player>
  selected: boolean
  onOpenDetail: (name: string) => void
}) {
  const p = row.original
  return (
    <tr
      className={cn(
        'cursor-pointer border-b border-mcs-border-subtle transition-colors',
        selected ? 'bg-mcs-accent-bg-subtle' : 'hover:bg-mcs-bg-hover',
        (p.isBanned || p.isIpBanned) && 'bg-mcs-error-bg-subtle',
      )}
      style={{ height: ROW_HEIGHT }}
      tabIndex={0}
      aria-label={`查看 ${p.name} 详情`}
      onClick={() => onOpenDetail(p.name)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenDetail(p.name)
        }
      }}
    >
      {row.getVisibleCells().map((cell) => (
        <td
          key={cell.id}
          className="truncate px-2"
          onClick={(e) => {
            // 选择列与操作列不触发行点击
            if (cell.column.id === 'actions' || cell.column.id === 'select') e.stopPropagation()
          }}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  )
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

/** 离线行「在线时长」列显示最后上线相对时间（null=从未） */
function formatLastSeenShort(lastSeen: string | null): string {
  if (lastSeen == null) return '从未'
  const delta = Date.now() - new Date(lastSeen).getTime()
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return `${Math.floor(hours / 24)}天前`
}
