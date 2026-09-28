/**
 * TeleportTab —— 传送 Tab（主文件：离线拦截 + 分区编排）
 *
 * 【实现规格】
 * 1. 当前位置卡片：维度色图标+中文标签+坐标+复制按钮；批量模式多行列表（头像+名+维度+坐标）
 * 2. 快捷传送点 chips（使用 lib/mc-teleport.ts）：世界出生点（可编辑坐标 → 二次确认）、
 *    个人复活点（批量时各自复活点，未设置回退世界出生点）、主世界原点（可删 hideOrigin）、
 *    自定义快捷点（可增删，loadQuickTeleports/saveQuickTeleports）
 * 3. 坐标传送表单：X/Y/Z 初值取玩家当前位置；tp <name> x y z
 * 4. 传送到玩家列表：全部在线玩家（排除目标）→ tp <name> <target>
 * 5. 离线拦截：单个模式离线 → 整 Tab 离线提示卡；批量跳过离线（runBatchForTargets）
 * 6. 执行走 onAction({kind:'command', command})；批量用 runBatchForTargets + formatBatchSummary toast
 * 7. 设计纪律：全部 --mcs-* token；维度色用 var(--mcs-dimension-*)
 *
 * 拆分模块：teleport/ 子组件与弹窗；use-teleport-execute / use-quick-teleports / use-coords-form hooks
 */
import { useMemo, useState } from 'react'
import { CloudOff } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/mcs/empty-state'
import {
  buildTeleportToCoordsCommand,
  buildTeleportToPlayerCommand,
  DEFAULT_WORLD_SPAWN,
  resolveRespawnTarget,
  type TeleportPoint,
} from '@/lib/mc-teleport'
import type { Player } from '@/api/types'
import { usePlayers } from '../queries'
import type { PlayerActionRequest } from '../mutations'
import { useTeleportExecute } from '../use-teleport-execute'
import { useQuickTeleports } from '../use-quick-teleports'
import { useCoordsForm } from '../use-coords-form'
import { CurrentLocationSection } from './teleport/current-location-section'
import { QuickTeleportsSection } from './teleport/quick-teleports-section'
import { CoordTeleportForm } from './teleport/coord-teleport-form'
import { TeleportToPlayersSection } from './teleport/teleport-to-players-section'
import { WorldSpawnDialogs, type WorldSpawnDraft } from './teleport/world-spawn-dialogs'
import { CustomPointDialog } from './teleport/custom-point-dialog'
import type { CustomPointDraft } from '../use-quick-teleports'

export interface TeleportTabProps {
  /** 单个模式目标玩家；批量模式为 null */
  player: Player | null
  /** 批量目标（单个模式为 [player]） */
  batchTargets: Player[]
  isBatchMode: boolean
  instanceId: string
  isRconConnected: boolean
  onAction: (req: PlayerActionRequest) => Promise<void>
}

/**
 * 单个模式离线拦截：整 Tab 离线提示卡。
 * MC 原版 tp 不支持离线玩家；批量模式下仅跳过离线目标，Tab 仍可用。
 */
export function TeleportTab({
  player,
  batchTargets,
  isBatchMode,
  instanceId,
  isRconConnected,
  onAction,
}: TeleportTabProps) {
  if (!isBatchMode && player !== null && !player.isOnline) {
    // 与给予物品离线空态统一走 EmptyState（图标/文案/间距同构，高度随容器）
    return (
      <EmptyState
        icon={CloudOff}
        title="玩家已离线，无法执行传送"
        hint="传送操作需要玩家在线"
        className="min-h-64"
      />
    )
  }
  return (
    <TeleportTabContent
      player={player}
      batchTargets={batchTargets}
      isBatchMode={isBatchMode}
      instanceId={instanceId}
      isRconConnected={isRconConnected}
      onAction={onAction}
    />
  )
}

