/**
 * PlayersPage —— 玩家页（Master-Detail 双栏）
 * - 左：筛选栏 + 表格（排序/分页/虚拟滚动/行内菜单）
 * - 右：详情面板（5 Tab；批量模式仅传送/给予）
 * - 底部浮动批量操作条（选中时出现）
 * - URL 深链接：?q=<搜索词>&mode=<状态>&player=<玩家名>（可分享、可刷新保持）
 * - 数据流：usePlayers 30s 保底轮询 + WS 事件 invalidate（use-server-socket 全局分派）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { getFriendlyErrorText } from '@/api/errors'
import { queryPhase } from '@/lib/query-phase'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/mcs/empty-state'
import { StaleQueryNotice } from '@/components/mcs/data-states'
import { InstanceRequiredState } from '@/features/instances/components/instance-required-state'
import { PageHeader } from '@/components/mcs/page-header'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useServerStore } from '@/stores/server'
import { useInstanceStatus } from '@/api/queries'
import type { Player } from '@/api/types'
import {
  applyPlayersFilter,
  usePlayersUiStore,
  FILTER_MODE_OPTIONS,
  type PlayerDetailTab,
} from './store'
import type { BanFormModel } from '@/lib/mc-ban'
import { usePlayers } from './queries'
import { usePlayerAction, type PlayerActionRequest } from './mutations'
import { FilterBar } from './components/filter-bar'
import { PlayerTable } from './components/player-table'
import { PlayerDetailPanel } from './components/player-detail-panel'
import { BatchBar } from './components/batch-bar'
import { BanDialog } from './components/ban-dialog'
import { BanRecordsDialog } from './components/ban-records-dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useContainerWidth } from '@/hooks/use-container-width'

/** data 未就绪时的稳定空数组（避免 ?? [] 每次渲染新建引用、污染下游 useMemo） */
const NO_PLAYERS: Player[] = []

/**
 * 详情面板内联并列所需的内容宽：面板 w-105（420px，右列无 gap，见 PlayerDetailPanel 的 inline 变体）
 * + 裁列后表格的最小可用宽（480px，见 player-table 的 FULL_COLUMNS_MIN_WIDTH 一档的下一级）。
 * 低于此宽表格会被压到百 px 级，改由 Sheet 全屏承载（role=dialog / 焦点陷阱 / Esc / 背景 inert），
 * 既免去旧 CSS 覆盖层无 dialog 语义的问题，也不挤压表格与筛选栏。
 * 判据取**容器实宽**而非视口：侧栏折叠会使同视口下内容宽差 152px，视口断点会把
 * 「明明并得下」的宽度误判成 Sheet（折叠侧栏 1024 视口内容已有 936px）
 */
const PANEL_INLINE_MIN_CONTENT = 420 + 480

