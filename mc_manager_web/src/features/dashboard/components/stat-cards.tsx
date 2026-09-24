import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { ArrowRight, CheckCircle2, History, MoonStar, Play, Save } from 'lucide-react'
import { StatusPill } from '@/components/mcs/status-pill'
import { ListSkeleton } from '@/components/mcs/data-states'
import { Card, CardHeader, CardTitle } from '@/components/mcs/card'
import { Skeleton } from '@/components/ui/skeleton'
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
  if (!isRunning || tps == null) return 'text-mcs-text-muted'
  if (tps >= 19) return 'text-mcs-success-fg'
  if (tps >= 15) return 'text-mcs-warning-fg'
  return 'text-mcs-error-fg'
}

/** status 未就绪时的稳定空数组（避免 ?? [] 每次渲染新建引用、污染下游 useMemo） */
const NO_NAMES: string[] = []

/** 仪表盘统计卡外壳：卡片面 + 标题行（eyebrow 为右上角角标）走 mcs/card 基座。
 *  内距取紧凑卡档 p-3（而非标准卡 p-4）：顶排三卡是首屏固定占位，p-4 加 gap-3 会把
 *  终端可见高度压到 388px（1440×900 实测）；行距 gap-2 仍落在 4px 刻度内。 */
function StatCard({
  title,
  eyebrow,
  eyebrowClass,
  className,
  children,
}: {
  title: string
  eyebrow?: React.ReactNode
  eyebrowClass?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn('mcs-edge-top relative flex min-w-0 flex-1 flex-col gap-2 p-3', className)}>
      <CardHeader className="justify-between gap-2">
        <CardTitle as="h2" variant="label">
          {title}
        </CardTitle>
        {eyebrow && <span className={cn('text-mcs-xs', eyebrowClass)}>{eyebrow}</span>}
      </CardHeader>
      {children}
    </Card>
  )
}

