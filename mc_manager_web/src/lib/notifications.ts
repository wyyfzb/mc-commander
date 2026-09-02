/**
 * 通知系统纯逻辑
 * - WS 事件 → 中文文案模板
 * - 聚合去重：内容聚合 60s / 实体聚合 30s / critical 类不聚合
 * - 告警（TPS/CPU/内存）：阈值 80% 可配，状态跃迁单次通知
 * 纯函数设计：无 I/O、无依赖，Vitest 直接单测
 */

export type NotificationCategory = 'game' | 'server' | 'management'

export type NotificationType =
  | 'join' | 'leave' | 'death' | 'revive' | 'achievement' | 'chat' | 'sleep'
  | 'serverStart' | 'serverStop' | 'serverCrash' | 'save'
  | 'lowTps' | 'highCpu' | 'highMemory' | 'weatherChange'
  | 'backupStart' | 'backupComplete' | 'backupFailed' | 'backupSkipped'
  | 'restoreStart' | 'restoreComplete' | 'restoreFailed'
  | 'taskFailed'
  | 'webhookFailed'

export interface AppNotification {
  id: string
  type: NotificationType
  category: NotificationCategory
  content: string
  timestamp: number
  count: number
  read: boolean
}

/** 通知严重度（严重/警告/提示；行内即时反馈分级） */
export type NotificationSeverity = 'severe' | 'warning' | 'info'

/** 通知类型元数据：中文标签 + 分类 + 严重度 */
export const NOTIFICATION_TYPE_META: Record<
  NotificationType,
  { label: string; category: NotificationCategory; severity: NotificationSeverity }
> = {
  join: { label: '进入', category: 'game', severity: 'info' },
  leave: { label: '离开', category: 'game', severity: 'info' },
  death: { label: '死亡', category: 'game', severity: 'info' },
  revive: { label: '复活', category: 'game', severity: 'info' },
  achievement: { label: '成就', category: 'game', severity: 'info' },
  chat: { label: '聊天', category: 'game', severity: 'info' },
  sleep: { label: '入睡/醒来', category: 'game', severity: 'info' },
  serverStart: { label: '启动', category: 'server', severity: 'info' },
  serverStop: { label: '停止', category: 'server', severity: 'warning' },
  serverCrash: { label: '崩溃', category: 'server', severity: 'severe' },
  save: { label: '保存', category: 'server', severity: 'info' },
  lowTps: { label: 'TPS 过低', category: 'server', severity: 'warning' },
  highCpu: { label: 'CPU 过高', category: 'server', severity: 'warning' },
  highMemory: { label: '内存过高', category: 'server', severity: 'warning' },
  weatherChange: { label: '天气变化', category: 'server', severity: 'info' },
  backupStart: { label: '备份开始', category: 'server', severity: 'info' },
  backupComplete: { label: '备份完成', category: 'server', severity: 'info' },
  backupFailed: { label: '备份失败', category: 'server', severity: 'severe' },
  backupSkipped: { label: '备份已跳过', category: 'server', severity: 'warning' },
  restoreStart: { label: '恢复开始', category: 'server', severity: 'severe' },
  restoreComplete: { label: '恢复完成', category: 'server', severity: 'info' },
  restoreFailed: { label: '恢复失败', category: 'server', severity: 'severe' },
  taskFailed: { label: '任务失败', category: 'server', severity: 'severe' },
  webhookFailed: { label: 'Webhook 投递失败', category: 'server', severity: 'severe' },
}

/** 设置页显示顺序：game 组在前、server 组在后 */
export const NOTIFICATION_TYPE_ORDER: NotificationType[] = Object.keys(
  NOTIFICATION_TYPE_META,
) as NotificationType[]

/** critical 类：不参与聚合，每次都独立通知 */
const CRITICAL_TYPES: ReadonlySet<NotificationType> = new Set([
  'serverCrash', 'backupFailed', 'restoreFailed', 'taskFailed', 'webhookFailed',
])

/** 告警类型集合（阈值跃迁语义，需 _activeAlerts 状态机） */
export type AlertType = 'lowTps' | 'highCpu' | 'highMemory'

/** 天气英文 → 中文 */
const WEATHER_ZH: Record<string, string> = { clear: '晴天', rain: '雨天', thunder: '雷暴' }

/** 备份/恢复类缺省文案（与服务端事件语义一致） */
const BACKUP_CONTENT: Record<string, string> = {
  backupStart: '备份开始',
  backupComplete: '备份完成',
  backupFailed: '备份失败',
  backupSkipped: '定时备份已跳过（上一备份仍在进行）',
  restoreStart: '开始恢复备份',
  restoreComplete: '备份已恢复，请启动服务器生效',
  restoreFailed: '恢复失败',
}

