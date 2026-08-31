/**
 * TeleportTab —— 传送 Tab
 *
 * 【实现规格】
 * 1. 当前位置卡片：维度色图标+中文标签+坐标+复制按钮；批量模式多行列表（头像+名+维度+坐标）
 * 2. 快捷传送点 chips（使用 lib/mc-teleport.ts）：
 *    - 世界出生点（固定，可编辑坐标 → buildSetWorldSpawnCommand + 二次确认）
 *    - 个人复活点（固定；批量时各自复活点，未设置回退世界出生点）
 *    - 主世界原点 0,64,0（可删，hideOrigin 持久化）
 *    - 自定义快捷点（可增删：名称+XYZ 弹窗，loadQuickTeleports/saveQuickTeleports）
 * 3. 坐标传送表单：X/Y/Z 初值取玩家当前位置；tp <name> x y z
 * 4. 传送到玩家列表：全部在线玩家（头像+名+坐标+维度+「前往」按钮 → tp <name> <target>）；空态「暂无其他在线玩家」
 * 5. 离线拦截：单个模式离线 → 整 Tab 离线提示卡「玩家已离线，无法执行传送」；批量跳过离线（runBatchForTargets）
 * 6. 执行走 onAction({kind:'command', command})；批量用 runBatchForTargets + formatBatchSummary toast
 * 7. 设计纪律：全部 --mcs-* token；禁硬编码色值/间距/圆角；维度色用 var(--mcs-dimension-*)
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bed,
  CircleDot,
  CloudOff,
  Copy,
  Globe,
  MapPin,
  Navigation,
  Pencil,
  Plus,
  Star,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { getFriendlyErrorText } from '@/api/errors'
import { PlayerAvatar } from './player-avatar'
import { usePlayers } from '../queries'
import {
  buildSetWorldSpawnCommand,
  buildTeleportToCoordsCommand,
  buildTeleportToPlayerCommand,
  DEFAULT_WORLD_SPAWN,
  loadQuickTeleports,
  resolveRespawnTarget,
  saveQuickTeleports,
  type QuickTeleportSchema,
  type TeleportPoint,
} from '@/lib/mc-teleport'
import { formatBatchSummary, runBatchForTargets } from '@/lib/mc-batch'
import type { Player } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'

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

const DIMENSION_LABELS: Record<string, string> = {
  overworld: '主世界',
  nether: '下界',
  end: '末地',
}

/** 维度色 token（--mcs-dimension-*；未注册为 Tailwind 色板，走行内 var） */
const DIMENSION_TOKENS: Record<string, string> = {
  overworld: 'var(--mcs-dimension-overworld)',
  nether: 'var(--mcs-dimension-nether)',
  end: 'var(--mcs-dimension-end)',
}

function dimensionColor(dimension: string | null | undefined): string {
  return (dimension && DIMENSION_TOKENS[dimension]) || 'var(--mcs-text-muted)'
}

function dimensionLabel(dimension: string | null | undefined): string {
  return (dimension && DIMENSION_LABELS[dimension]) || '未知维度'
}

