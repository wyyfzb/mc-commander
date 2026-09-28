/**
 * PlayerCardList —— 窄屏（<640px）玩家行式卡片
 * 表格在 375px 上横向溢出约 670px：勾选框、玩家名、状态与操作入口都要靠横向滚动才够得着，
 * 长文本也被挤到不可读。卡片态把一行摊成：勾选 + 头像 + 姓名（与徽标同行）+ 摘要行 + 操作菜单，
 * 无横向滚动、无列宽妥协。与表格共用同一套行内操作（菜单/撤销口径完全相同）
 *
 * 字号口径：姓名用 md（14px + semibold），摘要行用 xs（12px，与表格同名字段同档）；
 * 徽标与 IP 保持 2xs——前者是角标、后者是 mono 元数据，都在 2xs 的允许面内
 */
import type { Row } from '@tanstack/react-table'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/format'
import type { Player } from '@/api/types'
import type { PlayerDetailTab } from '../store'
import { PlayerAvatar } from './player-avatar'
import { PlayerBadges } from './player-badges'
import { PlayerRowMenu } from './player-row-menu'
import { HeartsArmor } from './hearts-armor'
import { DIMENSION_META, GAME_MODE_LABELS, features } from './player-table-config'

/** 卡片估算行高（实测：离线单行卡 68px；在线卡的血量护甲约 120px 宽，把摘要行顶到第二行 → 88px）
    取值口径：摘要行的状态 span 恒渲染 ⇒ 真实高度恒 ≥ 本值，虚拟窗口在任意 scrollTop 下都覆盖视口；
    取均值反而随数据构成漂移。e2e 锁单行卡实高为 68，本值须与之保持一致（改卡片内边距或字号时同步改，
    无自动校验） */
export const CARD_HEIGHT = 68

interface PlayerCardListProps {
  rows: Row<typeof features, Player>[]
  isLoading: boolean
  selectedSet: ReadonlySet<string>
  /** 全选口径与表格表头一致（「全部」档作用于全部筛选结果，否则当前页） */
  selectAllLabel: string
  allSelected: boolean
  someSelected: boolean
  onToggleSelectAll: () => void
  toggleSelect: (uuid: string) => void
  onOpenDetail: (name: string, tab?: PlayerDetailTab) => void
  onOpenBan: (player: Player) => void
  toggleOp: (player: Player) => void
  toggleWhitelist: (player: Player) => void
  kick: (player: Player) => void
  /** 「全部」档虚拟滚动的上下占位（与表格的占位行同口径） */
  topPadding?: number
  bottomPadding?: number
}

export function PlayerCardList({
  rows,
  isLoading,
  selectedSet,
  selectAllLabel,
  allSelected,
  someSelected,
  onToggleSelectAll,
  toggleSelect,
  onOpenDetail,
  onOpenBan,
  toggleOp,
  toggleWhitelist,
  kick,
  topPadding = 0,
  bottomPadding = 0,
}: PlayerCardListProps) {
  return (
    <div>
      {/* 表头消失后全选入口仍需可达：与表格表头同标签同口径 */}
      <div className="flex items-center gap-2 border-b border-mcs-border-muted px-3 py-2">
        <Checkbox
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onCheckedChange={onToggleSelectAll}
          aria-label={selectAllLabel}
        />
        <span className="text-mcs-xs text-mcs-text-muted">全选</span>
      </div>
      <ul className="flex flex-col">
        {isLoading &&
          Array.from({ length: 5 }, (_, i) => (
            <li
              key={`skeleton-${i}`}
              className="flex items-center gap-3 border-b border-mcs-border-subtle px-3 py-3"
              aria-hidden
            >
              <Skeleton className="size-9 rounded-mcs-sm" />
              <Skeleton className="h-3.5 w-2/5" />
            </li>
          ))}
        {!isLoading && topPadding > 0 && <li style={{ height: topPadding }} aria-hidden />}
        {!isLoading &&
          rows.map((row) => (
            <PlayerCard
              key={row.id}
              row={row}
              selected={selectedSet.has(row.original.uuid)}
              toggleSelect={toggleSelect}
              onOpenDetail={onOpenDetail}
              onOpenBan={onOpenBan}
              toggleOp={toggleOp}
              toggleWhitelist={toggleWhitelist}
              kick={kick}
            />
          ))}
        {!isLoading && bottomPadding > 0 && <li style={{ height: bottomPadding }} aria-hidden />}
      </ul>
    </div>
  )
}

