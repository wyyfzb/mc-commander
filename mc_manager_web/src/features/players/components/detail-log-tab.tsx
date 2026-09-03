/**
 * LogTab —— 日志 Tab
 *
 * 【实现规格】
 * 1. 顶部 6 项统计卡：总在线/累计登录/已离线/死亡/进度/入睡（player.stats：totalOnline/loginCount/offlineSince/deathCount/achievementCount/sleepCount）
 *    + 「全部折叠」按钮
 * 2. 会话树时间线：
 *    - 会话节点（sessions）：登录/退出时间 + 时长，默认折叠（「登录日志N」）；展开显示会话内事件
 *    - 事件行 7 类型（player.events：join/leave/death/respawn/achievement/sleep/wake），各配语义色+图标+中文标签
 *      （语义色映射：join=success/leave=muted/death=error/respawn=info/achievement=accent/sleep=purple/wake=warning，用 --mcs-* token）
 *    - 会话间离线间隔节点「离线 · X时X分」（相邻 sessions 的 gap 计算）
 * 3. 空态：无事件/会话时提示「暂无日志数据」
 * 4. 折叠状态为本地 state；切换玩家或会话数变化时重置（索引防错位）
 * 5. 设计纪律：全部 --mcs-* token；禁硬编码色值；时间线竖线用 --mcs-border-muted
 */
import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Folder,
  History,
  LogIn,
  LogOut,
  Moon,
  RotateCcw,
  Skull,
  Star,
  Sunrise,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatClock, formatDurationSec, formatDurationSecFull, formatFullDateTime } from '@/lib/format'
import type { Player, PlayerEvent, PlayerSession } from '@/api/types'

export interface LogTabProps {
  player: Player
}

/** 树节点：会话组 或 离线间隔 */
type LogNode = SessionNode | OfflineNode

/** 登录会话节点（含会话内事件，按时间倒序） */
interface SessionNode {
  kind: 'session'
  session: PlayerSession
  /** 会话编号（正序 1 起，最新会话倒序显示在顶部） */
  labelNo: number
  events: PlayerEvent[]
}

/** 相邻会话间的离线间隔 */
interface OfflineNode {
  kind: 'offline'
  durationSec: number
  /** 间隔起点（ISO） */
  start: string
  /** 间隔终点（ISO） */
  end: string
}

/** 事件类型 → 语义色+图标+中文标签（契约映射，--mcs-* token） */
const EVENT_META: Record<string, { label: string; icon: LucideIcon; color: string; badge: string }> = {
  join: {
    label: '进入',
    icon: LogIn,
    color: 'text-mcs-success-fg',
    badge: 'border-mcs-success-border bg-mcs-success-bg-subtle',
  },
  leave: {
    label: '离开',
    icon: LogOut,
    color: 'text-mcs-text-muted',
    badge: 'border-mcs-border-muted bg-mcs-bg-muted',
  },
  death: {
    label: '死亡',
    icon: Skull,
    color: 'text-mcs-error-fg',
    badge: 'border-mcs-error-border bg-mcs-error-bg-subtle',
  },
  respawn: {
    label: '复活',
    icon: RotateCcw,
    color: 'text-mcs-info-fg',
    badge: 'border-mcs-info-border bg-mcs-info-bg-subtle',
  },
  achievement: {
    label: '获得进度',
    icon: Star,
    color: 'text-mcs-accent-fg',
    badge: 'border-mcs-accent-border bg-mcs-accent-bg-subtle',
  },
  sleep: {
    label: '入睡',
    icon: Moon,
    color: 'text-mcs-purple-fg',
    badge: 'border-mcs-purple-border bg-mcs-purple-bg-subtle',
  },
  wake: {
    label: '起床',
    icon: Sunrise,
    color: 'text-mcs-warning-fg',
    badge: 'border-mcs-warning-border bg-mcs-warning-bg-subtle',
  },
}

const EMPTY_STATS = {
  totalOnline: 0,
  loginCount: 0,
  offlineSince: 0,
  deathCount: 0,
  achievementCount: 0,
  sleepCount: 0,
}

