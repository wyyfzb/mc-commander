import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { ArrowRight, CheckCircle2, HardDrive, Info, MoonStar, Skull, Users } from 'lucide-react'
import { StatusPill } from '@/components/mcs/status-pill'
import { Skeleton } from '@/components/ui/skeleton'
import { Sparkline } from '@/components/mcs/sparkline'
import { useServerStore } from '@/stores/server'
import { formatRelativeTime, formatStartTime, formatUptime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * 仪表盘统计卡（顶部四卡 + 右栏在线玩家/运行信息）
 * 顶部四卡：在线玩家/TPS/CPU/内存（大数字 + 迷你趋势/进度条）
 * 右栏在线玩家卡：整行可点直达玩家详情（?player= 深链）
 */

/** TPS 阈值（≥19 健康 / 15-19 卡顿 / <15 严重卡顿） */
export function tpsColor(tps: number | null, isRunning: boolean): string {
  if (!isRunning || tps == null) return 'text-mcs-text-subtle'
  if (tps >= 19) return 'text-mcs-success-fg'
  if (tps >= 15) return 'text-mcs-warning-fg'
  return 'text-mcs-error-fg'
}

/** status 未就绪时的稳定空数组（避免 ?? [] 每次渲染新建引用、污染下游 useMemo） */
const NO_NAMES: string[] = []

function Card({
  title,
  eyebrow,
  eyebrowClass,
  children,
}: {
  title: string
  eyebrow?: React.ReactNode
  eyebrowClass?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-mcs-sm font-medium text-mcs-text-muted">{title}</h2>
        {eyebrow && <span className={cn('text-mcs-xs', eyebrowClass)}>{eyebrow}</span>}
      </header>
      {children}
    </section>
  )
}

/** 迷你进度条（token 填充色；XP 条语义） */
function XpBar({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(p)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-mcs-bg-emphasis"
    >
      <div className="h-full rounded-full" style={{ width: `${p}%`, background: 'var(--mcs-accent)' }} />
    </div>
  )
}

/** 在线玩家名（op + 入睡 + 清醒 并集保序去重） */

const AVATAR_TONES = [
  'bg-mcs-accent-bg-subtle text-mcs-accent-fg',
  'bg-mcs-info-bg-subtle text-mcs-info-fg',
  'bg-mcs-warning-bg-subtle text-mcs-warning-fg',
] as const

// ── 顶部四卡 ─────────────────────────────────────────────────
export function BigStatCards({
  history,
  isLoading = false,
}: {
  history: { cpu: number[]; mem: number[]; tps: number[] }
  /** 首屏加载（B17）：status 未到前四卡显示骨架 */
  isLoading?: boolean
}) {
  const status = useServerStore((s) => s.status)
  const systemStats = useServerStore((s) => s.systemStats)

  const isRunning = status?.isRunning ?? false
  const tps = status?.tps ?? null
  const healthy = isRunning && (tps ?? 0) >= 19

  const online = status?.playerCount ?? 0
  const max = status?.maxPlayers ?? 20
  const names = useMemo(
    () => [
      ...new Set([
        ...(status?.opNames ?? []),
        ...(status?.sleepingPlayerNames ?? []),
        ...(status?.awakePlayerNames ?? []),
      ]),
    ],
    [status?.opNames, status?.sleepingPlayerNames, status?.awakePlayerNames],
  )
  const opCount = status?.opCount ?? 0
  const sleeping = status?.sleepingPlayers ?? 0

  const cpu = systemStats?.cpuUsage ?? status?.cpuUsage ?? 0
  const memUsed = systemStats?.memoryUsage ?? status?.memoryUsage ?? 0
  const memTotal = systemStats?.totalMemory ?? status?.totalMemory ?? 0
  const cores = systemStats?.cpuCores
  const memPct = systemStats?.memoryPercent ?? (memTotal > 0 ? (memUsed / memTotal) * 100 : 0)

  // B17 首屏骨架：四卡同构占位（标题条 + 大数字 + 进度条）
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4" aria-label="统计加载中" role="status">
        {Array.from({ length: 4 }, (_, i) => (
          <section
            key={i}
            className="flex min-w-0 flex-1 flex-col gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4"
          >
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-1.5 w-full" />
          </section>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      {/* 在线玩家 */}
      <Card
        title="在线玩家"
        eyebrow={
          <StatusPill tone="success" className="gap-1 text-mcs-2xs">
            <span className="flex size-1.5 rounded-full bg-mcs-success-fg" aria-hidden />
            {online}/{max}
          </StatusPill>
        }
      >
        <div className="flex items-end gap-2.5">
          <span className="tnum text-mcs-2xl font-bold leading-none">{online}</span>
          {names.length > 0 && (
            <span className="mb-0.5 flex shrink-0">
              {names.slice(0, 3).map((name, i) => (
                <span
                  key={name}
                  title={name}
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full border-2 border-mcs-bg-muted text-mcs-2xs font-bold',
                    AVATAR_TONES[i % AVATAR_TONES.length],
                  )}
                  style={{ marginLeft: i > 0 ? -6 : 0 }}
                  aria-hidden
                >
                  {name.charAt(0).toUpperCase()}
                </span>
              ))}
              {names.length > 3 && (
                <span
                  className="mb-0.5 ml-[-6px] flex size-6 items-center justify-center rounded-full border-2 border-mcs-bg-muted bg-mcs-bg-emphasis text-mcs-2xs font-medium text-mcs-text-muted"
                  aria-hidden
                >
                  +{names.length - 3}
                </span>
              )}
            </span>
          )}
        </div>
        <p className="text-mcs-2xs text-mcs-text-subtle">
          OP {opCount} · 入睡 {sleeping} · 今日新增 {status?.todayNewPlayers ?? 0}
        </p>
      </Card>

      {/* TPS */}
      <Card
        title="TPS"
        eyebrow={
          isRunning ? (
            <StatusPill tone={healthy ? 'success' : 'warning'} className="gap-1 text-mcs-2xs">
              <CheckCircle2 className="size-3.5" aria-hidden />
              {healthy ? '健康' : '卡顿'}
            </StatusPill>
          ) : undefined
        }
      >
        <p className={cn('tnum text-mcs-2xl font-bold leading-none', tpsColor(tps, isRunning))}>
          {isRunning && tps != null ? tps.toFixed(1) : '--'}
        </p>
        <Sparkline data={history.tps} colorVar="var(--mcs-success-fg)" className="mt-1 h-7 w-full" />
      </Card>

      {/* CPU */}
      <Card
        title="CPU"
        eyebrow={cores ? (
          <StatusPill tone="muted" className="text-mcs-2xs">{cores} 核</StatusPill>
        ) : undefined}
      >
        <p className="tnum text-mcs-2xl font-bold leading-none">
          {cpu.toFixed(1)}
          <span className="text-mcs-sm font-medium text-mcs-text-subtle">%</span>
        </p>
        <div className="mt-auto">
          <XpBar percent={cpu} />
        </div>
      </Card>

      {/* 内存 */}
      <Card
        title="内存"
        eyebrow={<StatusPill tone="muted" className="text-mcs-2xs">{memPct.toFixed(0)}%</StatusPill>}
      >
        <p className="tnum text-mcs-2xl font-bold leading-none">
          {memUsed.toFixed(1)}
          <span className="text-mcs-sm font-medium text-mcs-text-subtle"> / {memTotal.toFixed(0)}G</span>
        </p>
        <div className="mt-auto">
          <XpBar percent={memPct} />
        </div>
      </Card>
    </div>
  )
}

// ── 右栏卡：在线玩家（整行可点直达详情）────────────────────────
export function PlayersCard() {
  const status = useServerStore((s) => s.status)
  const navigate = useNavigate()
  const isRunning = status?.isRunning ?? false
  const rconConnected = status?.isRconConnected ?? false
  const online = status?.playerCount ?? 0
  const max = status?.maxPlayers ?? 20
  const opCount = status?.opCount ?? 0
  const sleeping = status?.sleepingPlayers ?? 0
  const sleepingNames = status?.sleepingPlayerNames ?? NO_NAMES
  const awakeNames = status?.awakePlayerNames ?? NO_NAMES
  const awake = Math.max(online - sleeping, 0)
  const names = useMemo(
    () => [...new Set([...sleepingNames, ...awakeNames])],
    [sleepingNames, awakeNames],
  )
  const maxRows = 5

  const body = !isRunning ? (
    <p className="py-1 text-mcs-xs text-mcs-text-subtle">实例已停止，暂无玩家数据</p>
  ) : names.length === 0 ? (
    <div className="flex items-center gap-2 py-1">
      <p className="text-mcs-xs text-mcs-text-subtle">
        {rconConnected ? '暂无玩家在线' : '需启用 RCON 才能读取在线玩家'}
      </p>
      {!rconConnected && (
        <button
          type="button"
          onClick={() => navigate('/world?tab=properties')}
          className="shrink-0 text-mcs-xs font-medium text-mcs-info-fg hover:underline"
        >
          前往服务器属性
        </button>
      )}
    </div>
  ) : (
    <ol className="flex flex-col">
      {names.slice(0, maxRows).map((name) => (
        <li key={name}>
          <button
            type="button"
            onClick={() => navigate(`/players?player=${encodeURIComponent(name)}`)}
            aria-label={`查看 ${name} 详情`}
            className="group flex w-full items-center gap-2 rounded-mcs-xs px-1.5 py-1 text-left hover:bg-mcs-state-hover"
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-mcs-2xs font-bold',
                sleepingNames.includes(name)
                  ? 'bg-mcs-info-bg-subtle text-mcs-info-fg'
                  : 'bg-mcs-accent-bg-subtle text-mcs-success-fg',
              )}
              aria-hidden
            >
              {name.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-text-muted group-hover:text-mcs-text-default">
              {name}
            </span>
            <span className="inline-flex items-center gap-1 text-mcs-2xs text-mcs-text-subtle">
              {sleepingNames.includes(name) ? (
                <>
                  <MoonStar className="size-3 text-mcs-info-fg" aria-hidden />
                  入睡
                </>
              ) : (
                <span className="size-1.5 rounded-full bg-mcs-success-fg" aria-hidden />
              )}
            </span>
          </button>
        </li>
      ))}
      {names.length > maxRows && (
        <li className="px-1.5 py-0.5 text-mcs-2xs text-mcs-text-subtle">… 另有 {names.length - maxRows} 人在线</li>
      )}
    </ol>
  )

  return (
    <Card
      title="在线玩家"
      eyebrow={
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-mcs-xs text-mcs-text-muted">
            <Users className="size-3.5 text-mcs-text-muted" aria-hidden />
            {online}/{max}
          </span>
          <button
            type="button"
            onClick={() => navigate('/players')}
            aria-label="查看全部玩家"
            className="inline-flex items-center gap-0.5 text-mcs-xs font-medium text-mcs-info-fg hover:underline"
          >
            全部
            <ArrowRight className="size-3" aria-hidden />
          </button>
        </span>
      }
    >
      {opCount > 0 && (
        <div className="flex items-center gap-1.5 text-mcs-xs">
          <StatusPill tone="warning" className="text-mcs-2xs">
            OP {opCount}/{online}
          </StatusPill>
        </div>
      )}
      {body}
      <div className="flex gap-4 border-t border-mcs-border-muted pt-2 text-mcs-2xs">
        <span className="inline-flex items-center gap-1 text-mcs-text-muted">
          <MoonStar className="size-3 text-mcs-info-fg" aria-hidden />
          入睡 <b className="tnum font-semibold">{sleeping}</b>
        </span>
        <span className="inline-flex items-center gap-1 text-mcs-text-muted">
          <span className="size-1.5 rounded-full bg-mcs-success-fg" aria-hidden />
          清醒 <b className="tnum font-semibold">{awake}</b>
        </span>
      </div>
    </Card>
  )
}

