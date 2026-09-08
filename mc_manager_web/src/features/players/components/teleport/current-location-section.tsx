/**
 * 当前位置分区：批量模式多行列表（头像+名+维度+坐标，含离线目标——执行时由批量链路跳过）；
 * 单个模式卡片（维度+坐标+复制按钮）。
 */
import { Copy, MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Player } from '@/api/types'
import { PlayerAvatar } from '../player-avatar'
import { Section } from './section'
import { dimensionColor, dimensionLabel, formatCoords } from './teleport-utils'

export interface CurrentLocationSectionProps {
  isBatchMode: boolean
  batchTargets: Player[]
  player: Player | null
  onCopyCoords: (text: string) => void
}

export function CurrentLocationSection({ isBatchMode, batchTargets, player, onCopyCoords }: CurrentLocationSectionProps) {
  const singlePosText = player?.position ? formatCoords(player.position) : null

  return (
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
            onClick={() => onCopyCoords(singlePosText ?? '')}
            className="shrink-0 text-mcs-text-subtle transition-colors hover:text-mcs-text-default disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Copy className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
    </Section>
  )
}