function formatCoords(point: TeleportPoint | null | undefined): string {
  if (!point) return '--'
  return `${Math.round(point.x)}, ${Math.round(point.y)}, ${Math.round(point.z)}`
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
    return (
      <div className="flex flex-col items-center gap-1.5 py-10">
        <CloudOff className="size-8 text-mcs-text-subtle" aria-hidden />
        <p className="text-mcs-sm text-mcs-text-muted">玩家已离线，无法执行传送</p>
        <p className="text-mcs-xs text-mcs-text-subtle">传送操作需要玩家在线</p>
      </div>
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
  const [running, setRunning] = useState(false)
  // 快捷传送点持久化（localStorage；损坏回退默认 schema）
  const [quickSchema, setQuickSchema] = useState<QuickTeleportSchema>(() => loadQuickTeleports(window.localStorage))
  // 世界出生点编辑：两步弹窗（坐标输入 → 二次确认）
  const [worldSpawnDraft, setWorldSpawnDraft] = useState<{ x: string; y: string; z: string } | null>(null)
  const [worldSpawnConfirm, setWorldSpawnConfirm] = useState<TeleportPoint | null>(null)
  // 添加自定义快捷点弹窗（名称 + XYZ）
  const [customDraft, setCustomDraft] = useState<{ name: string; x: string; y: string; z: string } | null>(null)

  // 传送到玩家列表数据源：usePlayers 全量列表 → 过滤在线且排除目标自身
  const playersQuery = usePlayers(instanceId)

  /** 展示基准玩家（单个=目标；批量=首个目标，仅用于世界出生点/表单初值等共享坐标） */
  const displayPlayer = player ?? batchTargets[0] ?? null
  const worldSpawn: TeleportPoint = displayPlayer?.spawnPoint ?? DEFAULT_WORLD_SPAWN
  const initialPos: TeleportPoint = displayPlayer?.position ?? DEFAULT_WORLD_SPAWN

  // 坐标传送表单：初值取玩家当前位置；位置实时刷新且用户未手动修改时同步
  const [coords, setCoords] = useState({
    x: String(Math.round(initialPos.x)),
    y: String(Math.round(initialPos.y)),
    z: String(Math.round(initialPos.z)),
  })
  const coordsTouched = useRef(false)
  // 坐标提取为原始值再进依赖数组：服务器高频推送 position 对象（引用常变、坐标数值不变），
  // 按对象引用依赖会反复 setState；仅坐标数值实际变化时才同步表单
  const posX = displayPlayer?.position?.x
  const posY = displayPlayer?.position?.y
  const posZ = displayPlayer?.position?.z
  useEffect(() => {
    if (posX == null || posY == null || posZ == null || coordsTouched.current) return
    setCoords({
      x: String(Math.round(posX)),
      y: String(Math.round(posY)),
      z: String(Math.round(posZ)),
    })
  }, [posX, posY, posZ])

  const persistQuick = (next: QuickTeleportSchema) => {
    setQuickSchema(next)
    try {
      saveQuickTeleports(window.localStorage, next)
    } catch {
      toast.error('快捷传送点保存失败')
    }
  }

  /**
   * 执行传送动作：
   * - 单个模式：直接 onAction，成功 toast（错误走 getFriendlyErrorMessage）
   * - 批量模式：runBatchForTargets 跳过离线目标 + formatBatchSummary 汇总 toast
   */
  const execute = async (label: string, buildCommand: (name: string) => string, successText?: string) => {
    setRunning(true)
    try {
      if (!isBatchMode && player !== null) {
        await onAction({ kind: 'command', command: buildCommand(player.name) })
        toast.success(successText ?? `${label}完成`)
      } else {
        const result = await runBatchForTargets({
          targets: batchTargets.map((t) => ({ name: t.name, isOnline: t.isOnline })),
          requireOnline: true,
          execute: async (t) => {
            await onAction({ kind: 'command', command: buildCommand(t.name) })
          },
        })
        const summary = formatBatchSummary(label, result)
        if (result.allOffline) toast.warning(summary)
        else toast.success(summary)
      }
    } catch (e) {
      toast.error(`传送失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const copyCoords = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制坐标')
    } catch {
      toast.error('复制失败')
    }
  }

  /** 传送到个人复活点：单个用其复活点（无则回退世界出生点）；批量各目标各自复活点 */
  const handleRespawn = () => {
    void execute(
      '传送到个人复活点',
      (name) => {
        const target = isBatchMode ? batchTargets.find((t) => t.name === name) : player
        return buildTeleportToCoordsCommand(name, resolveRespawnTarget(target?.respawnPoint, target?.spawnPoint))
      },
      '已传送到个人复活点',
    )
  }

  const handleTeleportTo = (target: Player) => {
    void execute('传送', (name) => buildTeleportToPlayerCommand(name, target.name), `已传送至 ${target.name}`)
  }

  /** setworldspawn 是服务器全局命令：无论单/批量只执行一次（无需批量循环） */
  const handleSaveWorldSpawn = async (point: TeleportPoint) => {
    setRunning(true)
    try {
      await onAction({ kind: 'command', command: buildSetWorldSpawnCommand(point) })
      toast.success('世界出生点已修改')
      setWorldSpawnConfirm(null)
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const handleWorldSpawnDraftConfirm = () => {
    if (!worldSpawnDraft) return
    const x = Number.parseFloat(worldSpawnDraft.x)
    const y = Number.parseFloat(worldSpawnDraft.y)
    const z = Number.parseFloat(worldSpawnDraft.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      toast.error('请输入有效的坐标数值')
      return
    }
    setWorldSpawnConfirm({ x, y, z })
    setWorldSpawnDraft(null)
  }

  const handleAddCustom = () => {
    if (!customDraft) return
    const name = customDraft.name.trim()
    if (name.length === 0) {
      toast.error('请输入名称')
      return
    }
    const x = Number.parseFloat(customDraft.x)
    const y = Number.parseFloat(customDraft.y)
    const z = Number.parseFloat(customDraft.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      toast.error('请输入有效的坐标数值')
      return
    }
    persistQuick({ ...quickSchema, items: [...quickSchema.items, { name, x, y, z }] })
    toast.success(`已添加快捷传送点「${name}」`)
    setCustomDraft(null)
  }

  const handleRemoveCustom = (name: string) => {
    persistQuick({ ...quickSchema, items: quickSchema.items.filter((p) => p.name !== name) })
  }

  const handleCoordTeleport = () => {
    const x = Number.parseFloat(coords.x)
    const y = Number.parseFloat(coords.y)
    const z = Number.parseFloat(coords.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      toast.error('请输入有效的坐标数值')
      return
    }
    void execute(
      '传送',
      (name) => buildTeleportToCoordsCommand(name, { x, y, z }),
      `已传送到 (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`,
    )
  }

  /** 传送到玩家列表：在线玩家，排除目标自身（批量时排除全部选中目标） */
  const onlineOthers = useMemo(() => {
    const exclude = new Set(isBatchMode ? batchTargets.map((t) => t.name) : player ? [player.name] : [])
    return (playersQuery.data ?? []).filter((p) => p.isOnline && !exclude.has(p.name))
  }, [playersQuery.data, isBatchMode, batchTargets, player])

  const singlePosText = player?.position ? formatCoords(player.position) : null

  return (
    <div className="flex flex-col gap-4">
      {/* ── 当前位置 ── */}
      <Section title="当前位置">
        {isBatchMode ? (
          <div className="max-h-56 overflow-auto rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default">
            {batchTargets.map((t, i) => (
              <div
                key={`${t.uuid}-${i}`}
                className={cn('flex items-center gap-2 px-3 py-2', i > 0 && 'border-t border-mcs-border-subtle')}
              >
                <PlayerAvatar name={t.name} isOnline={t.isOnline} isFakePlayer={t.isFakePlayer} size={24} />
                <span className="min-w-0 flex-1 truncate text-mcs-sm font-medium text-mcs-text-default">{t.name}</span>
                <MapPin className="size-3 shrink-0" style={{ color: dimensionColor(t.dimension) }} aria-hidden />
                <span className="shrink-0 text-mcs-2xs text-mcs-text-subtle">{dimensionLabel(t.dimension)}</span>
                <span className="shrink-0 font-mono text-mcs-xs text-mcs-text-default">{formatCoords(t.position)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <MapPin className="size-4 shrink-0" style={{ color: dimensionColor(player?.dimension) }} aria-hidden />
              <span className="shrink-0 text-mcs-xs text-mcs-text-subtle">{dimensionLabel(player?.dimension)}</span>
              <span className="truncate font-mono text-mcs-sm font-semibold text-mcs-text-default">
                {singlePosText ?? '--'}
              </span>
            </div>
            <button
              type="button"
              aria-label="复制坐标"
              disabled={singlePosText === null}
              onClick={() => void copyCoords(singlePosText ?? '')}
              className="shrink-0 text-mcs-text-subtle transition-colors hover:text-mcs-text-default disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Copy className="size-3.5" aria-hidden />
            </button>
          </div>
        )}
      </Section>

      {/* ── 快捷传送点（chips：世界出生点/个人复活点固定；主世界原点/自定义可删）── */}
      <Section title="快捷传送点">
        <div className="flex flex-wrap gap-2">
          <QuickChip
            name="世界出生点"
            coords={formatCoords(worldSpawn)}
            icon={<Globe aria-hidden />}
            onClick={() =>
              void execute(
                '传送到世界出生点',
                (name) => buildTeleportToCoordsCommand(name, worldSpawn),
                '已传送到世界出生点',
              )
            }
            disabled={running}
            onEdit={() =>
              setWorldSpawnDraft({
                x: String(Math.round(worldSpawn.x)),
                y: String(Math.round(worldSpawn.y)),
                z: String(Math.round(worldSpawn.z)),
              })
            }
          />
          <QuickChip
            name="个人复活点"
            // 批量时每个玩家分别传送到各自复活点，坐标以 x, y, z 占位避免误导
            coords={isBatchMode ? 'x, y, z' : formatCoords(resolveRespawnTarget(player?.respawnPoint, player?.spawnPoint))}
            icon={<Bed aria-hidden />}
            onClick={handleRespawn}
            disabled={running}
          />
          {!quickSchema.hideOrigin && (
            <QuickChip
              name="主世界原点"
              coords="0, 64, 0"
              icon={<CircleDot aria-hidden />}
              onClick={() =>
                void execute(
                  '传送到主世界原点',
                  (name) => buildTeleportToCoordsCommand(name, DEFAULT_WORLD_SPAWN),
                  '已传送到主世界原点',
                )
              }
              disabled={running}
              onDelete={() => persistQuick({ ...quickSchema, hideOrigin: true })}
            />
          )}
          {quickSchema.items.map((point, i) => (
            <QuickChip
              key={`${point.name}-${i}`}
              name={point.name}
              coords={formatCoords(point)}
              icon={<Star aria-hidden />}
              onClick={() =>
                void execute(
                  `传送到${point.name}`,
                  (name) => buildTeleportToCoordsCommand(name, point),
                  `已传送到 ${point.name}`,
                )
              }
              disabled={running}
              onDelete={() => handleRemoveCustom(point.name)}
            />
          ))}
          <button
            type="button"
            onClick={() => setCustomDraft({ name: '', x: '0', y: '64', z: '0' })}
            className="inline-flex items-center gap-1 rounded-mcs-md border border-mcs-accent-border bg-mcs-accent-bg-subtle px-2.5 py-1.5 text-mcs-xs font-medium text-mcs-accent-fg transition-colors hover:bg-mcs-bg-hover"
          >
            <Plus className="size-3.5" aria-hidden />
            添加快捷传送点
          </button>
        </div>
      </Section>

      {/* ── 坐标传送表单 ── */}
      <Section title="坐标传送">
        <div className="flex items-end gap-2 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default p-3">
          <div className="grid flex-1 grid-cols-3 gap-2">
            <CoordField
              label="X"
              value={coords.x}
              onChange={(v) => {
                coordsTouched.current = true
                setCoords((c) => ({ ...c, x: v }))
              }}
            />
            <CoordField
              label="Y"
              value={coords.y}
              onChange={(v) => {
                coordsTouched.current = true
                setCoords((c) => ({ ...c, y: v }))
              }}
            />
            <CoordField
              label="Z"
              value={coords.z}
              onChange={(v) => {
                coordsTouched.current = true
                setCoords((c) => ({ ...c, z: v }))
              }}
            />
          </div>
          <Button variant="default" size="sm" onClick={handleCoordTeleport} disabled={running}>
            <Navigation className="size-3.5" aria-hidden />
            传送
          </Button>
        </div>
      </Section>

      {/* ── 传送到其他在线玩家 ── */}
      <Section title="传送到玩家">
        <div className="overflow-hidden rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default">
          {playersQuery.isLoading ? (
            <p className="py-6 text-center text-mcs-xs text-mcs-text-subtle">正在加载玩家列表…</p>
          ) : onlineOthers.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-8">
              <Users className="size-6 text-mcs-text-subtle" aria-hidden />
              <p className="text-mcs-xs text-mcs-text-subtle">暂无其他在线玩家</p>
            </div>
          ) : (
            <div className="max-h-64 divide-y divide-mcs-border-subtle overflow-auto">
              {onlineOthers.map((target) => (
                <div key={target.uuid} className="flex items-center gap-2.5 px-3 py-2">
                  <PlayerAvatar name={target.name} isOnline={target.isOnline} isFakePlayer={target.isFakePlayer} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-mcs-sm font-medium text-mcs-text-default">{target.name}</div>
                    <div className="flex items-center gap-1.5 text-mcs-2xs text-mcs-text-subtle">
                      <MapPin
                        className="size-3 shrink-0"
                        style={{ color: dimensionColor(target.dimension) }}
                        aria-hidden
                      />
                      <span className="font-mono">{formatCoords(target.position)}</span>
                      <span>{dimensionLabel(target.dimension)}</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => handleTeleportTo(target)}
                    disabled={running}
                  >
                    <Navigation className="size-3" aria-hidden />
                    前往
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      {/* RCON 不可用时在线操作提示 */}
      {!isRconConnected && (
        <p className="text-mcs-xs text-mcs-text-subtle">提示：RCON 未连接，在线操作可能失败（需启用 RCON）</p>
      )}

      {/* ── 修改世界出生点（第一步：坐标输入）── */}
      <ConfirmDialog
        open={worldSpawnDraft !== null}
        onOpenChange={(open) => {
          if (!open) setWorldSpawnDraft(null)
        }}
        title="修改世界出生点"
        description={`当前世界出生点：(${formatCoords(worldSpawn)})`}
        confirmText="保存"
        loading={running}
        onConfirm={handleWorldSpawnDraftConfirm}
      >
        <div className="grid grid-cols-3 gap-2">
          <CoordField
            label="X"
            value={worldSpawnDraft?.x ?? ''}
            onChange={(v) => setWorldSpawnDraft((d) => (d ? { ...d, x: v } : d))}
          />
          <CoordField
            label="Y"
            value={worldSpawnDraft?.y ?? ''}
            onChange={(v) => setWorldSpawnDraft((d) => (d ? { ...d, y: v } : d))}
          />
          <CoordField
            label="Z"
            value={worldSpawnDraft?.z ?? ''}
            onChange={(v) => setWorldSpawnDraft((d) => (d ? { ...d, z: v } : d))}
          />
        </div>
      </ConfirmDialog>

      {/* ── 修改世界出生点（第二步：二次确认）── */}
      <ConfirmDialog
        open={worldSpawnConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setWorldSpawnConfirm(null)
        }}
        title="确认修改世界出生点"
        description={
          worldSpawnConfirm
            ? `确定要将世界出生点修改为 (${Math.round(worldSpawnConfirm.x)}, ${Math.round(worldSpawnConfirm.y)}, ${Math.round(worldSpawnConfirm.z)}) 吗？`
            : ''
        }
        confirmText="确认修改"
        loading={running}
        onConfirm={() => {
          if (worldSpawnConfirm) void handleSaveWorldSpawn(worldSpawnConfirm)
        }}
      />

      {/* ── 添加快捷传送点 ── */}
      <ConfirmDialog
        open={customDraft !== null}
        onOpenChange={(open) => {
          if (!open) setCustomDraft(null)
        }}
        title="添加快捷传送点"
        description="保存到本地浏览器，可随时一键传送"
        confirmText="添加"
        loading={running}
        onConfirm={handleAddCustom}
      >
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-point-name">名称</Label>
            <input
              id="quick-point-name"
              value={customDraft?.name ?? ''}
              onChange={(e) => setCustomDraft((d) => (d ? { ...d, name: e.target.value } : d))}
              placeholder="如：基地、刷怪塔"
              maxLength={24}
              className="w-full rounded-mcs-xs border border-mcs-border-default bg-mcs-bg-default px-2.5 py-1.5 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-subtle focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <CoordField
              label="X"
              value={customDraft?.x ?? ''}
              onChange={(v) => setCustomDraft((d) => (d ? { ...d, x: v } : d))}
            />
            <CoordField
              label="Y"
              value={customDraft?.y ?? ''}
              onChange={(v) => setCustomDraft((d) => (d ? { ...d, y: v } : d))}
            />
            <CoordField
              label="Z"
              value={customDraft?.z ?? ''}
              onChange={(v) => setCustomDraft((d) => (d ? { ...d, z: v } : d))}
            />
          </div>
        </div>
      </ConfirmDialog>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-mcs-xs font-medium text-mcs-text-subtle">{title}</h4>
      {children}
    </div>
  )
}

interface QuickChipProps {
  name: string
  coords: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  onDelete?: () => void
  onEdit?: () => void
}

/** 快捷传送点 chip：名称行 + 坐标行，可带编辑/删除操作 */
function QuickChip({ name, coords, icon, onClick, disabled, onDelete, onEdit }: QuickChipProps) {
  return (
    <div className="inline-flex items-start gap-1 rounded-mcs-md border border-mcs-border-default bg-mcs-bg-default px-2.5 py-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex min-w-0 flex-col items-start gap-0.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="inline-flex items-center gap-1 text-mcs-xs font-medium text-mcs-text-default">
          <span className="text-mcs-accent" aria-hidden>
            {icon}
          </span>
          {name}
        </span>
        <span className="pl-4 font-mono text-mcs-2xs text-mcs-text-subtle">{coords}</span>
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`编辑${name}`}
          className="mt-0.5 rounded-mcs-xs p-0.5 text-mcs-text-subtle transition-colors hover:text-mcs-text-default"
        >
          <Pencil className="size-3" aria-hidden />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`删除${name}`}
          className="mt-0.5 rounded-mcs-xs p-0.5 text-mcs-text-subtle transition-colors hover:text-mcs-error-fg"
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </div>
  )
}

/** 坐标输入框（实底；表单/弹窗共用） */
function CoordField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-center text-mcs-2xs font-medium text-mcs-text-subtle">{label}</span>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="w-full rounded-mcs-xs border border-mcs-border-default bg-mcs-bg-default px-2 py-1.5 text-center font-mono text-mcs-sm text-mcs-text-default focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
      />
    </div>
  )
}