function TeleportTabContent({
  player,
  batchTargets,
  isBatchMode,
  instanceId,
  isRconConnected,
  onAction,
}: TeleportTabProps) {
  const playersQuery = usePlayers(instanceId)
  const { running, execute, saveWorldSpawn, copyCoords } = useTeleportExecute({
    player,
    batchTargets,
    isBatchMode,
    onAction,
  })
  const { quickSchema, addCustom, removeCustom, hideOrigin } = useQuickTeleports()
  const [worldSpawnDraft, setWorldSpawnDraft] = useState<WorldSpawnDraft | null>(null)
  const [worldSpawnConfirm, setWorldSpawnConfirm] = useState<TeleportPoint | null>(null)
  const [customDraft, setCustomDraft] = useState<CustomPointDraft | null>(null)

  /** 展示基准玩家（单个=目标；批量=首个目标，仅用于世界出生点/表单初值等共享坐标） */
  const displayPlayer = player ?? batchTargets[0] ?? null
  const worldSpawn: TeleportPoint = displayPlayer?.spawnPoint ?? DEFAULT_WORLD_SPAWN
  const { coords, setCoord, parseCoords } = useCoordsForm(displayPlayer)

  /** 传送到个人复活点：单个用其复活点（无则回退世界出生点）；批量各目标各自复活点 */
  const handleRespawn = () => {
    void execute(
      '传送到个人复活点',
      (name) => {
        const target = isBatchMode ? batchTargets.find((t) => t.name === name) : player
        return buildTeleportToCoordsCommand(
          name,
          resolveRespawnTarget(target?.respawnPoint, target?.spawnPoint),
        )
      },
      '已传送到个人复活点',
    )
  }

  const handleTeleportTo = (target: Player) => {
    void execute(
      '传送',
      (name) => buildTeleportToPlayerCommand(name, target.name),
      `已传送至 ${target.name}`,
    )
  }

  const handleCoordTeleport = () => {
    const point = parseCoords()
    if (!point) {
      toast.error('请输入有效的坐标数值')
      return
    }
    void execute(
      '传送',
      (name) => buildTeleportToCoordsCommand(name, point),
      `已传送到 (${Math.round(point.x)}, ${Math.round(point.y)}, ${Math.round(point.z)})`,
    )
  }

  /** 传送到玩家列表：在线玩家，排除目标自身（批量时排除全部选中目标） */
  const onlineOthers = useMemo(() => {
    const exclude = new Set(
      isBatchMode ? batchTargets.map((t) => t.name) : player ? [player.name] : [],
    )
    return (playersQuery.data ?? []).filter((p) => p.isOnline && !exclude.has(p.name))
  }, [playersQuery.data, isBatchMode, batchTargets, player])

  /** setworldspawn 成功后关闭二次确认弹窗（失败保持打开便于重试） */
  const handleSaveWorldSpawn = (point: TeleportPoint) => {
    void saveWorldSpawn(point, () => setWorldSpawnConfirm(null))
  }

  return (
    <div className="flex flex-col gap-4">
      <CurrentLocationSection
        isBatchMode={isBatchMode}
        batchTargets={batchTargets}
        player={player}
        onCopyCoords={(text) => void copyCoords(text)}
      />

      <QuickTeleportsSection
        worldSpawn={worldSpawn}
        player={player}
        isBatchMode={isBatchMode}
        quickSchema={quickSchema}
        running={running}
        onTeleport={execute}
        onRespawn={handleRespawn}
        onEditWorldSpawn={setWorldSpawnDraft}
        onHideOrigin={hideOrigin}
        onRemoveCustom={removeCustom}
        onAddClick={() => setCustomDraft({ name: '', x: '0', y: '64', z: '0' })}
      />

      <CoordTeleportForm
        coords={coords}
        onCoordChange={setCoord}
        onTeleport={handleCoordTeleport}
        running={running}
      />

      <TeleportToPlayersSection
        playersQuery={playersQuery}
        onlineOthers={onlineOthers}
        running={running}
        onTeleportTo={handleTeleportTo}
      />

      {/* RCON 不可用时在线操作提示 */}
      {!isRconConnected && (
        <p className="text-mcs-xs text-mcs-text-muted">
          提示：RCON 未连接，在线操作可能失败（需启用 RCON）
        </p>
      )}

      <WorldSpawnDialogs
        worldSpawn={worldSpawn}
        draft={worldSpawnDraft}
        onDraftChange={setWorldSpawnDraft}
        confirm={worldSpawnConfirm}
        onConfirmChange={setWorldSpawnConfirm}
        onSave={handleSaveWorldSpawn}
        running={running}
      />

      <CustomPointDialog
        draft={customDraft}
        onDraftChange={setCustomDraft}
        onAdd={addCustom}
        running={running}
      />
    </div>
  )
}
