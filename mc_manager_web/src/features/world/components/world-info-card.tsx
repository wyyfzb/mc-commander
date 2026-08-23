/**
 * 世界信息卡
 * 只读 9 行信息 + 刷新按钮；isLoading 显示骨架行；world 为 null 显示空态
 * 视觉纪律：实底卡（数据区禁玻璃）+ --mcs-* 语义 token；PillBadge 走状态色三元组
 * （--mcs-*-fg / --mcs-*-border / --mcs-*-bg-subtle），无任何硬编码色值
 */
import type { ReactNode } from 'react'
import { Globe, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
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

// ── PillBadge（难度/游戏模式小徽章；颜色走 --mcs-*-border/bg-subtle/fg 三元组 token）──

export type PillTone = 'info' | 'success' | 'warning' | 'error' | 'purple'

const PILL_TONE_CLASS: Record<PillTone, string> = {
  info: 'border-mcs-info-border bg-mcs-info-bg-subtle text-mcs-info-fg',
  success: 'border-mcs-success-border bg-mcs-success-bg-subtle text-mcs-success-fg',
  warning: 'border-mcs-warning-border bg-mcs-warning-bg-subtle text-mcs-warning-fg',
  error: 'border-mcs-error-border bg-mcs-error-bg-subtle text-mcs-error-fg',
  purple: 'border-mcs-purple-border bg-mcs-purple-bg-subtle text-mcs-purple-fg',
}

/** 难度 → 状态色（peaceful→info / easy→success / hard→error / 其余→warning） */
export function difficultyTone(difficulty: string): PillTone {
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
export function gameModeTone(gameMode: string): PillTone {
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

/** 状态色 PillBadge（本地小型徽章；同 shadcn Badge 的 pill 视觉语言） */
export function PillBadge({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      data-pill-tone={tone}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-mcs-xl border px-2 text-xs font-medium whitespace-nowrap',
        PILL_TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  )
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
}

/** 存档大小进度（sizeGB/10 clamp，0-100%） */
export function sizeProgress(sizeGB: number): number {
  return Math.min(Math.max(sizeGB / 10, 0), 1)
}

/** 世界信息卡：9 行只读信息（名称/类型/种子/存档大小/游戏天数/难度/游戏模式/视野距离/在线玩家） */
export function WorldInfoCard({ world, isLoading, onRefresh }: WorldInfoCardProps) {
  return (
    <section className="rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
      <header className="flex items-center gap-3 border-b border-mcs-border-subtle px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
          <Globe className="size-4 text-mcs-accent" aria-hidden />
        </span>
        <h3 className="text-mcs-md font-semibold">世界信息</h3>
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
      </header>

      <div className="px-4 py-2">
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
          <p className="py-8 text-center text-mcs-xs text-mcs-text-subtle">暂无世界信息</p>
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
              <span className="tnum">{world.sizeGB.toFixed(1)} GB</span>
              <span
                role="progressbar"
                aria-label="存档大小进度"
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={Math.min(Math.max(world.sizeGB, 0), 10)}
                className="h-1.5 w-20 overflow-hidden rounded-mcs-xs bg-mcs-bg-subtle"
              >
                <span
                  aria-hidden
                  className="block h-full rounded-mcs-xs bg-mcs-accent"
                  style={{ width: `${sizeProgress(world.sizeGB) * 100}%` }}
                />
              </span>
            </InfoRow>
            <InfoRow label="游戏天数">{world.gameDays} 天</InfoRow>
            <InfoRow label="难度">
              <PillBadge tone={difficultyTone(world.difficulty)}>{formatDifficulty(world.difficulty)}</PillBadge>
            </InfoRow>
            <InfoRow label="游戏模式">
              <PillBadge tone={gameModeTone(world.gameMode)}>{formatGameMode(world.gameMode)}</PillBadge>
            </InfoRow>
            <InfoRow label="视野距离">
              <span className="tnum">{world.viewDistance}</span>
            </InfoRow>
            <InfoRow label="在线玩家">
              <span className="tnum">
                {world.onlinePlayers}/{world.maxPlayers}
              </span>
            </InfoRow>
          </dl>
        )}
      </div>
    </section>
  )
}