export interface WsEventInput {
  type: string
  data?: Record<string, unknown> | null
  eventId?: number
  instanceId?: string
  timestamp?: number
}

export interface AlertThresholds {
  tpsWarning?: number    // 预留：百分比语义（当前实现走 tpsLow）
  cpuWarning: number
  memoryWarning: number
  tpsLow: number         // TPS 低于此值告警
}

/** 默认告警阈值（cpu/memory 80；TPS 走 tpsLow 绝对值） */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  cpuWarning: 80,
  memoryWarning: 80,
  tpsLow: 15, // TPS <15 告警（与统计卡"卡顿"阈值 15 对齐）
}

/**
 * 事件 → 通知（可能返回多条：团灭聚合事件逐条生成）。
 * 返回空数组表示该事件不生成通知（告警阈值判断见 buildAlertNotifications）。
 */
export function buildNotifications(
  event: WsEventInput,
): Omit<AppNotification, 'id' | 'timestamp' | 'count' | 'read'>[] {
  const d = (event.data ?? {}) as Record<string, unknown>
  const type = event.type

  switch (type) {
    case 'playerJoin':
      return [{ type: 'join', category: 'game', content: `${d.name} 加入了游戏` }]
    case 'playerLeave':
      return [{ type: 'leave', category: 'game', content: `${d.name} 离开了游戏` }]
    case 'playerDeath': {
      // 团灭聚合事件 {players:[{name,cause}], count:N} 逐条生成
      const players = d.players as Array<{ name: string; cause?: string }> | undefined
      if (Array.isArray(players)) {
        return players.map((p) => ({
          type: 'death', category: 'game', content: `${p.name} ${p.cause ?? ''}`.trim(),
        }))
      }
      return [{ type: 'death', category: 'game', content: `${d.name} ${d.cause ?? ''}`.trim() }]
    }
    case 'playerRespawn':
      return [{ type: 'revive', category: 'game', content: `${d.name} 已重生` }]
    case 'achievement':
      return [{
        type: 'achievement', category: 'game',
        content: `${d.name} ${d.isChallenge ? '完成了挑战' : '获得了成就'} [${d.advancement}]`,
      }]
    case 'playerChat':
      return [{ type: 'chat', category: 'game', content: `${d.name}: ${d.message}` }]
    case 'playerSleep':
      return [{
        type: 'sleep', category: 'game',
        content: d.sleeping ? `${d.name} 入睡了` : `${d.name} 醒来了`,
      }]
    case 'status': {
      const ev = d.event as string | undefined
      if (ev === 'started') {
        return [{ type: 'serverStart', category: 'server', content: '服务器已启动' }]
      }
      if (ev === 'ready') {
        return [{ type: 'serverStart', category: 'server', content: '服务器已就绪' }]
      }
      if (ev === 'stopped') {
        return [{ type: 'serverStop', category: 'server', content: '服务器已停止' }]
      }
      if (ev === 'crash') {
        return [{
          type: 'serverCrash', category: 'server',
          content: d.autoRestart ? '服务器意外退出，正在自动重启' : '服务器意外退出',
        }]
      }
      if (ev === 'save') {
        return [{ type: 'save', category: 'server', content: '世界已保存' }]
      }
      return []
    }
    case 'weatherUpdate': {
      const zh = WEATHER_ZH[String(d.weather)] ?? String(d.weather)
      return [{ type: 'weatherChange', category: 'server', content: `天气变为${zh}` }]
    }
    case 'taskFailed': {
      const errText = d.error ? `: ${d.error}` : ''
      return [{
        type: 'taskFailed', category: 'server',
        content: `定时任务「${String(d.taskName ?? '未命名')}」执行失败${errText}`,
      }]
    }
    case 'webhookDeliveryFailed': {
      const name = String(d.webhookName ?? '未命名 Webhook')
      return [{
        type: 'webhookFailed', category: 'server',
        content: `Webhook「${name}」投递失败（重试耗尽）`,
      }]
    }
    default: {
      if (type in BACKUP_CONTENT) {
        return [{
          type: type as NotificationType, category: 'server', content: BACKUP_CONTENT[type]!,
        }]
      }
      return []
    }
  }
}

/**
 * 告警状态机：performanceUpdate → TPS/CPU/内存告警（状态跃迁单次）。
 * activeAlerts：当前激活的告警集合（传入并原地感知，返回新的激活集合与新增通知）。
 */
