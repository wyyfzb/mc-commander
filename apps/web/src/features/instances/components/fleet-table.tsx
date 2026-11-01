/**
 * FleetTable —— 全实例一行一实例的密集清单
 *
 * 形态判据（为什么不是卡片墙）：卡片墙每张 ~180px，12 个实例就要滚两屏，而「哪个在跑、
 * 哪个卡了」要的是**同屏可比**——指标对齐成列才能一眼看出离群值，卡片里每个数字各在各的
 * 位置，比较就得来回扫。故一行一实例，行高 ~36px，12 行 432px 一屏装得下。
 *
 * 列按**容器宽**上列（不是视口）：侧栏 56↔208px、md 以下抽屉、主从页借走 420px，同视口下
 * 这块的实宽能差六百多 px。
 * 窄容器下四项运行指标由「实例名」下的摘要行承担——表格式对齐换不来回读的可读性，
 * 摘要行是省略式状态行（以单位收尾），故 2xs 合规。
 */
import { useNavigate } from 'react-router'
import { cn } from '@/lib/utils'
import { DataTableShell } from '@/components/mcs/data-table-shell'
import { StatusPill } from '@/components/mcs/status-pill'
import { CountBadge } from '@/components/mcs/count-badge'
import { CardTitle } from '@/components/mcs/card'
import { Button } from '@/components/ui/button'
import { SEMANTIC_TONE_CLASSES } from '@/components/mcs/tone'
import { instanceHueFillClass } from '@/lib/instance-hue'
import { instanceLabel } from '@/lib/instance-label'
import { formatWorldSize } from '@/lib/format'
import { parseMemoryGB } from '@/lib/instance-memory'
import { tpsLevel } from '@/lib/mc-tps'
import { useServerStore } from '@/stores/server'
import type { FleetRow } from '../fleet-health'
import { fleetRowSummary } from '../fleet-health'

/**
 * 列上列阈值（容器档，Tailwind v4 默认档：@2xl=672 / @3xl=768）。
 *
 * 四项运行指标（在线/TPS/内存/存档）对齐成列，各列最小可用宽合计约 648px
 * （实例名 140 + 状态 72 + 需关注 76 + 在线 56 + TPS 52 + 内存 80 + 存档 60，另加 7 格
 * 横向内距 112）——低于此宽会把实例名压到读不出，故取 @2xl(672) 起上列。
 * 版本列再需 ~80px，@3xl(768) 起上列；再窄时版本仍可在实例名的 title 里读到。
 *
 * 上列与摘要行是**同一处开关**（都切 @2xl）：错开档位会出现「摘要行已隐藏、对应列还没上」
 * 的窗口，那一段宽度里指标凭空消失。
 */
const METRIC_COLUMN_CLASS = 'hidden px-2 py-2 text-right @2xl:table-cell'
const VERSION_COLUMN_CLASS = 'hidden px-2 py-2 text-right @3xl:table-cell'
const BASE_CELL = 'px-2 py-2'

/**
 * 列宽表：table-fixed 下由表头声明，数据列不再各自写宽。
 *
 * 状态与需关注两列给**响应式宽**：它们在任何档都在列，而窄容器（375 视口下表格区约 343px）
 * 两列各占 96/112px 会把实例名压到只剩「E2E ...」。窄档收到 64px——两列里的药丸都是
 * 4 字以内（运行中/已停止/崩溃熔断），2xs 档约 40px 加内距，64px 装得下。
 */
const COLUMN_WIDTH = {
  status: 'w-16 @2xl:w-24',
  issue: 'w-16 @2xl:w-28',
  players: 'w-20',
  tps: 'w-20',
  memory: 'w-24',
  world: 'w-24',
  version: 'w-24',
} as const

export interface FleetTableProps {
  rows: FleetRow[]
  isLoading: boolean
  /** 列表请求失败且无数据可留（有旧值时由页面给非阻断告警，不替换主体） */
  error: unknown
}

export function FleetTable({ rows, isLoading, error }: FleetTableProps) {
  const currentId = useServerStore((s) => s.instanceId)
  const phaseById = useServerStore((s) => s.phase)
  const setInstanceId = useServerStore((s) => s.setInstanceId)
  const navigate = useNavigate()

  /**
   * 打开实例：切到它再进仪表盘。总览的价值是「看清 → 处理」，只读不给入口等于让人
   * 记住名字再去别处找一遍（识别优于回忆）。
   */
  const openInstance = (id: string) => {
    setInstanceId(id)
    void navigate('/dashboard')
  }

  const header = (
    <thead>
      <tr className="border-b border-mcs-border-muted">
        <th scope="col" className={cn(BASE_CELL, 'text-left font-medium text-mcs-text-muted')}>
          实例
        </th>
        <th
          scope="col"
          className={cn(
            BASE_CELL,
            COLUMN_WIDTH.status,
            'text-left font-medium text-mcs-text-muted',
          )}
        >
          状态
        </th>
        <th
          scope="col"
          className={cn(BASE_CELL, COLUMN_WIDTH.issue, 'text-left font-medium text-mcs-text-muted')}
        >
          需关注
        </th>
        <th scope="col" className={cn(METRIC_COLUMN_CLASS, COLUMN_WIDTH.players, 'font-medium')}>
          在线
        </th>
        <th scope="col" className={cn(METRIC_COLUMN_CLASS, COLUMN_WIDTH.tps, 'font-medium')}>
          TPS
        </th>
        <th
          scope="col"
          className={cn(METRIC_COLUMN_CLASS, COLUMN_WIDTH.memory, 'font-medium')}
          title="进程驻留内存 / 已分配的 -Xmx；两者口径不同，不据此判定「内存满」"
        >
          内存 GB
        </th>
        <th scope="col" className={cn(METRIC_COLUMN_CLASS, COLUMN_WIDTH.world, 'font-medium')}>
          存档
        </th>
        <th scope="col" className={cn(VERSION_COLUMN_CLASS, COLUMN_WIDTH.version, 'font-medium')}>
          版本
        </th>
      </tr>
    </thead>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <CardTitle as="h3">全部实例</CardTitle>
        {!isLoading && <CountBadge>{rows.length}</CountBadge>}
      </div>
      <DataTableShell
        header={header}
        columns={8}
        tableClassName="table-fixed"
        isLoading={isLoading}
        error={error}
        isEmpty={rows.length === 0}
        emptyText="暂无已安装的实例"
        emptyActions={
          <Button size="sm" variant="outline" onClick={() => void navigate('/instances')}>
            去实例页部署
          </Button>
        }
        skeletonRows={5}
        skeletonWidths={['w-40', 'w-16', 'w-16', 'w-10', 'w-10', 'w-16', 'w-16', 'w-12']}
      >
        <tbody>
          {rows.map((row) => (
            <FleetRowView
              key={row.status.id}
              row={row}
              isCurrent={currentId === row.status.id}
              phase={phaseById[row.status.id] ?? null}
              onOpen={() => openInstance(row.status.id)}
            />
          ))}
        </tbody>
      </DataTableShell>
    </div>
  )
}