export function PlayersPage() {
  const instanceId = useServerStore((s) => s.instanceId)
  const [searchParams, setSearchParams] = useSearchParams()
  const [banTarget, setBanTarget] = useState<Player | null>(null)
  const [banRecordsOpen, setBanRecordsOpen] = useState(false)
  /** 添加白名单弹窗（页头入口；离线玩家同样生效） */
  const [whitelistOpen, setWhitelistOpen] = useState(false)
  const [whitelistName, setWhitelistName] = useState('')
  /** 白名单提交中（防重复提交） */
  const [whitelistPending, setWhitelistPending] = useState(false)

  const filter = usePlayersUiStore((s) => s.filter)
  const setFilter = usePlayersUiStore((s) => s.setFilter)
  const detail = usePlayersUiStore((s) => s.detail)
  const openPlayerDetail = usePlayersUiStore((s) => s.openPlayerDetail)
  const openBatchDetail = usePlayersUiStore((s) => s.openBatchDetail)
  const resetForInstance = usePlayersUiStore((s) => s.resetForInstance)
  const closeDetail = usePlayersUiStore((s) => s.closeDetail)
  const selectedUuids = usePlayersUiStore((s) => s.selectedUuids)
  // 容器实宽（而非视口）：侧栏折叠 / 面板开合都直接反映在测量值里
  const [areaRef, areaWidth] = useContainerWidth<HTMLDivElement>()
  const isSheetLayout = areaWidth != null && areaWidth < PANEL_INLINE_MIN_CONTENT

  const playersQuery = usePlayers(instanceId)
  const statusQuery = useInstanceStatus(instanceId)
  const action = usePlayerAction(instanceId)

  const allPlayers = playersQuery.data ?? NO_PLAYERS
  const filteredPlayers = useMemo(
    () => applyPlayersFilter(allPlayers, filter),
    [allPlayers, filter],
  )
  const selectedPlayers = useMemo(
    () => allPlayers.filter((p) => selectedUuids.includes(p.uuid)),
    [allPlayers, selectedUuids],
  )

  // 实例切换重置（跳过首次 null→id 初始化转换，避免清掉深链接打开的详情）
  const prevInstanceRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevInstanceRef.current !== null && prevInstanceRef.current !== instanceId) {
      resetForInstance()
    }
    prevInstanceRef.current = instanceId
  }, [instanceId, resetForInstance])

  // ── 深链接：?q=&mode=&player= 初始化（仅首次挂载） ──
  useEffect(() => {
    const q = searchParams.get('q')
    const mode = searchParams.get('mode')
    const playerName = searchParams.get('player')
    const patch: Partial<typeof filter> = {}
    if (q) patch.q = q
    if (mode && FILTER_MODE_OPTIONS.some((o) => o.value === mode)) {
      patch.mode = mode as typeof filter.mode
    }
    if (Object.keys(patch).length > 0) setFilter(patch)
    if (playerName) openPlayerDetail(playerName)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 仅首次挂载初始化深链接——加 searchParams 会与反向同步 effect（state→URL）形成写-读死循环
  }, [])

  // ── 深链接：状态同步回 URL（防抖 300ms） ──
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams()
      if (filter.q) params.set('q', filter.q)
      if (filter.mode !== 'all') params.set('mode', filter.mode)
      if (detail?.playerName) params.set('player', detail.playerName)
      const next = params.toString()
      const current = searchParams.toString()
      if (next !== current) setSearchParams(next ? `?${next}` : '', { replace: true })
    }, 300)
    return () => clearTimeout(timer)
  }, [filter.q, filter.mode, detail?.playerName, searchParams, setSearchParams])

  /** 详情面板单个玩家（列表最新数据） */
  const detailPlayer = useMemo(() => {
    if (!detail || detail.batchMode || !detail.playerName) return null
    return allPlayers.find((p) => p.name === detail.playerName) ?? null
  }, [detail, allPlayers])

  /** 统一操作回调（mutation + 错误 toast） */
  const handleAction = async (req: PlayerActionRequest): Promise<void> => {
    try {
      await action.mutateAsync(req)
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
      throw e
    }
  }

  const handleKicked = () => {
    toast.success('已成功踢出 1 名玩家')
  }

  const handleBanConfirm = async (model: BanFormModel) => {
    if (!banTarget) return
    // 同时踢出（kick 失败不阻断封禁）
    if (model.kickFirst && banTarget.isOnline) {
      try {
        await handleAction({
          kind: 'kick',
          playerName: banTarget.name,
          reason: `封禁：${model.reason}`,
        })
      } catch {
        // 不阻断
      }
    }
    await handleAction({
      kind: 'ban',
      playerName: banTarget.name,
      banBody: {
        reason: model.reason,
        duration: model.duration,
        ip: model.targetType === 'ip' ? banTarget.ip : undefined,
      },
    })
    const durationLabel = model.duration ? ` (${model.duration})` : ''
    toast.success(`已封禁 ${banTarget.name}${durationLabel}`)
  }

  /** 添加白名单：失败时保留弹窗与输入，便于修正后重试 */
  const confirmAddWhitelist = async () => {
    const name = whitelistName.trim()
    if (!name || whitelistPending) return
    setWhitelistPending(true)
    try {
      await handleAction({ kind: 'whitelistAdd', playerName: name })
      toast.success(`已添加 ${name} 至白名单`)
      setWhitelistName('')
      setWhitelistOpen(false)
    } catch {
      // handleAction 已 toast 错误
    } finally {
      setWhitelistPending(false)
    }
  }

  // 无实例门：判据是实例列表本身（详见 InstanceRequiredState）——
  // 此前无实例时 usePlayers 被 disabled，表格会把它显示成「暂无在线玩家」
  if (!instanceId) {
    return <InstanceRequiredState />
  }

  const isRconConnected = statusQuery.data?.isRconConnected ?? false
  const mcVersion = statusQuery.data?.mcVersion ?? ''
  /** 列表相位：有旧值可留时不把一次轮询抖动呈现成整屏故障 */
  const playersPhase = queryPhase(playersQuery)

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader title="玩家" description="查看 · 管理 · 洞察服务器玩家" />

      {/* 左栏：筛选 + 表格（容器实宽决定详情面板内联还是 Sheet，见 PANEL_INLINE_MIN_CONTENT） */}
      <div ref={areaRef} className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <FilterBar
            players={filteredPlayers}
            totalCount={allPlayers.length}
            isRconConnected={isRconConnected}
            onOpenBanRecords={() => setBanRecordsOpen(true)}
            onAddWhitelist={() => setWhitelistOpen(true)}
          />
          {/* 批量操作条内联在表格上方（不悬浮，避免遮挡底部内容） */}
          {selectedPlayers.length > 0 && (
            <BatchBar
              selectedPlayers={selectedPlayers}
              onOpenBatchDetail={(tab) => openBatchDetail(tab)}
              onAction={handleAction}
            />
          )}
          {/* 错误态只在「无旧值可留」时整块替换主体（避免错误被呈现为「暂无在线玩家」的
              误导空态）；已落定过一轮则保留表格 + 非阻断告警，否则 30s 轮询的一次抖动
              会把用户正在看的数据、滚动位与勾选态一起抹掉 */}
          {playersPhase === 'stale' && (
            <StaleQueryNotice
              className="mb-2"
              error={playersQuery.error}
              onRetry={() => void playersQuery.refetch()}
            />
          )}
          {playersPhase === 'failed' ? (
            <EmptyState
              icon={AlertTriangle}
              title="加载失败"
              hint={`无法获取玩家列表：${getFriendlyErrorText(playersQuery.error)}`}
              action={{ label: '重试', onClick: () => void playersQuery.refetch() }}
            />
          ) : (
            <PlayerTable
              players={filteredPlayers}
              isLoading={playersQuery.isLoading}
              totalCount={allPlayers.length}
              onClearFilter={() => setFilter({ q: '', mode: 'all' })}
              isRconConnected={isRconConnected}
              onOpenDetail={(name, tab) =>
                openPlayerDetail(name, tab as PlayerDetailTab | undefined)
              }
              onOpenBan={setBanTarget}
              onAction={handleAction}
              onKicked={handleKicked}
            />
          )}
        </div>

        {/* 右栏：详情面板（容器并得下时内联并列；并不下移入 Sheet，见下） */}
        {detail !== null && !isSheetLayout && (
          <PlayerDetailPanel
            instanceId={instanceId ?? ''}
            player={detailPlayer}
            batchTargets={detail.batchMode ? selectedPlayers : []}
            isBatchMode={detail.batchMode}
            isRconConnected={isRconConnected}
            mcVersion={mcVersion}
            onAction={handleAction}
            onOpenBanDialog={setBanTarget}
          />
        )}
      </div>

      {/* 容器并不下面板时（含平板/窄屏）：详情面板以 Sheet（Radix Dialog）承载，获得 role=dialog / aria-modal / 焦点陷阱 / Esc 关闭 / 背景 inert */}
      {detail !== null && isSheetLayout && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) closeDetail()
          }}
        >
          <SheetContent
            side="right"
            showCloseButton={false}
            className="w-full! gap-0 p-0 sm:max-w-none!"
          >
            <SheetTitle className="sr-only">
              {detail.batchMode
                ? `批量操作 ${selectedPlayers.length} 名玩家`
                : `${detailPlayer?.name ?? '玩家'} 详情`}
            </SheetTitle>
            <PlayerDetailPanel
              variant="overlay"
              instanceId={instanceId ?? ''}
              player={detailPlayer}
              batchTargets={detail.batchMode ? selectedPlayers : []}
              isBatchMode={detail.batchMode}
              isRconConnected={isRconConnected}
              mcVersion={mcVersion}
              onAction={handleAction}
              onOpenBanDialog={setBanTarget}
            />
          </SheetContent>
        </Sheet>
      )}

      {/* 封禁对话框 */}
      {banTarget && (
        <BanDialog
          open={banTarget !== null}
          onOpenChange={(open) => {
            if (!open) setBanTarget(null)
          }}
          player={banTarget}
          onConfirm={async (model) => {
            await handleBanConfirm(model)
          }}
        />
      )}

      {/* 页面级封禁记录弹窗 */}
      <BanRecordsDialog
        instanceId={instanceId ?? ''}
        open={banRecordsOpen}
        onOpenChange={setBanRecordsOpen}
        onAction={handleAction}
      />

      {/* 添加白名单弹窗（页头入口；离线玩家同样生效） */}
      <Dialog
        open={whitelistOpen}
        onOpenChange={(open) => {
          if (!open) {
            setWhitelistOpen(false)
            setWhitelistName('')
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>添加白名单</DialogTitle>
            <DialogDescription>输入玩家名加入白名单（离线玩家同样生效）。</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={whitelistName}
              onChange={(e) => setWhitelistName(e.target.value)}
              placeholder="玩家名"
              aria-label="白名单玩家名"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmAddWhitelist()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWhitelistOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void confirmAddWhitelist()}
              disabled={whitelistName.trim().length === 0 || whitelistPending}
            >
              {whitelistPending ? '添加中…' : '添加'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