// ── 右栏卡：实例运行信息 ─────────────────────────────────────
export function RuntimeInfoCard() {
  const status = useServerStore((s) => s.status)
  const isRunning = status?.isRunning ?? false

  // 本次运行时长：status.uptime 为本次秒数
  const uptime = status?.uptime ?? 0
  const totalUptime = status?.totalUptime ?? (isRunning ? uptime : 0)

  const infoLines = [
    {
      label: '累计运行',
      value: formatUptime(totalUptime),
      tooltip: '累计运行 = 历史累计时长 + 本次运行时长',
    },
    {
      label: isRunning ? '本次启动' : '上次启动',
      value: formatStartTime(status?.startTime),
    },
    {
      label: '上次存档',
      value: formatRelativeTime(status?.lastSave),
    },
    // 运行信息卡：版本 / 核心
    ...(status?.mcVersion
      ? [
          {
            label: '版本 / 核心',
            value: status.modLoader && status.modLoader !== 'vanilla' ? `${status.mcVersion} · ${status.modLoader}` : status.mcVersion,
          },
        ]
      : []),
  ]

  return (
    <Card
      title="实例运行信息"
      eyebrow={
        <span className="flex size-7 items-center justify-center rounded-mcs-sm bg-mcs-purple-bg-subtle">
          <Info className="size-4 text-mcs-purple-fg" aria-hidden />
        </span>
      }
    >
      <div>
        <p className="text-mcs-xs text-mcs-text-subtle">本次运行时长</p>
        <p className={cn('tnum text-mcs-lg font-semibold', !isRunning && 'text-mcs-text-subtle')}>
          {formatUptime(isRunning ? uptime : null)}
        </p>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-mcs-border-muted pt-2">
        {infoLines.map((line) => (
          <div key={line.label} className="flex items-center justify-between text-mcs-xs" title={line.tooltip}>
            <span className="flex items-center gap-1.5 text-mcs-text-muted">
              <Skull className="size-3 text-mcs-text-subtle" aria-hidden />
              {line.label}
            </span>
            <span className="tnum font-medium">{line.value}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ── 右栏卡：磁盘使用率（feat-5 运维韧性）────────────────────
/** 磁盘使用率色阶：正常 / 警告(≥85%) / 错误(≥95%) */
function diskColor(percent: number): string {
  if (percent >= 95) return 'text-mcs-error-fg'
  if (percent >= 85) return 'text-mcs-warning-fg'
  return 'text-mcs-success-fg'
}

function diskBarColor(percent: number): string {
  if (percent >= 95) return 'var(--mcs-error-fg)'
  if (percent >= 85) return 'var(--mcs-warning-fg)'
  return 'var(--mcs-success-fg)'
}

export function DiskUsageCard() {
  const systemStats = useServerStore((s) => s.systemStats)
  const diskUsage = systemStats?.diskUsage
  const primary = diskUsage?.primary ?? null
  const all = diskUsage?.all ?? []

  const body = !primary ? (
    <p className="py-1 text-mcs-xs text-mcs-text-subtle">暂无磁盘数据</p>
  ) : (
    <div className="flex flex-col gap-2">
      {/* 主分区 */}
      <div className="flex items-center justify-between text-mcs-xs">
        <span className="flex items-center gap-1.5 text-mcs-text-muted">
          <HardDrive className="size-3.5" aria-hidden />
          <span className="max-w-[120px] truncate" title={primary.mountpoint}>{primary.mountpoint}</span>
        </span>
        <span className={cn('tnum font-semibold', diskColor(primary.percent))}>
          {primary.percent.toFixed(1)}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(primary.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-mcs-bg-emphasis"
      >
        <div className="h-full rounded-full" style={{ width: `${Math.min(primary.percent, 100)}%`, background: diskBarColor(primary.percent) }} />
      </div>
      <div className="flex justify-between text-mcs-2xs text-mcs-text-subtle">
        <span>已用 {primary.usedGB}G</span>
        <span>总计 {primary.totalGB}G</span>
        <span>可用 {(primary.totalGB - primary.usedGB).toFixed(1)}G</span>
      </div>
      {/* 多分区子行 */}
      {all.length > 1 && (
        <div className="flex flex-col gap-1 border-t border-mcs-border-subtle pt-1.5">
          {all.filter(d => d.mountpoint !== primary.mountpoint).slice(0, 3).map(d => (
            <div key={d.mountpoint} className="flex items-center justify-between text-mcs-2xs">
              <span className="max-w-[100px] truncate text-mcs-text-muted" title={d.mountpoint}>{d.mountpoint}</span>
              <span className={cn('tnum', diskColor(d.percent))}>{d.percent.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <Card
      title="磁盘使用率"
      eyebrow={
        <span className="flex size-7 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle">
          <HardDrive className="size-4 text-mcs-accent" aria-hidden />
        </span>
      }
    >
      {body}
    </Card>
  )
}
