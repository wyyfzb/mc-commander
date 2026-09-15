/**
 * PlayerTable —— 玩家表格（10 列规格，TanStack Table）
 * - 默认排序 = 收敛规则（在线>离线 → OP → lastSeen → 总时长，applyPlayersFilter 预排）
 * - 列头点击启用单列排序（Web 增强）；分页 10/20/50/全部（「全部」档 react-virtual 虚拟滚动）
 * - 行内溢出菜单：详情/传送/给予物品/OP 切换/白名单切换/踢出/封禁（设计文档 §3.2 重排）
 * - 行内菜单交互口径（J15）：可逆（OP/白名单）直执 + 5s 撤销，踢出直执（无逆操作）
 * - 响应式（J28/C3）：<1280px 裁到核心列（免横向滚动）；<640px 整表转行式卡片
 * 单元拆分（纯搬移零行为变更）：列定义 player-table-columns / 行组件 player-table-row /
 * 行菜单 player-row-menu / 卡片态 player-card-list / 共享常量 player-table-config
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  flexRender,
  useTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { cn } from '@/lib/utils'
import { Pagination } from '@/components/mcs/pagination'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { BREAKPOINT_BELOW_SM, BREAKPOINT_BELOW_XL, useMediaQuery } from '@/hooks/use-media-query'
import type { Player } from '@/api/types'
import { usePlayersUiStore, type PlayerDetailTab } from '../store'
import type { PlayerActionRequest } from '../mutations'
import { toastWithUndo } from '../reversible-action'
import { paginatePlayerRows } from '../player-pagination'
import { PAGE_SIZE_OPTIONS, ROW_HEIGHT, features } from './player-table-config'
import { buildPlayerColumns } from './player-table-columns'
import { PlayerRow } from './player-table-row'
import { PlayerCardList, CARD_HEIGHT } from './player-card-list'

interface PlayerTableProps {
  /** 已过滤+排序的玩家列表 */
  players: Player[]
  isLoading: boolean
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
  const scrollRef = useRef<HTMLDivElement>(null)

  const selectedSet = useMemo(() => new Set(selectedUuids), [selectedUuids])
  /** <640px：整表转卡片（列宽再怎么妥协也放不下 10 列） */
  const isCardLayout = useMediaQuery(BREAKPOINT_BELOW_SM)
  /** <1280px：10 列合计约 1016px，容器装不下 → 裁到核心列免横向滚动 */
  const isCompactColumns = useMediaQuery(BREAKPOINT_BELOW_XL)

  /**
   * 可逆操作（OP/白名单）：直执 + 5s 撤销。失败回执由页面层（handleAction）承担——
   * 此处再 toast 会与页面层重复。
   */
  const runReversible = useCallback(
    async (req: PlayerActionRequest, undoReq: PlayerActionRequest, successText: string, undoText: string) => {
      try {
        await onAction(req)
        toastWithUndo({ text: successText, undoText, undo: () => onAction(undoReq) })
      } catch {
        // 页面层已回执错误
      }
    },
    [onAction],
  )

  const toggleOp = useCallback(
    (p: Player) => {
      const revoke = p.isOp
      void runReversible(
        { kind: revoke ? 'deop' : 'op', playerName: p.name },
        { kind: revoke ? 'op' : 'deop', playerName: p.name },
        revoke ? `已取消 ${p.name} 的 OP` : `已设置 ${p.name} 为 OP`,
        revoke ? `已恢复 ${p.name} 的 OP` : `已取消 ${p.name} 的 OP`,
      )
    },
    [runReversible],
  )

  const toggleWhitelist = useCallback(
    (p: Player) => {
      const remove = p.isWhitelisted
      void runReversible(
        { kind: remove ? 'whitelistRemove' : 'whitelistAdd', playerName: p.name },
        { kind: remove ? 'whitelistAdd' : 'whitelistRemove', playerName: p.name },
        remove ? `已移除 ${p.name} 的白名单` : `已添加 ${p.name} 至白名单`,
        remove ? `已恢复 ${p.name} 的白名单` : `已移除 ${p.name} 的白名单`,
      )
    },
    [runReversible],
  )

  /** 踢出：无逆操作（重新加入由玩家侧发起）——直执 + 普通回执 */
  const kick = useCallback(
    async (p: Player) => {
      try {
        await onAction({ kind: 'kick', playerName: p.name })
        onKicked()
      } catch {
        // 页面层已回执错误
      }
    },
    [onAction, onKicked],
  )

  const columns = useMemo<ColumnDef<typeof features, Player>[]>(
    () =>
      buildPlayerColumns({
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
        compact: isCompactColumns,
      }),
    // pageSize/pageIndex 参与表头全选范围计算，变更须重建列以刷新表头勾选态
    [
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
      isCompactColumns,
    ],
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

  // 表头全选范围（卡片态的全选入口复用同一口径：-1 档作用于全部筛选结果）
  const pageRowIds =
    pageSize === -1 ? allRows.map((r) => r.original.uuid) : visibleRows.map((r) => r.original.uuid)
  const allSelected = pageRowIds.length > 0 && pageRowIds.every((u) => selectedSet.has(u))
  const someSelected = pageRowIds.some((u) => selectedSet.has(u))

  // TanStack Virtual 自管内部缓存，与 React Compiler 互斥（官方不兼容清单），不可自动 memo 化
  // eslint-disable-next-line react/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: pageSize === -1 ? allRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (isCardLayout ? CARD_HEIGHT : ROW_HEIGHT),
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
        {/* 窄屏（<640px）表格必然横向溢出：勾选框/玩家名/操作入口都够不着 → 改行式卡片 */}
        {isCardLayout ? (
          <PlayerCardList
            rows={rowsToRender.filter(Boolean) as typeof visibleRows}
            isLoading={isLoading}
            selectedSet={selectedSet}
            selectAllLabel={pageSize === -1 ? '全选全部筛选结果' : '全选当前页'}
            allSelected={allSelected}
            someSelected={someSelected}
            onToggleSelectAll={() => toggleSelectPage(pageRowIds)}
            toggleSelect={toggleSelect}
            onOpenDetail={onOpenDetail}
            onOpenBan={onOpenBan}
            toggleOp={toggleOp}
            toggleWhitelist={toggleWhitelist}
            kick={kick}
            topPadding={pageSize === -1 ? topPadding : 0}
            bottomPadding={pageSize === -1 ? bottomPadding : 0}
          />
        ) : (
        <table className="w-full border-collapse text-left" style={{ tableLayout: 'fixed' }}>
          <thead className="sticky top-0 z-(--mcs-z-local) bg-mcs-bg-default">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-mcs-border-muted">
                {headerGroup.headers.map((header) => {
                  // 数值列（延迟/在线时长/总时长）表头与 cell 同向右对齐
                  const rightAlign = ['ping', 'onlineDuration', 'totalPlayTime'].includes(header.column.id)
                  const sorted = header.column.getIsSorted()
                  const canSort = header.column.getCanSort()
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      style={{ width: header.getSize() }}
                      // 排序态由 aria-sort 承担：箭头是 aria-hidden 的纯视觉提示，
                      // 不能作为唯一信息源（读屏用户拿不到「当前按哪列排、什么方向」）
                      aria-sort={
                        !header.isPlaceholder && canSort
                          ? sorted === 'asc'
                            ? 'ascending'
                            : sorted === 'desc'
                              ? 'descending'
                              : 'none'
                          : undefined
                      }
                      className={cn(
                        'h-9 px-2 text-mcs-xs font-medium text-mcs-text-muted',
                        rightAlign && 'text-right',
                      )}
                    >
                      {header.isPlaceholder
                        ? null
                        : canSort
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
                              {sorted === 'asc' && <span aria-hidden>↑</span>}
                              {sorted === 'desc' && <span aria-hidden>↓</span>}
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
        )}
        {/* 错误态由页面持有（players-page 在 isError 时用 EmptyState 替换整张表，
            避免错误被呈现为「暂无在线玩家」的误导空态），表格不再自带第二套错误 UI */}
        {!isLoading && allRows.length === 0 ? (
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

      {/* 分页器常驻：切到「全部」档只换数据源（虚拟滚动）；分页栏若一并消失，
          用户就没有选回其他每页条数的入口（只能刷新页面） */}
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

      <span className="sr-only">{isRconConnected ? 'rcon' : 'no-rcon'}</span>
    </div>
  )
}
