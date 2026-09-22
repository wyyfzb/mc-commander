/**
 * PlayerDetailPanel —— 详情面板壳（Master-Detail 右栏）
 * - 单个模式：头像+名字+状态徽章+UUID + 5 Tab（概览/物品栏/传送/给予物品/日志）
 * - 批量模式：堆叠头像+「已选择 N 名玩家」+目标名单，仅保留 传送/给予物品 Tab
 * - 承载方式见 variant：lg 及以上内联右栏 / lg 以下由 Sheet 承载（此前窄屏是无 dialog 语义的覆盖层）
 * - 打开期间封禁记录 30s 轮询
 */
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { Player } from '@/api/types'
import { DETAIL_TAB_LABELS, usePlayersUiStore, type PlayerDetailTab } from '../store'
import { usePlayerBans, usePlayerDetails } from '../queries'
import type { PlayerActionRequest } from '../mutations'
import { PlayerAvatar } from './player-avatar'
import { OverviewTab } from './detail-overview-tab'
import { InventoryTab } from './detail-inventory-tab'
import { TeleportTab } from './detail-teleport-tab'
import { LogTab } from './detail-log-tab'
import { GiveItemPanel } from './give-item-dialog'
import { ActionForms } from './action-forms'

interface PlayerDetailPanelProps {
  instanceId: string
  /** 单个模式玩家（列表最新数据）；批量模式 null */
  player: Player | null
  /** 批量目标（单个模式为 [player]） */
  batchTargets: Player[]
  isBatchMode: boolean
  isRconConnected: boolean
  mcVersion: string
  onAction: (req: PlayerActionRequest) => Promise<void>
  onOpenBanDialog: (player: Player) => void
  /**
   * inline：lg 及以上内联右栏（自带宽度与左边框）
   * overlay：lg 以下由 Sheet 承载（宽度/边框/遮罩/焦点陷阱归 Sheet，本组件只出内容）
   */
  variant?: 'inline' | 'overlay'
}

/** 批量模式下保留的 Tab（只保留传送/给予路径） */
const BATCH_TABS: PlayerDetailTab[] = ['teleport', 'give', 'actions']

