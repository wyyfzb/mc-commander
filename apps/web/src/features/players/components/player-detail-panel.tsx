/**
 * PlayerDetailPanel —— 玩家详情（弹窗内容壳）
 * - 单个模式：头像+名字+状态+OP 徽章 + ‹ › 换人 + 6 Tab
 * - 批量模式：堆叠头像+「已选择 N 名玩家」+目标名单，仅保留 传送/给予物品/操作
 * - 承载由调用方负责（ui/dialog 提供 role=dialog / 焦点陷阱 / Esc / 背景 inert）；
 *   本组件只出内容，不决定宽度与边框。
 * - 打开期间封禁记录 30s 轮询
 */
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ErrorStateVisual } from '@/components/mcs/data-states'
import { InfoHint } from '@/components/mcs/info-hint'
import { cn } from '@/lib/utils'
import { queryPhase } from '@/lib/query-phase'
import type { Player } from '@/api/types'
import { DETAIL_TAB_LABELS, usePlayersUiStore, type PlayerDetailTab } from '../store'
import { usePlayerBans, usePlayerDetails } from '../queries'
import type { PlayerActionRequest } from '../mutations'
import { PlayerAvatar } from './player-avatar'
import { OverviewTab } from './detail-overview-tab'
import { InventoryTab } from './detail-inventory-tab'
import { TeleportTab } from './detail-teleport-tab'
import { LogTab } from './detail-log-tab'
import { GiveItemPanel } from './give-item-panel'
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
  /** 关闭详情（草稿复位等收口由调用方的关闭入口统一承担） */
  onClose: () => void
  /** ‹ › 换人（按表格上报的真实行序；null = 该方向没有下一位） */
  onPrevPlayer?: (() => void) | null
  onNextPlayer?: (() => void) | null
  prevPlayerName?: string
  nextPlayerName?: string
}