/** 单张玩家卡：勾选 + 头像 + 姓名 + 徽标 + 摘要行 + 操作菜单 */
function PlayerCard({
  row,
  selected,
  toggleSelect,
  onOpenDetail,
  onOpenBan,
  toggleOp,
  toggleWhitelist,
  kick,
}: {
  row: Row<typeof features, Player>
  selected: boolean
} & Pick<
  PlayerCardListProps,
  'toggleSelect' | 'onOpenDetail' | 'onOpenBan' | 'toggleOp' | 'toggleWhitelist' | 'kick'
>) {
  const p = row.original
  const banned = p.isBanned || p.isIpBanned
  const dimension = p.dimension
    ? DIMENSION_META[p.dimension as keyof typeof DIMENSION_META]?.label
    : undefined
  // 渲染期取当前时间为可接受权衡：最后在线时间随列表数据刷新更新，非实时相对时钟
  // eslint-disable-next-line react/purity
  const nowMs = Date.now()

  return (
    <li
      className={cn(
        'border-b border-mcs-border-subtle',
        selected
          ? 'bg-mcs-accent-bg-subtle'
          : banned
            ? 'bg-mcs-error-bg-subtle'
            : 'bg-mcs-bg-default',
      )}
    >
      <div className="flex items-start gap-3 px-3 py-3">
        {/* 勾选框容器与 36px 头像同顶同高（h-9），16px 的框在其中垂直居中 →
            与头像共享中线；表格态由单元格 align-middle 天然对齐，卡片态须显式成带 */}
        <div className="flex h-9 shrink-0 items-center">
          <Checkbox
            checked={selected}
            onCheckedChange={() => toggleSelect(p.uuid)}
            aria-label={`选择 ${p.name}`}
          />
        </div>
        <PlayerAvatar name={p.name} isOnline={p.isOnline} isFakePlayer={p.isFakePlayer} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={cn(
                'cursor-pointer truncate text-left text-mcs-md font-semibold',
                banned
                  ? 'text-mcs-error-fg'
                  : p.isOnline
                    ? 'text-mcs-text-default'
                    : 'text-mcs-text-muted',
              )}
              aria-label={`查看 ${p.name} 详情`}
              onClick={() => onOpenDetail(p.name)}
            >
              {p.name}
            </button>
            <PlayerBadges player={p} />
          </div>
          {/* 摘要行：原先横向排开的列在此折为一行（状态在前，身份信息在后）
              中文走 xs：与表格同名字段（模式/维度/状态）同档；2xs 只留给角标与 mono 元数据 */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-mcs-xs text-mcs-text-muted">
            <span>
              {p.isOnline
                ? '在线'
                : `最后在线 ${formatRelativeTime(p.lastSeen ?? null, nowMs, '未知')}`}
            </span>
            {p.isOnline && (
              <HeartsArmor health={p.health} maxHealth={p.maxHealth} armor={p.armor} />
            )}
            {p.gameMode && <span>{GAME_MODE_LABELS[p.gameMode] ?? p.gameMode}</span>}
            {dimension && <span>{dimension}</span>}
            {p.isOnline && p.ip && <span className="font-mono text-mcs-2xs">{p.ip}</span>}
          </div>
        </div>
        <PlayerRowMenu
          player={p}
          onOpenDetail={onOpenDetail}
          onOpenBan={onOpenBan}
          toggleOp={toggleOp}
          toggleWhitelist={toggleWhitelist}
          kick={kick}
        />
      </div>
    </li>
  )
}
