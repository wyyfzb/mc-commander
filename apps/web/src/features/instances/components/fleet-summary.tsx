/**
 * FleetSummary —— 总览页头部的整机与实例账（四张数据卡）
 *
 * 每张卡只承担一个数字，且都配一句「这个数字意味着什么」：多实例用户在这里判的不是
 * 「数值多大」，而是「还装得下吗 / 有没有满」。故内存卡给的是**可分配余量**而不是使用率
 * ——使用率是此刻快照，余量才是能据以决定的那个量。
 *
 * 整机口径与进程口径不混用：这里全部取整机（`/overview` 与 `system-stats` 同源），
 * 实例的 RSS/-Xmx 只在清单里逐台出现。混用会得出「进程内存 / 整机总量」这类失真比例。
 */
import { Card, CardHeader, CardTitle } from '@/components/mcs/card'
import { CountBadge } from '@/components/mcs/count-badge'
import { StatusPill } from '@/components/mcs/status-pill'
import { cn } from '@/lib/utils'
import {
  allocatableMemoryGB,
  hasHostMemoryTotal,
  readHostMemoryPercent,
  sumAllocatedGB,
} from '@/lib/instance-memory'
import type { OverviewData } from '@/api/types'
import type { FleetRow } from '../fleet-health'

export interface FleetSummaryProps {
  rows: FleetRow[]
  overview: OverviewData | undefined
  listUnavailable: boolean
}

/**
 * 数据卡外壳：标签行 + 主数值 + 说明行（三行同构，四卡并排时基线对齐）。
 *
 * 说明行走 xs 而非 2xs：内存那张写的是「已分配 6 GB，可分配 14 GB」，含分句标点即按句子
 * 处理（10px 下 CJK 笔画屏显发糊，12px 才是中文正文的常规下限）。四张卡统一同档，
 * 否则同一排里两张 10px、两张 12px，读起来像两种层级的标签。
 */
function MetricCard({
  label,
  value,
  hint,
  hintClassName,
  isLoading,
}: {
  label: string
  value: string
  hint: string
  hintClassName?: string
  isLoading: boolean
}) {
  return (
    <Card size="compact" className="flex min-w-0 flex-col gap-1">
      <CardHeader>
        <CardTitle variant="label">{label}</CardTitle>
      </CardHeader>
      {isLoading ? (
        <span className="text-mcs-lg leading-none text-mcs-text-muted">—</span>
      ) : (
        <span className="mcs-num text-mcs-lg leading-none font-semibold text-mcs-text-default">
          {value}
        </span>
      )}
      <p className={cn('text-mcs-xs text-mcs-text-muted', hintClassName)}>{hint}</p>
    </Card>
  )
}

export function FleetSummary({ rows, overview, listUnavailable }: FleetSummaryProps) {
  const counts = { ready: 0, starting: 0, unknown: 0, stopped: 0, stopping: 0 }
  let players = 0
  for (const { lifecycle, status } of rows) {
    counts[lifecycle] += 1
    if (lifecycle === 'ready') players += status.playerCount
  }
  const otherStates = [
    counts.starting > 0 && `${counts.starting} 台启动中`,
    counts.unknown > 0 && `${counts.unknown} 台就绪未知`,
    counts.stopping > 0 && `${counts.stopping} 台停止中`,
    counts.stopped > 0 && `${counts.stopped} 台已停止`,
  ].filter(Boolean)
  const readyHint =
    rows.length === 0
      ? '暂无实例'
      : otherStates.length > 0
        ? otherStates.join(' · ')
        : '全部实例均已就绪'
  const playersHint = counts.ready > 0 ? `仅统计 ${counts.ready} 台已就绪实例` : '暂无已就绪实例'

  /* 内存账：可分配 = 整机总量 − 系统保留，已分配按 -Xmx 合计（不是 RSS）。
     总量读不到时不给余量数字——算不出来还说「已分完」会让人照着去卸载实例 */
  const totalMemGB = overview?.systemMemoryTotal ?? null
  const allocatableGB = hasHostMemoryTotal(totalMemGB) ? allocatableMemoryGB(totalMemGB) : null
  const memoryPercent = readHostMemoryPercent(totalMemGB, overview?.systemMemoryPercent)
  const allocatedGB = sumAllocatedGB(rows.map(({ status }) => status.maxMemory))
  const remainingGB = allocatableGB != null ? Math.max(0, allocatableGB - allocatedGB) : null
  const memoryHint =
    allocatableGB == null
      ? '整机内存读数未取到'
      : allocatedGB > allocatableGB
        ? `已分配 ${allocatedGB} GB，超出可分配量 ${allocatableGB} GB`
        : `已分配 ${allocatedGB} GB，可分配 ${allocatableGB} GB`

  return (
    /* 栅格按容器宽切档：最窄档即两列，@5xl(1024) 才四列。
       最窄档不给单列：四卡竖排实测在 375 视口吃掉约 45% 屏高，把「一眼看清全部实例」这件事
       本身挤到首屏之下——上半屏全是数字、清单要滚动才看得见。两列时每卡最窄约 165px，
       18px 档的主数值（「10.0 GB」约 70px）装得下，说明行折两行仍属元数据排版；
       四列要 @5xl 才给，否则每卡 159px 放不住「已分配 12 GB，可分配 14 GB」这句 */
    <div className="grid shrink-0 grid-cols-2 gap-3 @5xl:grid-cols-4">
      <MetricCard
        label="已就绪实例"
        value={`${counts.ready}`}
        hint={listUnavailable ? '实例清单暂不可用' : readyHint}
        isLoading={listUnavailable}
      />
      <MetricCard
        label="在线玩家"
        value={counts.ready > 0 || counts.stopped === rows.length ? `${players}` : '—'}
        hint={listUnavailable ? '实例清单暂不可用' : playersHint}
        isLoading={listUnavailable}
      />
      <MetricCard
        label="可分配内存余量"
        value={remainingGB != null ? `${remainingGB.toFixed(1)} GB` : '—'}
        hint={listUnavailable ? '实例清单暂不可用' : memoryHint}
        isLoading={listUnavailable}
      />
      <MetricCard
        label="整机负载"
        value={overview ? `${overview.systemCpuUsage.toFixed(1)}%` : '—'}
        hint={
          !overview
            ? '整机读数未取到'
            : memoryPercent == null
              ? '内存暂无数据'
              : `内存 ${memoryPercent.toFixed(1)}%`
        }
        isLoading={overview === undefined}
      />
    </div>
  )
}

/**
 * 需关注摘要（页头描述用；与清单「需关注」列同源）。
 *
 * 故障与告警分两件：故障走 StatusPill（只读状态），条数走 CountBadge（计数）——
 * 两者语义不同，合并成一枚彩色计数徽章会让「3 台需关注」在故障时也保持中性灰，
 * 而故障恰恰是这行里唯一必须抢眼的信息。
 */
export function FleetIssueSummary({ total, errors }: { total: number; errors: number }) {
  if (total === 0) {
    return <span className="text-mcs-text-muted">暂无故障或告警</span>
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {errors > 0 && (
        <StatusPill tone="error" className="text-mcs-2xs font-semibold">
          {errors} 台故障
        </StatusPill>
      )}
      <CountBadge>{total} 台需关注</CountBadge>
    </span>
  )
}