/** 生命周期状态：启停中间态优先——isRunning 尚未翻转时先照实说「正在启动/停止」 */
function LifecyclePill({ isRunning, phase }: { isRunning: boolean; phase: string | null }) {
  if (phase === 'starting') {
    return (
      <StatusPill tone="default" className="text-mcs-2xs">
        启动中
      </StatusPill>
    )
  }
  if (phase === 'stopping') {
    return (
      <StatusPill tone="default" className="text-mcs-2xs">
        停止中
      </StatusPill>
    )
  }
  return isRunning ? (
    <StatusPill tone="success" className="text-mcs-2xs">
      运行中
    </StatusPill>
  ) : (
    <StatusPill tone="muted" className="text-mcs-2xs">
      已停止
    </StatusPill>
  )
}

function FleetRowView({
  row,
  isCurrent,
  phase,
  onOpen,
}: {
  row: FleetRow
  isCurrent: boolean
  phase: string | null
  onOpen: () => void
}) {
  const { status, issue } = row
  const label = instanceLabel(status)
  const running = status.isRunning
  const tps = running ? status.tps : null
  const level = tps == null ? null : tpsLevel(tps)
  const tpsToneText =
    level === 'critical'
      ? SEMANTIC_TONE_CLASSES.error.text
      : level === 'warning'
        ? SEMANTIC_TONE_CLASSES.warning.text
        : undefined
  // RSS 与 -Xmx 不同口径（前者含堆外），只并排展示、不据此造告警阈值
  const allocatedGB = parseMemoryGB(status.maxMemory)
  const memoryText =
    running && status.memoryUsage > 0
      ? allocatedGB != null
        ? `${status.memoryUsage} / ${allocatedGB}`
        : `${status.memoryUsage} / —`
      : '—'

  return (
    <tr className="border-b border-mcs-border-muted transition-colors last:border-b-0 hover:bg-mcs-state-hover">
      <td className={cn(BASE_CELL, 'min-w-0')}>
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn('size-2 shrink-0 rounded-full', instanceHueFillClass(status.id))}
          />
          <button
            type="button"
            onClick={onOpen}
            aria-label={`打开 ${label}`}
            title={`打开 ${label}`}
            className="min-w-0 truncate rounded-mcs-xs text-left font-medium text-mcs-text-default hover:underline focus-visible:outline-2 focus-visible:outline-mcs-focus-ring focus-visible:outline-offset-1"
          >
            {label}
          </button>
          {isCurrent && (
            <StatusPill tone="accent" className="shrink-0 text-mcs-2xs font-semibold">
              当前
            </StatusPill>
          )}
        </div>
        <p
          className="mt-0.5 truncate text-mcs-2xs text-mcs-text-muted @2xl:hidden"
          title={status.mcVersion || undefined}
        >
          {fleetRowSummary(status)}
        </p>
      </td>
      <td className={BASE_CELL}>
        <LifecyclePill isRunning={running} phase={phase} />
      </td>
      <td className={BASE_CELL}>
        {issue ? (
          <StatusPill
            tone={issue.level === 'error' ? 'error' : 'warning'}
            className="text-mcs-2xs font-semibold"
            title={issue.description}
          >
            {issue.label}
          </StatusPill>
        ) : (
          <span className="text-mcs-xs text-mcs-text-muted">无</span>
        )}
      </td>
      <td className={cn(METRIC_COLUMN_CLASS, 'mcs-num text-mcs-xs')}>
        {running ? `${status.playerCount}/${status.maxPlayers}` : '—'}
      </td>
      <td className={cn(METRIC_COLUMN_CLASS, 'mcs-num text-mcs-xs', tpsToneText)}>
        {tps != null ? tps.toFixed(1) : '—'}
      </td>
      <td className={cn(METRIC_COLUMN_CLASS, 'mcs-num text-mcs-xs')}>{memoryText}</td>
      <td className={cn(METRIC_COLUMN_CLASS, 'mcs-num text-mcs-xs')}>
        {formatWorldSize(status.worldSize)}
      </td>
      <td
        className={cn(VERSION_COLUMN_CLASS, 'font-mono text-mcs-2xs text-mcs-text-muted')}
        title={status.modLoader}
      >
        {status.mcVersion || '—'}
      </td>
    </tr>
  )
}
