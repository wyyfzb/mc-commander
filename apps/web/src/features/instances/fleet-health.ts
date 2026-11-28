/**
 * 实例总览的健康判定与排序（本域唯一声明源）。
 *
 * 只回答一件事：这台实例现在要不要人管。一行实例事实最多贡献一条结论，取其中最严重的
 * 一条——清单每行只留一格位置，并列多条会把「需关注」列读成一串噪音。
 *
 * TPS 分级与阈值取自既有唯一声明源，不在这里另写一份：卡片说健康、总览说卡顿属同一类漂移。
 */
import { AUTO_START_PAUSED_TEXT, SERVER_STARTING_TEXT } from '@/lib/notifications'
import { TPS_HEALTHY_MIN, tpsLevel } from '@/lib/mc-tps'
import { instanceLabel, STARTUP_STATE_LABELS } from '@/lib/instance-label'
import type { InstanceStatus } from '@/api/types'
import type { InstancePhase } from '@/stores/server'

type InstanceLifecycle = InstanceStatus['startupState'] | 'stopping'

export const INSTANCE_LIFECYCLE = {
  stopped: { label: STARTUP_STATE_LABELS.stopped, tone: 'muted' },
  starting: { label: STARTUP_STATE_LABELS.starting, tone: 'default' },
  ready: { label: STARTUP_STATE_LABELS.ready, tone: 'success' },
  unknown: { label: STARTUP_STATE_LABELS.unknown, tone: 'muted' },
  stopping: { label: '停止中', tone: 'default' },
} as const satisfies Record<InstanceLifecycle, { label: string; tone: string }>

export function instanceLifecycle(
  status: Pick<InstanceStatus, 'startupState'>,
  phase?: InstancePhase | null,
): InstanceLifecycle {
  if (phase === 'stopping') return 'stopping'
  // 本地启动指令仅填补列表仍显示「已停止」的窗口，不能盖过服务端的就绪确认。
  if (phase === 'starting' && status.startupState === 'stopped') return 'starting'
  return status.startupState
}

export type FleetIssueLevel = 'error' | 'warning'

export interface FleetIssue {
  level: FleetIssueLevel
  /** 可见短标签（表格「需关注」列与窄容器摘要行共用） */
  label: string
  /** 完整说明：只作 title 与读屏文本，不进可见排版 */
  description: string
}

const LEVEL_RANK: Record<FleetIssueLevel, number> = { error: 0, warning: 1 }

export function fleetIssue(
  status: InstanceStatus,
  lifecycle = instanceLifecycle(status),
): FleetIssue | null {
  if (status.circuitBreakerTripped) {
    if (status.checkingStartupStability) {
      return {
        level: 'error',
        label: '确认稳定中',
        description: '正在确认服务器能否稳定运行',
      }
    }
    if (lifecycle === 'starting') {
      return { level: 'error', label: '试启中', description: SERVER_STARTING_TEXT }
    }
    return { level: 'error', label: '反复退出', description: AUTO_START_PAUSED_TEXT }
  }
  // 就绪前的 TPS 和可达性可能是初值或上一轮进程的读数。
  if (lifecycle === 'ready' && status.tps != null) {
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
      description: `近期崩溃 ${status.consecutiveCrashes} 次`,
    }
  }
  if (lifecycle === 'ready' && status.reachability === 'blocked') {
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
  lifecycle: InstanceLifecycle
  issue: FleetIssue | null
}

function rankOf(row: FleetRow): number {
  if (row.issue) return LEVEL_RANK[row.issue.level]
  if (row.lifecycle === 'ready') return 2
  return row.lifecycle === 'stopped' ? 4 : 3
}

/** 按故障 → 告警 → 已就绪 → 过渡或未知 → 已停止排序，同档按展示名。 */
export function buildFleetRows(
  instances: readonly InstanceStatus[],
  phases?: Record<string, InstancePhase>,
): FleetRow[] {
  return instances
    .map((status) => {
      const lifecycle = instanceLifecycle(status, phases?.[status.id])
      return { status, lifecycle, issue: fleetIssue(status, lifecycle) }
    })
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
export function fleetRowSummary(
  status: InstanceStatus,
  lifecycle = instanceLifecycle(status),
): string {
  const parts: string[] = []
  if (lifecycle === 'ready') {
    parts.push(`${status.playerCount} 人在线`)
    if (status.tps != null) parts.push(`TPS ${status.tps.toFixed(1)}`)
  }
  if (status.isRunning && status.memoryUsage > 0) parts.push(`内存 ${status.memoryUsage} GB`)
  if (lifecycle !== 'ready' && status.mcVersion) parts.push(status.mcVersion)
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
