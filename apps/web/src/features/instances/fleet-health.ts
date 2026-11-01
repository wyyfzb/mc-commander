/**
 * 实例总览的健康判定与排序（本域唯一声明源）。
 *
 * 只回答一件事：这台实例现在要不要人管。一行实例事实最多贡献一条结论，取其中最严重的
 * 一条——清单每行只留一格位置，并列多条会把「需关注」列读成一串噪音。
 *
 * TPS 分级与阈值取自既有唯一声明源，不在这里另写一份：卡片说健康、总览说卡顿属同一类漂移。
 */
import { TPS_HEALTHY_MIN, tpsLevel } from '@/lib/mc-tps'
import { instanceLabel } from '@/lib/instance-label'
import type { InstanceStatus } from '@/api/types'

export type FleetIssueLevel = 'error' | 'warning'

export interface FleetIssue {
  level: FleetIssueLevel
  /** 可见短标签（表格「需关注」列与窄容器摘要行共用） */
  label: string
  /** 完整说明：只作 title 与读屏文本，不进可见排版 */
  description: string
}

/**
 * 严重度序：error 必须先于 warning。同档内运行中排在已停止之前——停着的实例再糟也占不到人，
 * 运行中的才是此刻要处理的。
 */
const LEVEL_RANK: Record<FleetIssueLevel, number> = { error: 0, warning: 1 }

export function fleetIssue(status: InstanceStatus): FleetIssue | null {
  if (status.circuitBreakerTripped) {
    return {
      level: 'error',
      label: '崩溃熔断',
      description: `连续崩溃 ${status.consecutiveCrashes} 次后自动重启已被禁用，需要人工处理`,
    }
  }
  // 未运行时 tps 是上一次运行的残留读数，拿它判卡顿会把停着的实例整片标成故障
  if (status.isRunning) {
    const level = tpsLevel(status.tps)
    if (level !== 'healthy') {
      const critical = level === 'critical'
      return {
        level: critical ? 'error' : 'warning',
        label: critical ? '严重卡顿' : 'TPS 偏低',
        description: `TPS ${status.tps.toFixed(1)}，低于健康线 ${TPS_HEALTHY_MIN}`,
      }
    }
  }
  if (status.consecutiveCrashes > 0) {
    return {
      level: 'warning',
      label: '近期崩溃',
      description: `近期崩溃 ${status.consecutiveCrashes} 次，尚未达到熔断阈值`,
    }
  }
  if (status.reachability === 'blocked') {
    return {
      level: 'warning',
      label: '连不进来',
      description: '本地已在监听，但外网连不进来；需要在云控制台放行这个端口',
    }
  }
  return null
}

export interface FleetRow {
  status: InstanceStatus
  issue: FleetIssue | null
}

/** 排序档：故障 → 告警 → 健康运行 → 已停止 */
function rankOf(row: FleetRow): number {
  if (row.issue) return LEVEL_RANK[row.issue.level]
  return row.status.isRunning ? 2 : 3
}

/**
 * 按「要人管的程度」排序：故障 → 告警 → 健康运行 → 已停止，同档按展示名。
 * 页头与横幅必须交代这条顺序——静默重排会让用户以为清单漏了实例。
 */
export function buildFleetRows(instances: readonly InstanceStatus[]): FleetRow[] {
  return instances
    .map((status) => ({ status, issue: fleetIssue(status) }))
    .sort((a, b) => {
      const diff = rankOf(a) - rankOf(b)
      if (diff !== 0) return diff
      const byName = instanceLabel(a.status).localeCompare(instanceLabel(b.status), 'zh')
      return byName !== 0 ? byName : a.status.id.localeCompare(b.status.id)
    })
}

/**
 * 窄容器下的单行摘要（替代被隐藏的四列指标）。
 *
 * 刻意写成以单位收尾的省略式状态行，而不是句子：它占的是实例名下方一行 10px 角标位，
 * 换成完整句就必然溢出或折行，而折行后每行实例高度不再一致，清单的可扫读性就没了。
 */
export function fleetRowSummary(status: InstanceStatus): string {
  if (!status.isRunning) return status.mcVersion ? `已停止 · ${status.mcVersion}` : '已停止'
  const parts = [`${status.playerCount} 人在线`, `TPS ${status.tps.toFixed(1)}`]
  if (status.memoryUsage > 0) parts.push(`内存 ${status.memoryUsage} GB`)
  return parts.join(' · ')
}

/** 需关注条数（页头描述与告警横幅同源，避免两处各数一遍） */
export function countIssues(rows: readonly FleetRow[]): { total: number; errors: number } {
  let total = 0
  let errors = 0
  for (const row of rows) {
    if (!row.issue) continue
    total += 1
    if (row.issue.level === 'error') errors += 1
  }
  return { total, errors }
}
