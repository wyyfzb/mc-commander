/**
 * PlayerTable —— 玩家表格（10 列规格，TanStack Table）
 * - 默认排序 = 收敛规则（在线>离线 → OP → lastSeen → 总时长，applyPlayersFilter 预排）
 * - 列头点击启用单列排序（Web 增强）；分页 10/20/50/全部（「全部」档 react-virtual 虚拟滚动）
 * - 行内溢出菜单：详情/传送/给予物品/OP 切换/白名单切换/踢出/封禁（设计文档 §3.2 重排）
 * 单元拆分（纯搬移零行为变更）：列定义 player-table-columns / 行组件 player-table-row /
 * 确认弹窗 player-table-dialogs / 共享常量 player-table-config
 */
import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  flexRender,
  useTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { CircleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Pagination } from '@/components/mcs/pagination'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { Player } from '@/api/types'
import { usePlayersUiStore, type PlayerDetailTab } from '../store'
import type { PlayerActionRequest } from '../mutations'
import { paginatePlayerRows } from '../player-pagination'
import { PAGE_SIZE_OPTIONS, ROW_HEIGHT, features } from './player-table-config'
import { buildPlayerColumns, type ConfirmToggleState } from './player-table-columns'
import { PlayerRow } from './player-table-row'
import { PlayerConfirmDialogs } from './player-table-dialogs'

interface PlayerTableProps {
  /** 已过滤+排序的玩家列表 */
  players: Player[]
  isLoading: boolean
  /** 加载失败时显示错误提示 + 重试按钮 */
  isError?: boolean
  onRetry?: () => void
  /** 未筛选总数（空态双文案判断：0=暂无玩家，>0=无匹配） */
  totalCount: number
  /** 无匹配空态的清空筛选回调（有筛选时展示 CTA，issue 343） */
  onClearFilter?: () => void
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
  onClearFilter,
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
  const [confirmToggle, setConfirmToggle] = useState<ConfirmToggleState | null>(null)
  /** 行内确认提交中（防确认期间重复点击产生重复 kick/op 请求） */
  const [confirmPending, setConfirmPending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const selectedSet = useMemo(() => new Set(selectedUuids), [selectedUuids])

  const columns = useMemo<ColumnDef<typeof features, Player>[]>(
    () =>
      buildPlayerColumns({
        selectedSet,
        onOpenDetail,
        onOpenBan,
        toggleSelect,
        toggleSelectPage,
        setConfirmToggle,
        setKickTarget,
        pageSize,
        pageIndex,
      }),
    // pageSize/pageIndex 参与表头全选范围计算，变更须重建列以刷新表头勾选态
    [selectedSet, onOpenDetail, onOpenBan, toggleSelect, toggleSelectPage, pageSize, pageIndex],
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
  // 切片口径与表头「全选当前页」共用同一实现（player-pagination），勿就地重写
  const { rows: visibleRows, pageCount: totalPages, safePageIndex } = paginatePlayerRows(
    allRows,
    pageSize,
    pageIndex,
  )

  // TanStack Virtual 自管内部缓存，与 React Compiler 互斥（官方不兼容清单），不可自动 memo 化
  // eslint-disable-next-line react/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: pageSize === -1 ? allRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  const virtualItems = rowVirtualizer.getVirtualItems()
  const topPadding = virtualItems.length > 0 ? virtualItems[0]!.start : 0
  const bottomPadding =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1]?.end ?? 0)
      : 0

  const rowsToRender = pageSize === -1 ? virtualItems.map((v) => allRows[v.index]) : visibleRows

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left" style={{ tableLayout: 'fixed' }}>
          <thead className="sticky top-0 z-(--mcs-z-local) bg-mcs-bg-default">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-mcs-border-muted">
                {headerGroup.headers.map((header) => {
                  // 数值列（延迟/在线时长/总时长）表头与 cell 同向右对齐
                  const rightAlign = ['ping', 'onlineDuration', 'totalPlayTime'].includes(header.column.id)
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      style={{ width: header.getSize() }}
                      className={cn(
                        'h-9 px-2 text-mcs-xs font-medium text-mcs-text-muted',
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
            <CircleAlert className="size-6 text-mcs-text-muted" aria-hidden />
            <p className="text-mcs-sm text-mcs-text-muted">加载玩家列表失败</p>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                重试
              </Button>
            )}
          </div>
        ) : !isLoading && allRows.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-mcs-sm text-mcs-text-muted">
            {totalCount === 0 ? '暂无在线玩家' : '没有匹配的玩家'}
            {totalCount > 0 && onClearFilter && (
              <Button variant="outline" size="sm" onClick={onClearFilter} data-testid="players-clear-filter">
                清空筛选
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {/* 分页器（非「全部」档）——统一 Pagination 组件 */}
      {pageSize !== -1 && (
        <Pagination
          page={safePageIndex + 1}
          totalPages={totalPages}
          totalItems={allRows.length}
          onPageChange={(p) => setPageIndex(p - 1)}
          variant="numbers"
          pageSize={pageSize}
          pageSizeOptions={[...PAGE_SIZE_OPTIONS.filter((s) => s !== -1)]}
          onPageSizeChange={(size) => {
            setPageSize(size as (typeof PAGE_SIZE_OPTIONS)[number])
            setPageIndex(0)
          }}
          showAllOption
          showPageSizeSelector
        />
      )}

      <PlayerConfirmDialogs
        confirmToggle={confirmToggle}
        confirmPending={confirmPending}
        kickTarget={kickTarget}
        onCloseToggle={() => setConfirmToggle(null)}
        onCloseKick={() => setKickTarget(null)}
        onConfirmToggle={async () => {
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
        onConfirmKick={async () => {
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
