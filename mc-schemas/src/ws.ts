import { z } from 'zod'

export const WS_EVENT_TYPES = [
  'log',
  'statusSnapshot',
  'statusEvent',
  'performanceUpdate',
  'weatherUpdate',
  'worldUpgrade',
  'playerStatsUpdate',
  // MSMP 推送的官方名单变化（白名单/管理员/封禁/IP 封禁）：面板外的 /op、/whitelist、/ban
  // 也要让界面能跟上；载荷见 wsNameListChangedPayloadSchema
  'nameListChanged',
  'playerJoin',
  'playerLeave',
  'playerDeath',
  'playerRespawn',
  'playerChat',
  'playerSleep',
  'achievement',
  'backupStart',
  'backupProgress',
  'backupComplete',
  'backupFailed',
  'backupSkipped',
  'backupCancelled',
  'restoreStart',
  'restoreProgress',
  'restoreComplete',
  'restoreFailed',
  'restoreCancelled',
  'taskExecute',
  'taskFailed',
  'webhookDeliveryFailed',
  'deployProgress',
  'deployComplete',
  'deployFailed',
  'deployCancelled',
  'circuit_breaker',
  'upgradeProgress',
  'upgradeComplete',
  'upgradeFailed',
  'upgradeCancelled',
  'systemStatsUpdate',
  'error',
] as const

export const wsEventTypeSchema = z.enum(WS_EVENT_TYPES)

export const wsMessageSchema = z.object({
  // 'auth'：首帧鉴权回执（服务端 → 客户端 {type:'auth', ok:true}）
  type: z.union([wsEventTypeSchema, z.literal('pong'), z.literal('auth')]),
  ok: z.boolean().optional(),
  eventId: z.number().optional(),
  instanceId: z.string().optional(),
  data: z.unknown().optional(),
  timestamp: z.number().optional(),
})

export const wsStatusSnapshotSchema = z.object({
  status: z.string(),
  isRunning: z.boolean(),
  players: z.array(z.unknown()),
  tps: z.number().nullable(),
  /**
   * 在途的**世界格式升级**（`state` 类事件的权威读法，见 `WS_EVENT_KINDS`）。
   *
   * 三种取值刻意分开，因为它们对界面是三个不同结论：
   * - 对象：正在升级，`progress` 是 0..1 的分数（取不到时为 null）；
   * - `null`：**确认空闲**（没有升级在跑）⇒ 客户端应清掉本地残留进度；
   * - **字段缺席**：**未知**（旧服务端 / 非 status 通道）⇒ 客户端保持现状，不要清。
   * 少了 `null` 与缺席的区分，「服务端没告诉我」会被读成「没有升级」，清掉正在跑的进度条。
   */
  worldUpgrade: z.object({ progress: z.number().nullable() }).nullable().optional(),
})

export const wsPerformancePayloadSchema = z.object({
  cpu: z.number(),
  memory: z.number(),
  tps: z.number(),
  mspt: z.number(),
  worldTime: z.number().nullable(),
  worldDay: z.number().nullable(),
  sleepingPlayers: z.number(),
  sleepingPlayerNames: z.array(z.string()),
  awakePlayerNames: z.array(z.string()),
})

export const wsLogPayloadSchema = z.object({
  text: z.string(),
  type: z.enum(['stdout', 'stderr', 'command']),
})

/** 运行态**跃迁**的取值（`statusEvent` 载荷的 `event` 字段） */
export const WS_STATUS_EVENT_NAMES = [
  'started',
  'stopped',
  'ready',
  'crash',
  'save',
  'circuit_breaker',
] as const

export type WsStatusEventName = (typeof WS_STATUS_EVENT_NAMES)[number]

/**
 * 关键跃迁子事件：落库时**实例归属置空**（全局行）⇒ 任何订阅者断线补齐都看得到
 * （「用户不一定正盯着出事的实例」，多实例下尤其重要）。
 *
 * 这一格类型级落库面（`NOTIFICATION_EVENT_TYPES`）描述不了——它按「类型 + 载荷取值」两级判定。
 * 服务端那条无条件落库的路径直接取用本声明，两边不会再各自演化。
 */
export const CRITICAL_STATUS_EVENTS: ReadonlySet<WsStatusEventName> = new Set([
  'crash',
  'circuit_breaker',
])

export const wsStatusEventPayloadSchema = z.object({
  event: z.enum(WS_STATUS_EVENT_NAMES),
  code: z.number().nullable().optional(),
  autoRestart: z.boolean().optional(),
  consecutiveCrashes: z.number().optional(),
  windowMs: z.number().optional(),
})