// ── 顶部资源卡（CPU/内存/磁盘三行 + 右上角 TPS 信息）────────────
export function BigStatCards({
  isLoading = false,
}: {
  /** 首屏加载（B17）：status 未到前显示骨架 */
  isLoading?: boolean
}) {
  const status = useServerStore((s) => s.status)
  const systemStats = useServerStore((s) => s.systemStats)

  const isRunning = status?.isRunning ?? false
  const tps = status?.tps ?? null
  const healthy = isRunning && (tps ?? 0) >= 19

  // 本卡是**整机**资源口径：实例状态里的 memoryUsage 是进程 RSS、cpuUsage 是进程 CPU%，
  // 与整机口径不同源，不能互为后备（混用会得出「进程内存 / 整机总量」这类失真比例）。
  // 整机数据未到时如实留空，由渲染层给「暂无数据」——与磁盘行既有做法一致。
  const cpu = systemStats?.cpuUsage ?? null
  const memUsed = systemStats?.memoryUsage ?? null
  const memTotal = systemStats?.totalMemory ?? null
  const cores = systemStats?.cpuCores
  // 无数据时保持 null（不是 0）：0 会被进度条与读屏当成「占用 0%」播报，与「暂无数据」冲突
  const hasMem = memUsed != null && memTotal != null
  const memPct = hasMem ? (systemStats?.memoryPercent ?? (memUsed / memTotal) * 100) : null
  const diskUsage = systemStats?.diskUsage
  const primary = diskUsage?.primary ?? null

  // B17 首屏骨架：单卡同构占位（标题条 + 三行进度条）
  if (isLoading) {
    return (
      <Card
        className="animate-mcs-fade-up mcs-delay-2 mcs-edge-top relative flex min-w-0 flex-col gap-2 p-3"
        aria-label="统计加载中"
        role="status"
      >
        <Skeleton className="h-3.5 w-16" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-1.5 w-full" />
          </div>
        ))}
      </Card>
    )
  }

  return (
    <StatCard
      title="资源使用"
      className="animate-mcs-fade-up mcs-delay-2"
      eyebrow={
        isRunning ? (
          <span className="inline-flex items-center gap-2">
            <StatusPill tone={healthy ? 'success' : 'warning'} className="gap-1 text-mcs-2xs">
              <CheckCircle2 className="size-3.5" aria-hidden />
              {healthy ? '健康' : '卡顿'}
            </StatusPill>
            {/* TPS 是卡级关键数字（Grafana 三段式：小标签 + 大数 + 后缀）：
                数值占数字档 display，单位与状态词留在小档，不随数字放大 */}
            <span className={cn('mcs-num text-mcs-display leading-none', tpsColor(tps, isRunning))}>
              {tps != null ? tps.toFixed(1) : '--'}
            </span>
            <span className="text-mcs-lg text-mcs-text-muted">TPS</span>
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <ResourceRow
          label="CPU"
          eyebrow={
            cores ? (
              <StatusPill tone="muted" className="text-mcs-2xs">
                {cores} 核
              </StatusPill>
            ) : undefined
          }
          value={
            cpu != null ? (
              <>
                {cpu.toFixed(1)}
                <span className="text-mcs-sm font-medium text-mcs-text-muted">%</span>
              </>
            ) : (
              <span className="font-sans text-mcs-sm font-medium text-mcs-text-muted">
                暂无数据
              </span>
            )
          }
          percent={cpu}
          barColor={cpu != null ? loadBarColor(cpu) : undefined}
        />
        <ResourceRow
          label="内存"
          eyebrow={
            memPct != null ? (
              <StatusPill tone="muted" className="text-mcs-2xs">
                {memPct.toFixed(0)}%
              </StatusPill>
            ) : undefined
          }
          value={
            hasMem ? (
              <>
                {memUsed.toFixed(1)}
                <span className="text-mcs-sm font-medium text-mcs-text-muted">
                  {' '}
                  / {memTotal.toFixed(0)}G
                </span>
              </>
            ) : (
              <span className="font-sans text-mcs-sm font-medium text-mcs-text-muted">
                暂无数据
              </span>
            )
          }
          percent={memPct}
          barColor={memPct != null ? loadBarColor(memPct) : undefined}
        />
        <ResourceRow
          label="磁盘"
          eyebrow={
            primary ? (
              <StatusPill tone="muted" className="text-mcs-2xs">
                {primary.percent.toFixed(1)}%
              </StatusPill>
            ) : undefined
          }
          value={
            primary ? (
              <>
                {primary.usedGB}
                <span className="text-mcs-sm font-medium text-mcs-text-muted">
                  {' '}
                  / {primary.totalGB}G
                </span>
              </>
            ) : (
              <span className="font-sans text-mcs-sm font-medium text-mcs-text-muted">
                暂无磁盘数据
              </span>
            )
          }
          percent={primary?.percent ?? null}
          barColor={primary ? loadBarColor(primary.percent) : undefined}
        />
      </div>
    </StatCard>
  )
}

/** 资源行：标签 + 右侧数值 + 底部进度条（CPU/内存/磁盘 共用） */
function ResourceRow({
  label,
  eyebrow,
  value,
  percent,
  barColor,
}: {
  label: string
  eyebrow?: React.ReactNode
  value: React.ReactNode
  /** null 表示无数据：此时不暴露进度语义（否则读屏播报「0%」，与「暂无数据」文案冲突） */
  percent: number | null
  barColor?: string
}) {
  const p = percent == null ? null : Math.max(0, Math.min(100, percent))
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-mcs-xs font-medium text-mcs-text-muted">{label}</span>
        {eyebrow}
        <span className="mcs-num text-mcs-lg leading-none">{value}</span>
      </div>
      {/* 无数据时保留轨道（避免行高跳动）但不带语义，仅作装饰 */}
      <div
        {...(p == null
          ? { 'aria-hidden': true }
          : {
              role: 'progressbar',
              'aria-valuenow': Math.round(p),
              'aria-valuemin': 0,
              'aria-valuemax': 100,
            })}
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-mcs-bg-secondary"
      >
        <div
          className="mcs-progress-sheen h-full w-full rounded-full transition-transform duration-mcs-base ease-mcs-snappy"
          style={{
            transform: `translateX(${(p ?? 0) - 100}%)`,
            background: barColor ?? 'var(--mcs-success-fg)',
          }}
        />
      </div>
    </div>
  )
}

// ── 右栏卡：在线玩家（Flutter 版两列布局 + Web 版交互）──────────
/** 每列最多显示玩家数（Flutter 版 maxDisplay=3 同源），超出以 +N 汇总 */
const MAX_COLUMN_ROWS = 3

