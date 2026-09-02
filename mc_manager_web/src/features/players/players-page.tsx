/**
 * PlayersPage —— 玩家页（Master-Detail 双栏）
 * - 左：筛选栏 + 表格（排序/分页/虚拟滚动/行内菜单）
 * - 右：详情面板（5 Tab；批量模式仅传送/给予）
 * - 底部浮动批量操作条（选中时出现）
 * - URL 深链接：?q=<搜索词>&mode=<状态>&player=<玩家名>（可分享、可刷新保持）
 * - 数据流：usePlayers 5s 轮询 + WS 事件 invalidate（use-server-socket 全局分派）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { getFriendlyErrorText } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/mcs/empty-state'
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
import { applyPlayersFilter, usePlayersUiStore, FILTER_MODE_OPTIONS, type PlayerDetailTab } from './store'
import type { BanFormModel } from '@/lib/mc-ban'
import { usePlayers } from './queries'
import { usePlayerAction, type PlayerActionRequest } from './mutations'
import { FilterBar } from './components/filter-bar'
import { PlayerTable } from './components/player-table'
import { PlayerDetailPanel } from './components/player-detail-panel'
import { BatchBar } from './components/batch-bar'
import { BanDialog } from './components/ban-dialog'
import { BanRecordsDialog } from './components/ban-records-dialog'

/** data 未就绪时的稳定空数组（避免 ?? [] 每次渲染新建引用、污染下游 useMemo） */
const NO_PLAYERS: Player[] = []

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
  const selectedUuids = usePlayersUiStore((s) => s.selectedUuids)

  const playersQuery = usePlayers(instanceId)
  const statusQuery = useInstanceStatus(instanceId)
  const action = usePlayerAction(instanceId)

  const allPlayers = playersQuery.data ?? NO_PLAYERS
  const filteredPlayers = useMemo(() => applyPlayersFilter(allPlayers, filter), [allPlayers, filter])
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
        await handleAction({ kind: 'kick', playerName: banTarget.name, reason: `封禁：${model.reason}` })
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

  const isRconConnected = statusQuery.data?.isRconConnected ?? false
  const mcVersion = statusQuery.data?.mcVersion ?? ''

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="玩家"
        description="查看 · 管理 · 洞察服务器玩家"
      />

      {/* 左栏：筛选 + 表格 */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <FilterBar
            players={filteredPlayers}
            totalCount={allPlayers.length}
            isRconConnected={isRconConnected}
            onOpenBanRecords={() => setBanRecordsOpen(true)}
            onAddWhitelist={() => setWhitelistOpen(true)}
          />
          {/* 列表错误态（避免错误被呈现为「暂无在线玩家」的误导空态） */}
          {playersQuery.isError && !playersQuery.isLoading ? (
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
              onOpenDetail={(name, tab) => openPlayerDetail(name, tab as PlayerDetailTab | undefined)}
              onOpenBan={setBanTarget}
              onAction={handleAction}
              onKicked={handleKicked}
            />
          )}
        </div>

        {/* 右栏：详情面板 */}
        {detail !== null && (
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

      {/* 底部浮动批量操作条 */}
      {selectedPlayers.length > 0 && (
        <BatchBar
          selectedPlayers={selectedPlayers}
          onOpenBatchDetail={(tab) => openBatchDetail(tab)}
          onAction={handleAction}
        />
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