/** 批量模式下保留的 Tab（只保留可批量执行的路径） */
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
  onClose,
  onPrevPlayer = null,
  onNextPlayer = null,
  prevPlayerName,
  nextPlayerName,
}: PlayerDetailPanelProps) {
  const detail = usePlayersUiStore((s) => s.detail)
  const setDetailTab = usePlayersUiStore((s) => s.setDetailTab)

  // 列表查不到时回退详情端点
  const detailName = isBatchMode ? null : (detail?.playerName ?? null)
  const fallbackDetails = usePlayerDetails(
    instanceId,
    player === null && detailName !== null ? detailName : null,
  )
  const effectivePlayer: Player | null = player ?? fallbackDetails.data ?? null

  /* 回退端点失败时不能与「还在转」共用一态：两者都是 effectivePlayer 为 null，
     但前者应给错误态 + 重试，后者才是骨架。取 failed 相（已失败且无数据可留——
     本处无旧值可留，stale 相即退化为「显示上一次的详情」，由 data 分支自然承担）。 */
  const fallbackPhase = queryPhase(fallbackDetails)

  // 封禁记录 30s 轮询（面板打开期间）
  const bansQuery = usePlayerBans(instanceId, detail !== null)
  const bans = bansQuery.data ?? []

  /* OP 徽章的可见文本只回答「是什么」，解释（含 ops.json 依据）进浮层：
     裸 title 对触屏与键盘都取不到，解释必须挂在能聚焦的触发器上 */
  const opBadgeText = effectivePlayer?.bypassesPlayerLimit ? 'OP · 满员免排队' : 'OP'
  const opHintText = effectivePlayer?.bypassesPlayerLimit
    ? '该管理员在服务器满员时仍可进入（ops.json 的 bypassesPlayerLimit）'
    : '管理员：可在游戏内执行 OP 级命令'

  const tabs = isBatchMode ? BATCH_TABS : DETAIL_TAB_LABELS.map((t) => t.value)
  const currentTab = detail?.tab ?? 'overview'
  const effectiveTab = tabs.includes(currentTab) ? currentTab : tabs[0]

  return (
    /* @container：给予工作台按**面板实宽**切双栏/抽屉（弹窗 960 双栏，窄屏单栏） */
    <div
      className="@container flex h-full min-h-0 flex-col bg-mcs-bg-default"
      data-testid="player-detail-shell"
    >
      {/* ── 头部 ── */}
      <div className="flex shrink-0 items-start gap-2.5 border-b border-mcs-border-muted px-3.5 py-3">
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
                  /* 外层承担 shrink-0：触发器是 button，行内收缩必须仍由这枚徽章挡住 */
                  <span className="inline-flex shrink-0">
                    <InfoHint
                      variant="inline"
                      label={`${opBadgeText} 说明`}
                      term={
                        <span className="rounded-full bg-mcs-purple-bg-subtle px-1.5 text-mcs-2xs text-mcs-purple-fg">
                          {opBadgeText}
                        </span>
                      }
                    >
                      {opHintText}
                    </InfoHint>
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-mcs-2xs text-mcs-text-muted">
                {effectivePlayer.uuid}
              </div>
            </div>
          </div>
        ) : fallbackPhase === 'failed' ? (
          /* 请求失败：头部给错误态 + 重试。与「加载中…」共用一态会让
             端点持续故障时用户看到永久骨架——把失败呈现成「还在转」 */
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-mcs-sm text-mcs-error-fg">详情加载失败</span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={fallbackDetails.isFetching}
              onClick={() => void fallbackDetails.refetch()}
            >
              <RefreshCw
                className={cn('size-3.5', fallbackDetails.isFetching && 'animate-spin')}
                aria-hidden
              />
              重试
            </Button>
          </div>
        ) : (
          <div className="flex flex-1 items-center text-mcs-sm text-mcs-text-muted">加载中…</div>
        )}

        {/* 换人：弹窗模态后不能再点表格行，‹ › 是等价的 1 次点击 */}
        {!isBatchMode && (onPrevPlayer !== null || onNextPlayer !== null) && (
          <span className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={onPrevPlayer === null}
              onClick={onPrevPlayer ?? undefined}
              aria-label="上一个玩家"
              title={prevPlayerName ? `上一个玩家（${prevPlayerName}）` : '已经是第一个'}
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={onNextPlayer === null}
              onClick={onNextPlayer ?? undefined}
              aria-label="下一个玩家"
              title={nextPlayerName ? `下一个玩家（${nextPlayerName}）` : '已经是最后一个'}
            >
              <ChevronRight aria-hidden />
            </Button>
          </span>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭详情面板">
          <X aria-hidden />
        </Button>
      </div>

      {/* ── Tab 栏 ── */}
      <Tabs
        value={effectiveTab}
        onValueChange={(v) => setDetailTab(v as PlayerDetailTab)}
        className="shrink-0 border-b border-mcs-border-muted px-2"
      >
        {/* 窄容器 3 列网格（6 档 2 行 / 批量 3 档 1 行），宽容器恢复单行 flex。
            用容器查询而非视口断点：弹窗宽度随视口在 736~960 之间变，视口断点会在
            900px 这类「弹窗已够宽」的视口上仍把 Tab 折成两行。
            阈值 420：实测容器 421 时 6 档单行（每档约 68px），416 时已折行。
            不用横向滚动容器：overflow-x:auto 会把 10px 滚动条算进行高，
            连带裁掉标签底部、激活下划线与焦点环（实测 36px 行高只剩 26px） */}
        <TabsList className="grid h-auto min-h-9 w-full grid-cols-3 gap-0 rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-auto @[420px]:flex @[420px]:flex-wrap @[420px]:justify-start">
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

      {/* ── 内容区 ──
          只有一层滚动：普通 Tab 在自己的滚动容器里；给予工作台自己管两栏滚动（不外滚） */}
      {fallbackPhase === 'failed' && !isBatchMode ? (
        <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-3.5 py-10">
          <ErrorStateVisual
            error={fallbackDetails.error}
            retry={
              <Button
                variant="outline"
                size="sm"
                disabled={fallbackDetails.isFetching}
                onClick={() => void fallbackDetails.refetch()}
              >
                <RefreshCw
                  className={cn('size-3.5', fallbackDetails.isFetching && 'animate-spin')}
                  aria-hidden
                />
                重试
              </Button>
            }
          />
        </div>
      ) : effectiveTab === 'give' ? (
        /* 工作台自带内外距（目录 px-3、清单各自排布）：这里不再加内距，
           否则 960 弹窗里目录列被削到 556px，只排得下 5 列（每格 ≥88px 需 558px） */
        <div className="flex min-h-0 flex-1 flex-col">
          <GiveItemPanel
            player={isBatchMode ? null : effectivePlayer}
            batchTargets={isBatchMode ? batchTargets : effectivePlayer ? [effectivePlayer] : []}
            isBatchMode={isBatchMode}
            mcVersion={mcVersion}
            isRconConnected={isRconConnected}
            onAction={onAction}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          {effectiveTab === 'overview' && effectivePlayer && (
            <OverviewTab
              instanceId={instanceId}
              player={effectivePlayer}
              isRconConnected={isRconConnected}
              bans={bans}
              bansPhase={queryPhase(bansQuery)}
              bansError={bansQuery.error}
              onRetryBans={() => void bansQuery.refetch()}
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
      )}
    </div>
  )
}