export function PlayerDetailPanel({
  instanceId,
  player,
  batchTargets,
  isBatchMode,
  isRconConnected,
  mcVersion,
  onAction,
  onOpenBanDialog,
  variant = 'inline',
}: PlayerDetailPanelProps) {
  const detail = usePlayersUiStore((s) => s.detail)
  const closeDetail = usePlayersUiStore((s) => s.closeDetail)
  const setDetailTab = usePlayersUiStore((s) => s.setDetailTab)

  // 列表查不到时回退详情端点
  const detailName = isBatchMode ? null : (detail?.playerName ?? null)
  const fallbackDetails = usePlayerDetails(
    instanceId,
    player === null && detailName !== null ? detailName : null,
  )
  const effectivePlayer: Player | null = player ?? fallbackDetails.data ?? null

  // 封禁记录 30s 轮询（面板打开期间）
  const bansQuery = usePlayerBans(instanceId, detail !== null)
  const bans = bansQuery.data ?? []

  const tabs = isBatchMode ? BATCH_TABS : DETAIL_TAB_LABELS.map((t) => t.value)
  const currentTab = detail?.tab ?? 'overview'
  const effectiveTab = tabs.includes(currentTab) ? currentTab : tabs[0]

  return (
    /* @container：本面板 embedded 承载给予物品栅格等子组件，容器宽在两种形态下差 580px
       （内联 w-105=420px / Sheet 全宽约 1000px）。子组件的列数必须按**面板实宽**切档，
       按视口断会给出完全反向的列数（见 give-item-selector 的栅格注释） */
    <aside
      className={cn(
        '@container flex min-h-0 flex-col bg-mcs-bg-default',
        variant === 'inline'
          ? 'w-105 shrink-0 border-l border-mcs-border-default'
          : 'h-full w-full overflow-hidden',
      )}
      aria-label="玩家详情面板"
    >
      {/* ── 头部 ── */}
      <div className="flex items-start gap-2.5 border-b border-mcs-border-muted px-3.5 py-3">
        {isBatchMode ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex shrink-0 -space-x-2">
              {batchTargets.slice(0, 4).map((p) => (
                <PlayerAvatar
                  key={p.uuid}
                  name={p.name}
                  isOnline={p.isOnline}
                  isFakePlayer={p.isFakePlayer}
                  size={26}
                  className="ring-2 ring-mcs-bg-default"
                />
              ))}
              {batchTargets.length > 4 && (
                <span className="inline-flex size-6.5 items-center justify-center rounded-mcs-sm bg-mcs-bg-secondary text-mcs-2xs font-medium text-mcs-text-muted ring-2 ring-mcs-bg-default">
                  +{batchTargets.length - 4}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-mcs-sm font-medium text-mcs-text-default">
                已选择 {batchTargets.length} 名玩家
              </div>
              <div className="max-h-10 truncate text-mcs-xs text-mcs-text-muted">
                {batchTargets.map((p) => p.name).join('、')}
              </div>
            </div>
          </div>
        ) : effectivePlayer ? (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <PlayerAvatar
              name={effectivePlayer.name}
              isOnline={effectivePlayer.isOnline}
              isFakePlayer={effectivePlayer.isFakePlayer}
              size={36}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-mcs-sm font-medium text-mcs-text-default">
                  {effectivePlayer.name}
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 text-mcs-2xs',
                    effectivePlayer.isOnline
                      ? 'bg-mcs-success-bg-subtle text-mcs-success-fg'
                      : 'bg-mcs-bg-secondary text-mcs-text-muted',
                  )}
                >
                  {effectivePlayer.isOnline ? '在线' : '离线'}
                </span>
                {effectivePlayer.isOp && (
                  <span className="shrink-0 rounded-full bg-mcs-purple-bg-subtle px-1.5 text-mcs-2xs text-mcs-purple-fg">
                    OP
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-mcs-2xs text-mcs-text-muted">
                {effectivePlayer.uuid}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center text-mcs-sm text-mcs-text-muted">加载中…</div>
        )}
        <Button variant="ghost" size="icon-sm" onClick={closeDetail} aria-label="关闭详情面板">
          <X aria-hidden />
        </Button>
      </div>

      {/* ── Tab 栏 ── */}
      <Tabs
        value={effectiveTab}
        onValueChange={(v) => setDetailTab(v as PlayerDetailTab)}
        className="border-b border-mcs-border-muted px-2"
      >
        {/* 窄屏 3 列网格（6 档 2 行 / 批量 3 档 1 行），lg 起恢复单行 flex。
            不用横向滚动容器：overflow-x:auto 会把 10px 滚动条算进行高，
            连带裁掉标签底部、激活下划线与焦点环（实测 36px 行高只剩 26px） */}
        <TabsList className="grid h-auto min-h-9 w-full grid-cols-3 gap-0 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-auto lg:flex lg:flex-wrap lg:justify-start">
          {tabs.map((tab) => {
            const label = DETAIL_TAB_LABELS.find((t) => t.value === tab)?.label ?? tab
            return (
              <TabsTrigger
                key={tab}
                value={tab}
                className="h-9 shrink-0 rounded-none border-b-2 border-transparent px-2 text-mcs-xs data-[state=active]:border-mcs-accent-border-strong data-[state=active]:text-mcs-text-default data-[state=active]:shadow-none lg:px-3"
              >
                {label}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </Tabs>

      {/* ── 内容区 ── */}
      <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
        {effectiveTab === 'overview' && effectivePlayer && (
          <OverviewTab
            instanceId={instanceId}
            player={effectivePlayer}
            isRconConnected={isRconConnected}
            bans={bans}
            onAction={onAction}
            onOpenBanDialog={onOpenBanDialog}
          />
        )}
        {effectiveTab === 'inventory' && effectivePlayer && (
          <InventoryTab player={effectivePlayer} />
        )}
        {effectiveTab === 'teleport' && (
          <TeleportTab
            player={isBatchMode ? null : effectivePlayer}
            batchTargets={isBatchMode ? batchTargets : effectivePlayer ? [effectivePlayer] : []}
            isBatchMode={isBatchMode}
            instanceId={instanceId}
            isRconConnected={isRconConnected}
            onAction={onAction}
          />
        )}
        {effectiveTab === 'give' && (
          <GiveItemPanel
            player={isBatchMode ? null : effectivePlayer}
            batchTargets={isBatchMode ? batchTargets : effectivePlayer ? [effectivePlayer] : []}
            isBatchMode={isBatchMode}
            instanceId={instanceId}
            mcVersion={mcVersion}
            isRconConnected={isRconConnected}
            onAction={onAction}
          />
        )}
        {effectiveTab === 'actions' && (
          <ActionForms
            player={isBatchMode ? null : effectivePlayer}
            batchTargets={isBatchMode ? batchTargets : effectivePlayer ? [effectivePlayer] : []}
            isBatchMode={isBatchMode}
            instanceId={instanceId}
            isRconConnected={isRconConnected}
            onAction={onAction}
          />
        )}
        {effectiveTab === 'log' && effectivePlayer && <LogTab player={effectivePlayer} />}
      </div>
    </aside>
  )
}