/**
 * 名单变化载荷：`list` 是面板侧的名单名（`allowlist` / `operators` / `bans` / `ipBans`），
 * `target` 是玩家名或 IP——解析不出时为**空串**（不猜），消费方按「目标未知」处理。
 */
export const wsNameListChangedPayloadSchema = z.object({
  list: z.enum(['allowlist', 'operators', 'bans', 'ipBans']),
  action: z.enum(['added', 'removed']),
  target: z.string(),
})

export const wsPlayerEventPayloadSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  cause: z.string().optional(),
  advancement: z.string().optional(),
  isChallenge: z.boolean().optional(),
  sleeping: z.boolean().optional(),
})

export const wsWeatherPayloadSchema = z.object({
  weather: z.enum(['clear', 'rain', 'thunder']),
})

/**
 * MC **世界格式升级**进度（`world/upgrade_*` 通知）。
 *
 * ⚠️ 与 `upgradeProgress` 不是一回事：那个是**面板自己的 jar/MC 版本升级**；
 * 本事件是服务端升级**世界存档格式**。两者刻意不同名——同名会让两个来源互相打架。
 *
 * 载荷只归一化出 `state` 与 `progress`。**`progress` 是 0..1 的分数（不是百分数）**，
 * 取不到时为 null。
 *
 * 实机实测（MC 26.3，一次真实的 1.20.4→26.3 世界格式升级）：`world/upgrade_started`
 * 与 `world/upgrade_finished` 无 params，`world/upgrade_progress` 的 params 是
 * **位置参数数组 `[0]`**（服务端限流 1 条/秒）——注意不是 `{ progress: 0 }`。
 * `world/upgrade_failed` 未触发，其 params 形态未实测（消费方按 null 处理即可）。
 */
export const wsWorldUpgradePayloadSchema = z.object({
  state: z.enum(['started', 'progress', 'finished', 'failed']),
  progress: z.number().nullable(),
})

export const wsBackupPayloadSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
  })
  .passthrough()

/** 备份/恢复进度（rsync --info=progress2 解析，服务端 1s 节流；robocopy/ditto 降级路径无进度） */
export const wsBackupProgressPayloadSchema = z.object({
  backupId: z.number(),
  percent: z.number().min(0).max(100),
})

/**
 * 落库面（服务端落库、断线补齐用）——**服务端从这里取，不再各存一份**。
 *
 * 收进来的判据是「低频高价值 + 用户离开现场后唯一能得知结果的通道」：只收**发生过的事实**
 * （与 `WS_EVENT_KINDS` 的 `state` 类不相交——进度类写库是纯放大，1 条/秒）。
 * 两类刻意**不在**此列：
 * - `taskExecute`：每次触发都发，属高频；
 * - 部署/面板升级的终态：走的是无条件落库的那个全局入口，在这里列出只为同类事件同居一处
 *   （本集合只对经 `broadcast()` 的事件生效）。
 */
export const NOTIFICATION_EVENT_TYPES: ReadonlySet<WsEventType> = new Set([
  'playerJoin',
  'playerLeave',
  'playerDeath',
  'playerRespawn',
  'playerChat',
  'playerSleep',
  'achievement',
  'backupStart',
  'backupComplete',
  'backupFailed',
  'backupSkipped',
  'backupCancelled',
  'restoreStart',
  'restoreComplete',
  'restoreFailed',
  'restoreCancelled',
  'taskFailed',
  'webhookDeliveryFailed',
  // 部署/面板自身升级的终态：与上面同类（都是「发生过的事实」，落库供断线补齐）。
  // 早先只有服务端本地那份清单含这六项，契约包这份落后了 ⇒ 两边说法不一。
  'deployComplete',
  'deployFailed',
  'deployCancelled',
  'upgradeComplete',
  'upgradeFailed',
  'upgradeCancelled',
])

/**
 * 事件类别——**本仓事件通道唯一的口径**，新加事件必须在这里落一格。
 *
 * - `state`：**此刻的状态**（进度、运行态、读数）。晚订阅者必须能直接读到，否则界面上是
 *   「这一块根本不存在」，不是「少了一条通知」。自愈路径见 `WS_STATE_RECOVERY`。
 * - `event`：**发生过的瞬间事实**（玩家进出、备份完成）。可丢、可重放；丢一条只是少一条记录。
 *
 * 为什么必须声明：两者物理上是不同机制——状态靠快照/轮询/周期重发，事件靠落库 + 游标重放。
 * 不声明就只能逐通道即兴发挥，而**用补发「边沿事件」去恢复「状态」**会一次犯两个错：
 * 篡改事实（那条「升级开始」其实发生在十分钟前）与漏掉状态（没有载体的百分比无处显示）。
 */