/** 构建树节点列表（最新会话在上） */
function buildLogNodes(player: Player): LogNode[] {
  // 会话按时间正序（详情 fallback 分支可能缺 sessions 字段，? 兜底防崩溃）
  const sessions = [...(player.sessions ?? [])].sort(
    (a, b) => new Date(a.joinTime).getTime() - new Date(b.joinTime).getTime(),
  )

  const nodes: LogNode[] = []
  let prevEnd: number | null = null
  sessions.forEach((s, i) => {
    const startMs = new Date(s.joinTime).getTime()
    const endMs = s.leaveTime ? new Date(s.leaveTime).getTime() : Date.now()
    // 离线间隔：上一会话结束 到 本会话开始
    if (prevEnd !== null && startMs > prevEnd) {
      nodes.push({
        kind: 'offline',
        durationSec: Math.floor((startMs - prevEnd) / 1000),
        start: new Date(prevEnd).toISOString(),
        end: s.joinTime,
      })
    }
    // 会话内事件：时间在 [start, end] 范围内，按时间倒序。
    // leave 事件时间戳可能与会话 end 有毫秒级差异，end 加 1 秒容差确保归属。
    const events = player.events
      .filter((e) => {
        const t = new Date(e.timestamp).getTime()
        return t >= startMs && t <= endMs + 1000
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    nodes.push({ kind: 'session', session: s, labelNo: i + 1, events })
    prevEnd = endMs
  })
  // 倒序：最新会话在上
  return nodes.reverse()
}

export function LogTab({ player }: LogTabProps) {
  const nodes = buildLogNodes(player)
  // 全部会话节点的索引（节点数组倒序后按显示顺序编号）
  const sessionIndexes: number[] = []
  nodes.forEach((n, i) => {
    if (n.kind === 'session') sessionIndexes.push(i)
  })
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set(sessionIndexes))

  // 切换玩家或会话数变化时重置折叠状态（索引防错位：
  // 折叠索引按显示位置存储，不重置会套用到新会话树导致部分会话莫名折叠）
  useEffect(() => {
    setCollapsed(new Set(sessionIndexes))
    // 契约：仅 player.name 与 sessions.length 变化时重置
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- sessionIndexes 由 buildLogNodes 每次渲染重新计算（新数组引用），加入会导致 effect 每帧执行
  }, [player.name, player.sessions?.length ?? 0])

  // 空态：无会话（事件也无从归属）时整 Tab 提示
  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-mcs-md border border-mcs-border-muted px-6 py-12">
        <History className="size-6 text-mcs-text-muted" aria-hidden />
        <p className="text-mcs-sm text-mcs-text-subtle">暂无日志数据</p>
      </div>
    )
  }

  const stats = player.stats ?? EMPTY_STATS
  const allCollapsed = sessionIndexes.every((i) => collapsed.has(i))

  const toggleSession = (index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const toggleAll = () => {
    setCollapsed(allCollapsed ? new Set() : new Set(sessionIndexes))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── 统计卡 6 项 + 「全部折叠」── */}
      <div className="rounded-mcs-md border border-mcs-border-muted p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="grid flex-1 grid-cols-3 gap-2">
            <StatCell label="总在线" value={formatDurationSec(stats.totalOnline)} />
            <StatCell label="累计登录" value={`${stats.loginCount} 次`} />
            <StatCell label="已离线" value={formatDurationSec(stats.offlineSince)} color="text-mcs-text-subtle" />
            <StatCell label="死亡" value={`${stats.deathCount} 次`} color="text-mcs-error-fg" />
            <StatCell label="进度" value={`${stats.achievementCount} 个`} color="text-mcs-accent-fg" />
            <StatCell label="入睡" value={`${stats.sleepCount} 次`} color="text-mcs-info-fg" />
          </div>
          <Button variant="outline" size="xs" onClick={toggleAll} className="shrink-0">
            {allCollapsed ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
            {allCollapsed ? '全部展开' : '全部折叠'}
          </Button>
        </div>
      </div>

      {/* ── 会话树时间线 ── */}
      <div className="flex flex-col gap-0.5">
        {nodes.map((node, i) =>
          node.kind === 'session' ? (
            <SessionRow
              key={`session-${i}`}
              node={node}
              index={i}
              collapsed={collapsed.has(i)}
              onToggle={toggleSession}
            />
          ) : (
            <OfflineRow key={`offline-${i}`} node={node} />
          ),
        )}
      </div>
    </div>
  )
}

