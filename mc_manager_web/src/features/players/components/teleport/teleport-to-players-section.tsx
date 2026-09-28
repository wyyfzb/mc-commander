/**
 * 传送到玩家分区：在线玩家列表（排除目标自身，由上层过滤）；加载中 / 错误（可重试）/
 * 空态三态。「前往」执行 tp <name> <target>。
 */
import { CircleAlert, MapPin, Navigation, Users } from 'lucide-react'
import type { usePlayers } from '../../queries'
import { Button } from '@/components/ui/button'
import { getFriendlyErrorText } from '@/api/errors'
import type { Player } from '@/api/types'
import { PlayerAvatar } from '../player-avatar'
import { Section } from './section'
import { dimensionColor, dimensionLabel, formatCoords } from './teleport-utils'

type PlayersQuery = ReturnType<typeof usePlayers>

export interface TeleportToPlayersSectionProps {
  playersQuery: PlayersQuery
  onlineOthers: Player[]
  running: boolean
  onTeleportTo: (target: Player) => void
}

export function TeleportToPlayersSection({
  playersQuery,
  onlineOthers,
  running,
  onTeleportTo,
}: TeleportToPlayersSectionProps) {
  return (
    <Section title="传送到玩家">
      <div className="overflow-hidden rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default">
        {playersQuery.isLoading ? (
          <p className="py-6 text-center text-mcs-xs text-mcs-text-muted">正在加载玩家列表…</p>
        ) : playersQuery.isError ? (
          <div className="flex flex-col items-center gap-1.5 py-8">
            <CircleAlert className="size-6 text-mcs-text-muted" aria-hidden />
            <p className="text-mcs-xs text-mcs-error-fg">
              玩家列表加载失败：{getFriendlyErrorText(playersQuery.error)}
            </p>
            <Button variant="outline" size="xs" onClick={() => void playersQuery.refetch()}>
              重试
            </Button>
          </div>
        ) : onlineOthers.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-8">
            <Users className="size-6 text-mcs-text-muted" aria-hidden />
            <p className="text-mcs-xs text-mcs-text-muted">暂无其他在线玩家</p>
          </div>
        ) : (
          <div className="max-h-64 divide-y divide-mcs-border-subtle overflow-auto">
            {onlineOthers.map((target) => (
              <div key={target.uuid} className="flex items-center gap-2.5 px-3 py-2">
                <PlayerAvatar
                  name={target.name}
                  isOnline={target.isOnline}
                  isFakePlayer={target.isFakePlayer}
                  size={28}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-mcs-sm font-medium text-mcs-text-default">
                    {target.name}
                  </div>
                  <div className="flex items-center gap-1.5 text-mcs-2xs text-mcs-text-muted">
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
                  onClick={() => onTeleportTo(target)}
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
  )
}