export function PlayersCard({ isLoading = false }: { isLoading?: boolean }) {
  const status = useServerStore((s) => s.status)
  const navigate = useNavigate()
  const isRunning = status?.isRunning ?? false
  const rconConnected = status?.isRconConnected ?? false
  const online = status?.playerCount ?? 0
  const max = status?.maxPlayers ?? 20
  const opCount = status?.opCount ?? 0
  const opNames = status?.opNames ?? NO_NAMES
  const sleeping = status?.sleepingPlayers ?? 0
  const sleepingNames = status?.sleepingPlayerNames ?? NO_NAMES
  const awakeNames = status?.awakePlayerNames ?? NO_NAMES
  const awake = Math.max(online - sleeping, 0)

  /** 玩家行按钮：整行可点直达详情（保留 Web 版交互） */
  const renderPlayerRow = (name: string, isSleeping: boolean) => (
    <button
      key={name}
      type="button"
      onClick={() => navigate(`/players?player=${encodeURIComponent(name)}`)}
      aria-label={`查看 ${name} 详情`}
      className="group flex w-full items-center gap-2 rounded-mcs-xs px-1.5 py-1 text-left hover:bg-mcs-state-hover"
    >
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full text-mcs-2xs font-semibold',
          isSleeping
            ? 'bg-mcs-info-bg-subtle text-mcs-info-fg'
            : 'bg-mcs-accent-bg-subtle text-mcs-accent-fg',
        )}
        aria-hidden
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-text-muted group-hover:text-mcs-text-default">
        {name}
      </span>
    </button>
  )

  /** 入睡/清醒列（Flutter 版 _PlayerNameColumn）：列头图标+标签+数量，名单最多 3 名 +N 汇总 */
  const renderColumn = (
    icon: React.ReactNode,
    label: string,
    count: number,
    names: string[],
    isSleeping: boolean,
  ) => (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1 text-mcs-2xs text-mcs-text-muted">
        {icon}
        <span>{label}</span>
        <b className="tnum font-semibold">{count}</b>
      </div>
      {names.length === 0 ? (
        <span className="pt-1 text-mcs-2xs text-mcs-text-muted">—</span>
      ) : (
        <ol className="flex flex-col">
          {names.slice(0, MAX_COLUMN_ROWS).map((name) => renderPlayerRow(name, isSleeping))}
          {names.length > MAX_COLUMN_ROWS && (
            <li className="px-1.5 py-0.5 text-mcs-2xs text-mcs-text-muted">
              +{names.length - MAX_COLUMN_ROWS}
            </li>
          )}
        </ol>
      )}
    </div>
  )

  const names = useMemo(
    () => [...new Set([...sleepingNames, ...awakeNames])],
    [sleepingNames, awakeNames],
  )

  const body = isLoading ? (
    // 首帧未落定不得抢答：此前 status 未到即按 isRunning=false 渲染
    // 「实例已停止，暂无玩家数据」，把「还不知道」说成了一条确定结论
    <ListSkeleton rows={3} />
  ) : !isRunning ? (
    <p className="py-1 text-mcs-xs text-mcs-text-muted">实例已停止，暂无玩家数据</p>
  ) : names.length === 0 ? (
    <div className="flex items-center gap-2 py-1">
      <p className="text-mcs-xs text-mcs-text-muted">
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
    <div className="flex gap-4 border-t border-mcs-border-muted pt-2">
      {renderColumn(
        <MoonStar className="size-3 text-mcs-info-fg" aria-hidden />,
        '入睡',
        sleeping,
        sleepingNames,
        true,
      )}
      {renderColumn(
        <span className="size-1.5 rounded-full bg-mcs-success-fg" aria-hidden />,
        '清醒',
        awake,
        awakeNames,
        false,
      )}
    </div>
  )

  return (
    <StatCard
      title="在线玩家"
      className="animate-mcs-fade-up mcs-delay-1"
      eyebrow={
        <button
          type="button"
          onClick={() => navigate('/players')}
          aria-label="查看全部玩家"
          className="inline-flex items-center gap-0.5 text-mcs-xs font-medium text-mcs-info-fg hover:underline"
        >
          全部
          <ArrowRight className="size-3" aria-hidden />
        </button>
      }
    >
      {/* 主数字行（Flutter 版 RunStatusCard 同款：在线/上限大字号 + OP 徽章与名单） */}
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="mcs-num text-mcs-display leading-none">
            {online}
            <span className="text-mcs-lg font-normal text-mcs-text-muted">/{max}</span>
          </span>
          <span className="text-mcs-2xs text-mcs-text-muted">
            今日新增 {status?.todayNewPlayers ?? 0}
          </span>
        </div>
        {opCount > 0 && (
          <div className="flex flex-col items-end gap-0.5">
            <StatusPill tone="warning" className="text-mcs-2xs">
              OP {opCount}/{online}
            </StatusPill>
            {opNames.length > 0 && (
              <span className="max-w-35 truncate text-mcs-2xs text-mcs-warning-fg">
                {opNames.slice(0, 2).join(', ')}
                {opNames.length > 2 ? '…' : ''}
              </span>
            )}
          </div>
        )}
      </div>
      {body}
    </StatCard>
  )
}

