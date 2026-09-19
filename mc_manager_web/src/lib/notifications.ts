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
  | 'serverStart' | 'serverStop' | 'serverCrash' | 'save' | 'circuitBreaker'
  | 'lowTps' | 'highCpu' | 'highMemory' | 'weatherChange'
  | 'backupStart' | 'backupComplete' | 'backupFailed' | 'backupSkipped'
  | 'backupCancelled'
  | 'restoreStart' | 'restoreComplete' | 'restoreFailed' | 'restoreCancelled'
  | 'taskFailed'
  | 'webhookFailed'
  | 'deployComplete' | 'deployFailed' | 'deployCancelled'
  | 'upgradeComplete' | 'upgradeFailed' | 'upgradeCancelled'

export interface AppNotification {
  id: string
  type: NotificationType
  category: NotificationCategory
  content: string
  timestamp: number
  count: number
  read: boolean
  /** 关联实例（server 类事件携带；通知条目据此跳转实例页） */
  instanceId?: string
  /**
   * 服务端事件身份（`evt-<notification_events.id>-<事件内序号>`）。
   * 同一条事件在多个标签页各生成一份条目（id 是各自 randomUUID），
   * 跨标签合并靠本字段把它们认成同一条，否则会各留一份重复条目。
   * 由前端按事件直接生成的告警（TPS/CPU/内存阈值）没有服务端事件，故缺省。
   */
  eventKey?: string
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
  circuitBreaker: { label: '熔断保护', category: 'server', severity: 'severe' },
  save: { label: '保存', category: 'server', severity: 'info' },
  lowTps: { label: 'TPS 过低', category: 'server', severity: 'warning' },
  highCpu: { label: 'CPU 过高', category: 'server', severity: 'warning' },
  highMemory: { label: '内存过高', category: 'server', severity: 'warning' },
  weatherChange: { label: '天气变化', category: 'server', severity: 'info' },
  backupStart: { label: '备份开始', category: 'server', severity: 'info' },
  backupComplete: { label: '备份完成', category: 'server', severity: 'info' },
  backupFailed: { label: '备份失败', category: 'server', severity: 'severe' },
  backupSkipped: { label: '备份已跳过', category: 'server', severity: 'warning' },
  // 用户主动取消不是故障：severity 保持 info，不进严重告警档（与 deploy/upgrade 取消同口径）
  backupCancelled: { label: '备份已取消', category: 'server', severity: 'info' },
  restoreStart: { label: '恢复开始', category: 'server', severity: 'severe' },
  restoreComplete: { label: '恢复完成', category: 'server', severity: 'info' },
  restoreFailed: { label: '恢复失败', category: 'server', severity: 'severe' },
  // 同上：用户主动取消，info 档
  restoreCancelled: { label: '恢复已取消', category: 'server', severity: 'info' },
  taskFailed: { label: '任务失败', category: 'server', severity: 'severe' },
  webhookFailed: { label: 'Webhook 投递失败', category: 'server', severity: 'severe' },
  deployComplete: { label: '部署完成', category: 'server', severity: 'info' },
  deployFailed: { label: '部署失败', category: 'server', severity: 'severe' },
  // 用户主动取消不是故障：severity 保持 info，避免进「严重告警」筛选与聚合告警面
  deployCancelled: { label: '部署已取消', category: 'server', severity: 'info' },
  upgradeComplete: { label: '升级完成', category: 'server', severity: 'info' },
  upgradeFailed: { label: '升级失败', category: 'server', severity: 'severe' },
  // 用户主动取消不是故障：severity 保持 info，不进严重告警档
  upgradeCancelled: { label: '升级已取消', category: 'server', severity: 'info' },
}

/** 设置页显示顺序：game 组在前、server 组在后 */
export const NOTIFICATION_TYPE_ORDER: NotificationType[] = Object.keys(
  NOTIFICATION_TYPE_META,
) as NotificationType[]

