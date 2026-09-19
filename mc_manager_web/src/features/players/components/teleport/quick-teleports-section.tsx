/**
 * 快捷传送点 chips 区：世界出生点（固定，可编辑坐标）/ 个人复活点（固定；批量各自复活点）/
 * 主世界原点（可删，hideOrigin 持久化）/ 自定义点（可增删）。执行统一走 onTeleport 回调。
 */
import { Bed, CircleDot, Globe, Plus, Star } from 'lucide-react'
import {
  buildTeleportToCoordsCommand,
  DEFAULT_WORLD_SPAWN,
  resolveRespawnTarget,
  type QuickTeleportSchema,
  type TeleportPoint,
} from '@/lib/mc-teleport'
import type { Player } from '@/api/types'
import { cn } from '@/lib/utils'
import { TONE_SELECTED_CLASSES } from '@/components/mcs/tone'
import { QuickChip } from './quick-chip'
import { Section } from './section'
import { formatCoords } from './teleport-utils'
import type { WorldSpawnDraft } from './world-spawn-dialogs'

export interface QuickTeleportsSectionProps {
  worldSpawn: TeleportPoint
  player: Player | null
  isBatchMode: boolean
  quickSchema: QuickTeleportSchema
  running: boolean
  onTeleport: (
    label: string,
    buildCommand: (name: string) => string,
    successText?: string,
  ) => Promise<void>
  onRespawn: () => void
  onEditWorldSpawn: (draft: WorldSpawnDraft) => void
  onHideOrigin: () => void
  onRemoveCustom: (name: string) => void
  onAddClick: () => void
}

export function QuickTeleportsSection({
  worldSpawn,
  player,
  isBatchMode,
  quickSchema,
  running,
  onTeleport,
  onRespawn,
  onEditWorldSpawn,
  onHideOrigin,
  onRemoveCustom,
  onAddClick,
}: QuickTeleportsSectionProps) {
  return (
    <Section title="快捷传送点">
      <div className="flex flex-wrap gap-2">
        <QuickChip
          name="世界出生点"
          coords={formatCoords(worldSpawn)}
          icon={<Globe aria-hidden />}
          onClick={() =>
            void onTeleport(
              '传送到世界出生点',
              (name) => buildTeleportToCoordsCommand(name, worldSpawn),
              '已传送到世界出生点',
            )
          }
          disabled={running}
          onEdit={() =>
            onEditWorldSpawn({
              x: String(Math.round(worldSpawn.x)),
              y: String(Math.round(worldSpawn.y)),
              z: String(Math.round(worldSpawn.z)),
            })
          }
        />
        <QuickChip
          name="个人复活点"
          // 批量时每个玩家分别传送到各自复活点，坐标以 x, y, z 占位避免误导
          coords={
            isBatchMode
              ? 'x, y, z'
              : formatCoords(resolveRespawnTarget(player?.respawnPoint, player?.spawnPoint))
          }
          icon={<Bed aria-hidden />}
          onClick={onRespawn}
          disabled={running}
        />
        {!quickSchema.hideOrigin && (
          <QuickChip
            name="主世界原点"
            coords="0, 64, 0"
            icon={<CircleDot aria-hidden />}
            onClick={() =>
              void onTeleport(
                '传送到主世界原点',
                (name) => buildTeleportToCoordsCommand(name, DEFAULT_WORLD_SPAWN),
                '已传送到主世界原点',
              )
            }
            disabled={running}
            onDelete={onHideOrigin}
          />
        )}
        {quickSchema.items.map((point, i) => (
          <QuickChip
            key={`${point.name}-${i}`}
            name={point.name}
            coords={formatCoords(point)}
            icon={<Star aria-hidden />}
            onClick={() =>
              void onTeleport(
                `传送到${point.name}`,
                (name) => buildTeleportToCoordsCommand(name, point),
                `已传送到 ${point.name}`,
              )
            }
            disabled={running}
            onDelete={() => onRemoveCustom(point.name)}
          />
        ))}
        <button
          type="button"
          onClick={onAddClick}
          className={cn(
            TONE_SELECTED_CLASSES,
            'inline-flex items-center gap-1 rounded-mcs-md border px-2.5 py-1.5 text-mcs-xs font-medium transition-colors hover:bg-mcs-state-hover',
          )}
        >
          <Plus className="size-3.5" aria-hidden />
          添加快捷传送点
        </button>
      </div>
    </Section>
  )
}