// ── 顶部卡：实例信息 ────────────────────────────────────────
export function RuntimeInfoCard({ isLoading = false }: { isLoading?: boolean }) {
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
      icon: History,
    },
    {
      label: isRunning ? '本次启动' : '上次启动',
      value: formatStartTime(status?.startTime),
      icon: Play,
    },
    {
      // 绝对时间（与启动时间同格式）；相对时间降级为悬停提示——「刚刚」类
      // 模糊值无法核对存档是否如期发生
      label: '上次存档',
      value: formatStartTime(status?.lastSave),
      tooltip: status?.lastSave ? `相对时间：${formatRelativeTime(status.lastSave)}` : undefined,
      icon: Save,
    },
  ]

  // 版本信息：右上角展示（替代原图标位）；无 modLoader 时仅显示 MC 版本
  const versionText = status?.mcVersion
    ? status.modLoader && status.modLoader !== 'vanilla'
      ? `${status.mcVersion} · ${status.modLoader}`
      : status.mcVersion
    : null

  return (
    <StatCard
      title="实例信息"
      className="animate-mcs-fade-up mcs-delay-3"
      eyebrow={
        versionText ? (
          <StatusPill tone="muted" className="tnum text-mcs-2xs">
            {versionText}
          </StatusPill>
        ) : undefined
      }
    >
      {isLoading ? (
        // 首帧未落定时本卡会给出「累计运行 0m」这类**肯定值**（totalUptime 在
        // isRunning=false 下取 0），把「还不知道」说成「跑了 0 分钟」——故整块走骨架
        <div className="flex flex-col gap-3" aria-hidden>
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
          <div className="flex flex-col gap-1.5 border-t border-mcs-border-muted pt-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            {/* 停止态下数值为 —（本次会话已结束），label 同步改「上次」避免语义误导 */}
            <p className="text-mcs-xs text-mcs-text-muted">
              {isRunning ? '本次运行时长' : '上次运行时长'}
            </p>
            {/* 本卡关键数字：与在线玩家 / 资源使用两卡同为顶排卡级大数（明细行留在 xs） */}
            <p
              className={cn(
                'mcs-num text-mcs-display leading-none',
                !isRunning && 'text-mcs-text-muted',
              )}
            >
              {formatUptime(isRunning ? uptime : null)}
            </p>
          </div>
          <div className="flex flex-col gap-1.5 border-t border-mcs-border-muted pt-2">
            {infoLines.map((line) => (
              <div
                key={line.label}
                className="flex items-center justify-between text-mcs-xs"
                title={line.tooltip}
              >
                <span className="flex items-center gap-1.5 text-mcs-text-muted">
                  <line.icon className="size-3 text-mcs-text-muted" aria-hidden />
                  {line.label}
                </span>
                <span className="tnum font-medium">{line.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </StatCard>
  )
}

/** 磁盘使用率色阶（ResourceRow 磁盘行用）：正常 / 警告(≥85%) / 错误(≥95%) */
/**
 * 三行资源条（CPU / 内存 / 磁盘）共用的阈值阶梯：≥95 红 / ≥85 黄 / 其余绿。
 * 同卡三行是同一套视觉语言，阶梯必须一致——此前只有磁盘行接它，CPU 与内存行恒绿，
 * 于是「97% 的 CPU」和「12% 的 CPU」长得一模一样（违反 P1 的阈值对齐）。
 * 刻意不复用告警系统的 80：那条是**进程** CPU 单核口径（见 lib/notifications.ts
 * 的 DEFAULT_ALERT_THRESHOLDS 声明），与本卡的整机口径不同源、不可互为后备。
 */
const LOAD_WARN_PERCENT = 85
const LOAD_DANGER_PERCENT = 95

function loadBarColor(percent: number): string {
  if (percent >= LOAD_DANGER_PERCENT) return 'var(--mcs-error-fg)'
  if (percent >= LOAD_WARN_PERCENT) return 'var(--mcs-warning-fg)'
  return 'var(--mcs-success-fg)'
}