/** 会话节点：标题行（可折叠）+ 会话内事件（时间线竖线 border-mcs-border-muted） */
function SessionRow({
  node,
  index,
  collapsed,
  onToggle,
}: {
  node: SessionNode
  index: number
  collapsed: boolean
  onToggle: (index: number) => void
}) {
  const { session, labelNo, events } = node
  const endLabel = session.leaveTime ? formatClock(session.leaveTime) : '现在'
  const title =
    `登录日志${labelNo} ${formatClock(session.joinTime)} → ${endLabel} · ` + formatDurationSec(session.duration)

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => onToggle(index)}
        className="flex w-full items-center gap-1.5 rounded-mcs-xs px-1.5 py-1 text-left hover:bg-mcs-bg-hover"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-mcs-text-muted" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-mcs-text-muted" aria-hidden />
        )}
        <Folder className="size-3.5 shrink-0 text-mcs-warning-fg" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-mcs-sm font-medium text-mcs-text-default">{title}</span>
      </button>
      {!collapsed && (
        <div className="ml-4 border-l border-mcs-border-muted pl-3 pb-1">
          {events.length === 0 ? (
            <p className="py-1 text-mcs-xs italic text-mcs-text-subtle">（无事件记录）</p>
          ) : (
            events.map((e, i) => <EventRow key={i} event={e} />)
          )}
        </div>
      )}
    </div>
  )
}

/** 单个事件行：图标 + 标签 + 消息 + 完整时间（语义色按契约映射） */
function EventRow({ event }: { event: PlayerEvent }) {
  const meta = EVENT_META[event.type] ?? { label: '事件', icon: Circle, color: 'text-mcs-text-muted', badge: 'border-mcs-border-muted bg-mcs-bg-muted' }
  const Icon = meta.icon
  // 成就/挑战消息去前缀（JS String.replace 仅替换首个匹配）
  const message =
    event.type === 'achievement'
      ? event.message.replace('获得成就: ', '').replace('完成挑战: ', '')
      : event.message
  // 完成挑战 vs 获得进度
  const label = event.type === 'achievement' && event.message.includes('完成挑战') ? '完成挑战' : meta.label

  return (
    <div className="flex items-center gap-1.5 py-1">
      <Icon className={`size-3 shrink-0 ${meta.color}`} aria-hidden />
      <span
        className={`rounded-mcs-xs border px-1.5 py-px text-mcs-2xs font-semibold ${meta.color} ${meta.badge}`}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-text-default">{message}</span>
      <span className="shrink-0 font-mono text-mcs-2xs text-mcs-text-subtle">{formatFullDateTime(event.timestamp)}</span>
    </div>
  )
}

/** 离线间隔节点：离线标签 + 时长 + 起止时刻 */
function OfflineRow({ node }: { node: OfflineNode }) {
  return (
    <div className="flex items-center gap-1.5 py-1 pl-1.5">
      <Circle className="size-3 shrink-0 text-mcs-text-muted" aria-hidden />
      <span className="rounded-mcs-xs border border-mcs-border-muted bg-mcs-bg-muted px-1.5 py-px text-mcs-2xs font-semibold text-mcs-text-muted">
        离线
      </span>
      <span className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-text-muted">
        离线 · {formatDurationSecFull(node.durationSec)}
      </span>
      <span className="shrink-0 font-mono text-mcs-2xs text-mcs-text-subtle">
        {formatClock(node.start)} ~ {formatClock(node.end)}
      </span>
    </div>
  )
}

/** 统计卡：标签 + 数值（语义色可覆盖） */
function StatCell({ label, value, color = 'text-mcs-text-default' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-mcs-xs bg-mcs-bg-muted px-2 py-1.5">
      <span className="text-mcs-2xs text-mcs-text-subtle">{label}</span>
      <span className={`truncate font-mono text-mcs-sm font-medium tabular-nums ${color}`}>{value}</span>
    </div>
  )
}