/** critical 类：不参与聚合，每次都独立通知 */
const CRITICAL_TYPES: ReadonlySet<NotificationType> = new Set([
  'serverCrash', 'circuitBreaker', 'backupFailed', 'restoreFailed', 'taskFailed', 'webhookFailed',
  'deployFailed', 'upgradeFailed',
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

/**
 * 默认告警阈值（cpu/memory 80；TPS 走 tpsLow 绝对值）。
 * `cpuWarning` 作用于 `performanceUpdate` 的**进程** CPU，口径＝占**单核**百分比
 * （累计 CPU 秒差 ÷ 墙钟秒；多核进程可 >100%，服务端截断到 100）。服务端出处与
 * 「不按核数归一」的理由见 `mc_commander_server/services/mc-server/stats-collector.js`
 * 的 `_applyCpuSecondsSample`——归一会把「主线程打满」的真实告警抹成 100/核数。
 * 与 Dashboard CPU 卡的**整机**口径（`systemStats.cpuUsage`，/proc/stat 差分，
 * `features/dashboard/components/stat-cards.tsx`）不同源，两者不可互换或互为后备。
 */
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
      if (ev === 'circuit_breaker') {
        const crashes = Number(d.consecutiveCrashes ?? 0)
        return [{
          type: 'circuitBreaker', category: 'server',
          content: `连续崩溃 ${crashes} 次，已触发熔断保护（自动重启暂停，请检查日志）`,
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
    // 长任务终态（issue 352）：部署完成前实例未入库，实例名由 payload 携带；
    // 升级终态的服务端 payload 同样补了 instanceName
    case 'deployComplete':
      return [{
        type: 'deployComplete', category: 'server',
        content: `实例「${String(d.instanceName ?? '未命名')}」部署完成`,
      }]
    case 'deployFailed':
      return [{
        type: 'deployFailed', category: 'server',
        content: `实例「${String(d.instanceName ?? '未命名')}」部署失败：${String(d.error || '未知错误')}`,
      }]
    case 'deployCancelled':
      // 不宣称「已清理」：服务端收尾是 best-effort，清理未完成时把明细一并带出
      return [{
        type: 'deployCancelled', category: 'server',
        content: `实例「${String(d.instanceName ?? '未命名')}」部署已取消${d.error ? `：${String(d.error)}` : ''}`,
      }]
    case 'upgradeComplete':
      return [{
        type: 'upgradeComplete', category: 'server',
        content: `实例「${String(d.instanceName ?? '未命名')}」升级完成`,
      }]
    case 'upgradeFailed':
      return [{
        type: 'upgradeFailed', category: 'server',
        content: `实例「${String(d.instanceName ?? '未命名')}」${String(d.detail || '升级失败')}`,
      }]
    case 'upgradeCancelled':
      // detail 由服务端给（含「是否已回滚到旧版本」），故这里直接透传
      return [{
        type: 'upgradeCancelled', category: 'server',
        content: `实例「${String(d.instanceName ?? '未命名')}」${String(d.detail || '升级已取消')}`,
      }]
    // 备份/恢复取消走显式分支（不落 BACKUP_CONTENT 静态表）：恢复取消的
    // 服务端 content 会区分「原数据已回滚」与「回滚失败请人工检查」，
    // 静态文案会把后者这类危险明细吞掉
    case 'backupCancelled':
      return [{
        type: 'backupCancelled', category: 'server',
        content: String(d.content || '备份已取消'),
      }]
    case 'restoreCancelled':
      return [{
        type: 'restoreCancelled', category: 'server',
        content: String(d.content || '恢复已取消'),
      }]
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
        notifications.push({ type: 'highCpu', category: 'server', content: `CPU 使用率过高: ${cpu.toFixed(1)}%（单核口径）` })
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

/**
 * 跨标签合并（多标签页各自持有内存副本、每次变更整体写回，会互相覆盖）：
 * - 身份：优先 `eventKey`（服务端事件身份，同一事件在各标签页携带同一个值），
 *   没有它的条目退回 `id`。条目 `id` 是各标签页各自 randomUUID 出来的，
 *   只按 id 合并会把「同一条事件的两份副本」当成两条独立条目留下
 * - 同身份：保留先到者（本地）的 id/内容，read 取并集、count/timestamp 取较大值
 *   （三者都只单调增长，取并集即不回退）
 * - 严格早于 `clearedAt` 的条目剔除：清空是唯一「删」语义，没有这个墓碑，
 *   另一标签内存里的旧副本会在它下次写回时把已清空的列表复活。
 *   比较取严格小于而非小于等于——清空与新通知可能落在同一毫秒，用 `<=` 会把
 *   清空后立刻产生的通知一并吞掉（代价是该毫秒内既有的条目理论上可被旧副本带回，
 *   窗口 1ms 且要求用户在同一毫秒内既收到通知又清空，按可忽略处理；
 *   客户端时钟回拨同样会让新条目落入清空点之前而被剔除，不另设防护）
 * - 顺序：本标签顺序为基准（运行期顺序即「新在前」，聚合只抬计数不挪位，
 *   重排会让正在看抽屉的用户看到列表自己跳动），本标签没有的远端条目排在最前
 */
export function mergeNotifications(
  local: AppNotification[],
  remote: AppNotification[],
  clearedAt = 0,
  limit = MAX_PERSISTED_NOTIFICATIONS,
): AppNotification[] {
  const identity = (n: AppNotification) => (n.eventKey ? `k:${n.eventKey}` : `i:${n.id}`)
  const absorb = (a: AppNotification, b: AppNotification): AppNotification => ({
    ...a,
    read: a.read || b.read,
    count: Math.max(a.count, b.count),
    timestamp: Math.max(a.timestamp, b.timestamp),
  })

  const merged: AppNotification[] = []
  const at = new Map<string, number>()
  const addLocal = (n: AppNotification) => {
    if (n.timestamp < clearedAt) return
    const key = identity(n)
    const hit = at.get(key)
    if (hit === undefined) {
      at.set(key, merged.length)
      merged.push(n)
      return
    }
    merged[hit] = absorb(merged[hit]!, n)
  }
  for (const n of local) addLocal(n)

  const ahead: AppNotification[] = []
  const aheadAt = new Map<string, number>()
  for (const n of remote) {
    if (n.timestamp < clearedAt) continue
    const key = identity(n)
    const hit = at.get(key)
    if (hit !== undefined) {
      merged[hit] = absorb(merged[hit]!, n)
      continue
    }
    const aheadHit = aheadAt.get(key)
    if (aheadHit === undefined) {
      aheadAt.set(key, ahead.length)
      ahead.push(n)
      continue
    }
    ahead[aheadHit] = absorb(ahead[aheadHit]!, n)
  }

  return [...ahead, ...merged].slice(0, limit)
}
