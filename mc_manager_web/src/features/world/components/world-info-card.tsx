/**
 * 世界信息卡
 * 只读 9 行信息 + 刷新按钮；isLoading 显示骨架行；world 为 null 显示空态
 * 视觉纪律：实底卡（数据区禁玻璃）+ --mcs-* 语义 token；StatusPill 走状态色三元组
 * （--mcs-*-fg / --mcs-*-border / --mcs-*-bg-subtle），无任何硬编码色值
 */
import type { ReactNode } from 'react'
import { Globe, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { worldSizeParts } from '@/lib/format'
import type { WorldInfo } from '@/api/types'

// ── 展示映射 ──

/** 世界类型中文映射；未知类型原样返回（保留 26.x 新版扩展类型可见性） */
export function formatWorldType(type: string): string {
  const lower = type.toLowerCase()
  if (lower === 'flat') return '平坦'
  if (lower === 'large_biomes' || lower === 'largebiomes') return '放大化'
  if (lower === 'single_biome_surface' || lower === 'single_biome' || lower === 'singlebiome') {
    return '单生物群系'
  }
  if (lower === 'amplified') return '放大化'
  // 'default'/'normal' 旧值归「默认」（旧版服务器兼容）
  if (lower === 'minecraft:normal' || lower === 'normal' || lower === 'default') return '默认'
  return type
}

/** 难度中文 */
export function formatDifficulty(difficulty: string): string {
  switch (difficulty.toLowerCase()) {
    case 'peaceful':
      return '和平'
    case 'easy':
      return '简单'
    case 'hard':
      return '困难'
    default:
      return '普通'
  }
}

/** 游戏模式中文 */
export function formatGameMode(gameMode: string): string {
  switch (gameMode.toLowerCase()) {
    case 'creative':
      return '创造'
    case 'adventure':
      return '冒险'
    case 'spectator':
      return '旁观'
    default:
      return '生存'
  }
}

import { StatusPill } from '@/components/mcs/status-pill'
import { Card, CardBody, CardHeader } from '@/components/mcs/card'
import type { ChipTone } from '@/components/mcs/chip'

/** 难度 → 状态色（peaceful→info / easy→success / hard→error / 其余→warning） */
export function difficultyTone(difficulty: string): ChipTone {
  switch (difficulty.toLowerCase()) {
    case 'peaceful':
      return 'info'
    case 'easy':
      return 'success'
    case 'hard':
      return 'error'
    default:
      return 'warning'
  }
}

/** 游戏模式 → 状态色（survival→success / creative→info / adventure→warning / spectator→purple） */
export function gameModeTone(gameMode: string): ChipTone {
  switch (gameMode.toLowerCase()) {
    case 'creative':
      return 'info'
    case 'adventure':
      return 'warning'
    case 'spectator':
      return 'purple'
    default:
      return 'success'
  }
}

// ── 信息行（标签灰字 + 值默认色）──

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 py-2">
      <dt className="shrink-0 text-mcs-xs text-mcs-text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-mcs-sm font-medium">{children}</dd>
    </div>
  )
}

// ── 世界信息卡 ────────────────────────────────────────────────────

export interface WorldInfoCardProps {
  world: WorldInfo | null
  isLoading: boolean
  onRefresh: () => void
  /** 入场 stagger（页面组合处注入） */
  className?: string
}

/** 存档大小进度（sizeGB/10 clamp，0-100%） */
export function sizeProgress(sizeGB: number): number {
  return Math.min(Math.max(sizeGB / 10, 0), 1)
}

/** 世界信息卡：9 行只读信息（名称/类型/种子/存档大小/游戏天数/难度/游戏模式/视野距离/在线玩家） */
export function WorldInfoCard({ world, isLoading, onRefresh, className }: WorldInfoCardProps) {
  return (
    <Card size="flush" className={cn('mcs-edge-top relative', className)}>
      <CardHeader className="gap-3 border-b border-mcs-border-subtle px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
          <Globe className="size-4 text-mcs-accent-fg" aria-hidden />
        </span>
        <h3 className="text-mcs-lg font-semibold">世界信息</h3>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={isLoading}
            aria-label="刷新"
            title="刷新"
          >
            <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} aria-hidden />
          </Button>
        </div>
      </CardHeader>

      <CardBody className="px-4 py-2">
        {isLoading ? (
          <div data-testid="world-info-skeleton" className="flex flex-col gap-3 py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-4">
                <Skeleton className="h-3.5 w-14" />
                <Skeleton className="h-3.5 w-1/2" />
              </div>
            ))}
          </div>
        ) : !world ? (
          <p className="py-8 text-center text-mcs-xs text-mcs-text-muted">暂无世界信息</p>
        ) : (
          <dl className="flex flex-col">
            <InfoRow label="世界名称">
              <span className="truncate">{world.name}</span>
            </InfoRow>
            <InfoRow label="世界类型">{formatWorldType(world.type)}</InfoRow>
            <InfoRow label="种子">
              <span className="max-w-56 truncate font-mono text-mcs-xs" title={world.seed}>
                {world.seed}
              </span>
            </InfoRow>
            <InfoRow label="存档大小">
              {(() => {
                const size = worldSizeParts(world.sizeGB)
                return (
                  <>
                    <span className="mcs-num text-mcs-sm leading-none">{size.value}</span>
                    <span className="text-mcs-xs text-mcs-text-muted"> {size.unit}</span>
                  </>
                )
              })()}
              <span
                role="progressbar"
                aria-label="存档大小进度"
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={Math.min(Math.max(world.sizeGB, 0), 10)}
                className="h-1.5 w-20 overflow-hidden rounded-mcs-xs bg-mcs-bg-secondary"
              >
                <span
                  aria-hidden
                  className="block h-full rounded-mcs-xs bg-mcs-accent"
                  style={{ width: `${sizeProgress(world.sizeGB) * 100}%` }}
                />
              </span>
            </InfoRow>
            <InfoRow label="游戏天数">
              {world.gameDays != null ? (
                <>
                  <span className="mcs-num text-mcs-sm leading-none">{world.gameDays}</span>
                  <span className="text-mcs-xs text-mcs-text-muted"> 天</span>
                </>
              ) : (
                '不可用'
              )}
            </InfoRow>
            <InfoRow label="难度">
              <StatusPill tone={difficultyTone(world.difficulty)}>
                {formatDifficulty(world.difficulty)}
              </StatusPill>
            </InfoRow>
            <InfoRow label="游戏模式">
              <StatusPill tone={gameModeTone(world.gameMode)}>
                {formatGameMode(world.gameMode)}
              </StatusPill>
            </InfoRow>
            <InfoRow label="视野距离">
              <span className="mcs-num text-mcs-sm leading-none">{world.viewDistance}</span>
            </InfoRow>
            <InfoRow label="在线玩家">
              <span className="mcs-num text-mcs-sm leading-none">
                {world.onlinePlayers}/{world.maxPlayers}
              </span>
            </InfoRow>
          </dl>
        )}
      </CardBody>
    </Card>
  )
}