export function buildAlertNotifications(
  perf: { tps?: number | null; cpu?: number | null; memoryPercent?: number | null },
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  activeAlerts: ReadonlySet<AlertType> = new Set(),
): { notifications: Omit<AppNotification, 'id' | 'timestamp' | 'count' | 'read'>[]; activeAlerts: Set<AlertType> } {
  const next = new Set(activeAlerts)
  const notifications: Omit<AppNotification, 'id' | 'timestamp' | 'count' | 'read'>[] = []
  const tps = perf.tps
  const cpu = perf.cpu
  const mem = perf.memoryPercent

  // TPS 告警（低于阈值 → 告警；恢复 → 恢复通知）
  if (tps != null) {
    if (tps < (thresholds.tpsLow ?? 15)) {
      if (!next.has('lowTps')) {
        next.add('lowTps')
        notifications.push({ type: 'lowTps', category: 'server', content: `TPS 过低: ${tps.toFixed(1)}` })
      }
    } else if (next.has('lowTps')) {
      next.delete('lowTps')
      notifications.push({ type: 'lowTps', category: 'server', content: 'TPS 已恢复正常' })
    }
  }

  if (cpu != null) {
    if (cpu > thresholds.cpuWarning) {
      if (!next.has('highCpu')) {
        next.add('highCpu')
        notifications.push({ type: 'highCpu', category: 'server', content: `CPU 使用率过高: ${cpu.toFixed(1)}%` })
      }
    } else if (next.has('highCpu')) {
      next.delete('highCpu')
      notifications.push({ type: 'highCpu', category: 'server', content: 'CPU 使用率已恢复正常' })
    }
  }

  if (mem != null) {
    if (mem > thresholds.memoryWarning) {
      if (!next.has('highMemory')) {
        next.add('highMemory')
        notifications.push({ type: 'highMemory', category: 'server', content: `内存使用率过高: ${mem.toFixed(1)}%` })
      }
    } else if (next.has('highMemory')) {
      next.delete('highMemory')
      notifications.push({ type: 'highMemory', category: 'server', content: '内存使用率已恢复正常' })
    }
  }

  return { notifications, activeAlerts: next }
}

/**
 * 聚合去重：
 * - 内容聚合：同类型同内容 60s → count++
 * - 实体聚合：`type|玩家名（或内容冒号前缀）` 30s → count++
 * - critical 类不聚合
 * 返回新的通知列表（不可变更新；命中条目的 count/timestamp 已更新）
 */
export function aggregateNotifications(
  existing: AppNotification[],
  incoming: Omit<AppNotification, 'id' | 'timestamp' | 'count' | 'read'>,
  now: number,
): AppNotification[] {
  if (CRITICAL_TYPES.has(incoming.type)) {
    return [
      { ...incoming, id: crypto.randomUUID(), timestamp: now, count: 1, read: false },
      ...existing,
    ]
  }

  // 内容聚合键（60s 窗口）
  const contentKey = `${incoming.type}|${incoming.content}`
  const contentHit = existing.find(
    (n) => `${n.type}|${n.content}` === contentKey && now - n.timestamp < 60_000,
  )
  if (contentHit) {
    return existing.map((n) =>
      n.id === contentHit.id ? { ...n, count: n.count + 1, timestamp: now } : n,
    )
  }

  // 实体聚合键（30s 窗口）：玩家名优先，其次内容冒号前缀
  const playerName = incoming.content.split(' ')[0]
  const entityKey = playerName
    ? `${incoming.type}|${playerName}`
    : `${incoming.type}|${incoming.content.split(':')[0] ?? incoming.content}`
  const entityHit = existing.find(
    (n) => {
      const nName = n.content.split(' ')[0]
      const nKey = nName ? `${n.type}|${nName}` : `${n.type}|${n.content.split(':')[0] ?? n.content}`
      return nKey === entityKey && now - n.timestamp < 30_000
    },
  )
  if (entityHit) {
    return existing.map((n) =>
      n.id === entityHit.id ? { ...n, count: n.count + 1, timestamp: now } : n,
    )
  }

  return [
    { ...incoming, id: crypto.randomUUID(), timestamp: now, count: 1, read: false },
    ...existing,
  ]
}

/** 通知持久化上限（200 条；每 5 分钟清理到 100 条） */
export const MAX_PERSISTED_NOTIFICATIONS = 200
export const CLEANUP_TARGET = 100

export function trimNotifications(list: AppNotification[], limit = MAX_PERSISTED_NOTIFICATIONS): AppNotification[] {
  return list.length > limit ? list.slice(0, limit) : list
}