export type WsEventKind = 'state' | 'event'

/**
 * `state` 类事件的自愈路径（判据：晚订阅者在有限时间内能拿到当前值）：
 * - `snapshot`：服务端保留在途值，订阅/登记时补发
 * - `poll`：前端按 REST 轮询权威状态
 * - `cadence`：该通道由周期性采集驱动，等一个周期即自愈
 * - `none`：**已知缺口**——读代码确认没有上述任一路径。列在这里是为了让缺口可见，
 *   而不是留在「以为它会自己好」的状态
 */
export type WsStateRecovery = 'snapshot' | 'poll' | 'cadence' | 'none'

export const WS_EVENT_KINDS: Readonly<Record<WsEventType, WsEventKind>> = {
  // ── state：此刻的状态 ──
  // 运行态拆两个类型：快照是**状态**（订阅时必须能读到），跃迁是**事件**（发生过的瞬间事实）。
  // 合成一个 `status` 时靠「有没有 event 字段」区分两种语义，类别声明只能写成 state——那是不准的。
  statusSnapshot: 'state',
  statusEvent: 'event',
  performanceUpdate: 'state',
  weatherUpdate: 'state',
  worldUpgrade: 'state',
  playerStatsUpdate: 'state',
  backupProgress: 'state',
  restoreProgress: 'state',
  deployProgress: 'state',
  upgradeProgress: 'state',
  systemStatsUpdate: 'state',
  // ── event：发生过的事实 ──
  // `log` 属事件：每一行是「发生过」而不是「此刻的值」，丢行不影响历史（终端历史走 REST）。
  log: 'event',
  // 名单变化是**发生过的瞬间事实**（谁在何时被 op/封），可丢可重放，丢失只是少一条刷新触发；
  // 名单本身由 REST 读文件，不靠这条消息维持 ⇒ event 而非 state
  nameListChanged: 'event',
  playerJoin: 'event',
  playerLeave: 'event',
  playerDeath: 'event',
  playerRespawn: 'event',
  playerChat: 'event',
  playerSleep: 'event',
  achievement: 'event',
  backupStart: 'event',
  backupComplete: 'event',
  backupFailed: 'event',
  backupSkipped: 'event',
  backupCancelled: 'event',
  restoreStart: 'event',
  restoreComplete: 'event',
  restoreFailed: 'event',
  restoreCancelled: 'event',
  taskExecute: 'event',
  taskFailed: 'event',
  webhookDeliveryFailed: 'event',
  deployComplete: 'event',
  deployFailed: 'event',
  deployCancelled: 'event',
  circuit_breaker: 'event',
  upgradeComplete: 'event',
  upgradeFailed: 'event',
  upgradeCancelled: 'event',
  error: 'event',
}

export const WS_STATE_RECOVERY: Readonly<Partial<Record<WsEventType, WsStateRecovery>>> = {
  statusSnapshot: 'snapshot',
  deployProgress: 'snapshot',
  upgradeProgress: 'snapshot',
  worldUpgrade: 'snapshot',
  backupProgress: 'poll',
  restoreProgress: 'poll',
  systemStatsUpdate: 'cadence',
  // 以下三条原先声明为 `none`（缺口）：它们只在**值变化时**推送，值长时间不变时晚订阅者拿不到
  // 当前值。实测这些值本就在实例上缓存着（CPU/内存/世界时间/天气/最近一次玩家读数），
  // 故改为订阅即补一份 —— 不额外采集、不落库。
  performanceUpdate: 'snapshot',
  weatherUpdate: 'snapshot',
  playerStatsUpdate: 'snapshot',
}

export type WsEventType = (typeof WS_EVENT_TYPES)[number]
export type WsMessage = z.infer<typeof wsMessageSchema>
export type WsStatusSnapshot = z.infer<typeof wsStatusSnapshotSchema>
export type WsPerformancePayload = z.infer<typeof wsPerformancePayloadSchema>
export type WsLogPayload = z.infer<typeof wsLogPayloadSchema>
export type WsStatusEventPayload = z.infer<typeof wsStatusEventPayloadSchema>
export type WsPlayerEventPayload = z.infer<typeof wsPlayerEventPayloadSchema>
export type WsWeatherPayload = z.infer<typeof wsWeatherPayloadSchema>
export type WsWorldUpgradePayload = z.infer<typeof wsWorldUpgradePayloadSchema>
export type WsBackupPayload = z.infer<typeof wsBackupPayloadSchema>
export type WsBackupProgressPayload = z.infer<typeof wsBackupProgressPayloadSchema>
