/**
 * API 契约类型（设计文档 §5.1 types.ts）
 * 对照服务端契约手写（mc_commander_server/utils/response.js + routes/*）
 */

// ── 统一响应信封（服务端 utils/response.js）──────────────────────
export interface ApiEnvelope<T> {
  status: 'ok'
  code: 0
  message: string
  data: T
  pagination?: Pagination
  timestamp: string
}

export interface ApiErrorEnvelope {
  status: 'error'
  code: number
  message: string
  details: unknown
  timestamp: string
}

export interface Pagination {
  total: number
  page: number
  pageSize: number
  totalPages: number
}

// ── 概览（GET /overview）────────────────────────────────────
export interface InstanceSummary {
  id: string
  name: string
  isRunning: boolean
  playerCount: number
}

export interface OverviewData {
  version: string
  instanceCount: number
  runningCount: number
  totalPlayers: number
  systemCpuUsage: number
  systemMemoryUsage: number
  systemMemoryTotal: number
  systemMemoryPercent: number
  /** 兼容旧字段 */
  totalMemory: number
  freeMemory: number
  /** 磁盘使用率（feat-5） */
  diskUsage?: DiskUsage
  instances: InstanceSummary[]
}

// ── 系统统计（GET /system-stats）──────────────────────────────
export interface DiskInfo {
  mountpoint: string
  totalGB: number
  usedGB: number
  percent: number
}

export interface DiskUsage {
  /** 使用率最高的主分区 */
  primary: DiskInfo | null
  all: DiskInfo[]
}

export interface SystemStats {
  cpuUsage: number
  memoryUsage: number
  totalMemory: number
  memoryPercent: number
  cpuCores: number
  loadAvg: number[]
  uptime: number
  /** 磁盘使用率（feat-5） */
  diskUsage?: DiskUsage
}

// ── 玩家（GET /instances/:id/players + /players/:player/details）──
export interface SpawnPoint {
  x: number
  y: number
  z: number
  dimension?: string
}

export interface PlayerPosition {
  x: number
  y: number
  z: number
}

export type PlayerDimension = 'overworld' | 'nether' | 'end'
export type PlayerGameMode = 'survival' | 'creative' | 'adventure' | 'spectator'

export interface PlayerEvent {
  type: string
  message: string
  timestamp: string
}

export interface PlayerSession {
  joinTime: string
  leaveTime: string | null
  duration: number
}

/** 玩家统计（服务端 _computePlayerStats） */
export interface PlayerStats {
  totalOnline: number
  loginCount: number
  offlineSince: number
  deathCount: number
  achievementCount: number
  sleepCount: number
}

/** 药水效果（服务端返回 id 与数值；name/isBeneficial 前端本地映射） */
export interface PlayerPotionEffect {
  /** 效果 ID（不含 minecraft: 前缀），如 "speed"、"strength" */
  id: string
  name: string
  /** 等级（1-based，如速度 II 为 2） */
  level: number
  /** 剩余持续时间（秒）；-1 表示无限时长 */
  durationSeconds: number
  isBeneficial: boolean
}

/** IP 登录历史条目 */
export interface IpHistoryEntry {
  ip: string
  /** 最后登录时间描述（如「当前会话」「3天前」） */
  lastSeen: string
  /** 该 IP 登录次数 */
  count: number
}

/** 物品栏槽位物品（服务端 _buildInventoryResult） */
export interface InventoryItem {
  id: string
  count: number
  slot: number
  durability: number | null
  enchanted: boolean
  customName: string | null
}

/** 物品栏结构：装备 5 + 主背包 27 + 快捷栏 9 + 末影箱 27 */
export interface PlayerInventory {
  /** 空槽位为 null（服务端契约：数组已按槽位有序） */
  quickbar: (InventoryItem | null)[]
  main: (InventoryItem | null)[]
  equipment: {
    helmet: InventoryItem | null
    chestplate: InventoryItem | null
    leggings: InventoryItem | null
    boots: InventoryItem | null
    offhand: InventoryItem | null
  }
  enderChest: (InventoryItem | null)[]
  /** snapshot=上次存档快照（非实时）；realtime=RCON 实时 */
  source: 'snapshot' | 'realtime'
  partial: boolean
}

/** 玩家列表项（GET /players；在线项含 RCON 实时详情注入，字段为超集） */
export interface Player {
  name: string
  uuid: string
  isOnline: boolean
  ip: string
  joinTime: number | null
  onlineTime: number
  totalPlayTime: number
  isOp: boolean
  isWhitelisted: boolean
  isBanned: boolean
  /** 临时封禁到期时间（ms 时间戳；null=永久封禁或未封禁） */
  banExpiresAt: number | null
  isIpBanned: boolean
  ipBanExpiresAt: number | null
  /** 假人（名字以 [Bot] 或 bot_ 开头） */
  isFakePlayer: boolean
  /** 服务端详情/离线项可能返回 null（无 lastSeen 记录） */
  lastSeen: string | null
  health: number | null
  maxHealth: number | null
  hunger: number | null
  xpLevel: number | null
  spawnPoint: SpawnPoint | null
  respawnPoint: SpawnPoint | null
  /** 列表在线项 RCON 注入字段（离线项来自 playerdata 持久化） */
  position: PlayerPosition | null
  gameMode: PlayerGameMode | null
  dimension: PlayerDimension | null
  armor: number | null
  xpProgress: number | null
  ping: number | null
  isSleeping: boolean
  isAfk: boolean
  isFlying: boolean
  isSneaking: boolean
  isSprinting: boolean
  isBurning: boolean
  isFrozen: boolean
  /** 真实服务端详情接口不返回这两字段（mock 契约曾误判为必填）——可选，访问需 ?. */
  potionEffects?: PlayerPotionEffect[]
  ipHistory?: IpHistoryEntry[]
  inventory: PlayerInventory | null
  events: PlayerEvent[]
  sessions: PlayerSession[]
  stats: PlayerStats
}

/** 封禁记录项（GET /players/bans：temp_bans 全量 + 原版 banned-players.json/banned-ips.json 合并） */
export interface BanRecord {
  targetType: 'player' | 'ip'
  target: string
  reason: string
  isActive: boolean
  /** 永久封禁（原版 ban）为 true；临时封禁（temp_bans）为 false */
  isPermanent: boolean
  /** 到期时间（ms 时间戳；永久/null） */
  expiresAt: number | null
  createdAt: string
}

/** 封禁请求体（POST /players/:player/ban；duration 为 s/m/h/d/w/mo 语法或空=永久） */
export interface BanRequestBody {
  reason?: string
  duration?: string | null
  ip?: string
}

// ── 日志（GET /instances/:id/logs；服务端 terminal_log_service 契约）──
export interface LogEntry {
  text: string
  type: 'stdout' | 'stderr'
}

// ── 实例详情（GET /instances/:id → instance.toStatus()）─────────
export type WeatherType = 'clear' | 'rain' | 'thunder'

/** 实例配置更新（PUT /instances/:id 白名单，服务端 structuredUpdate 校验） */
export interface InstanceUpdatePayload {
  name?: string
  description?: string
  javaPath?: string
  /** JVM 内存（服务端格式：'2G' / '2048M'） */
  maxMemory?: string
  minMemory?: string
  jarFile?: string
  autoRestart?: boolean
  /** 面板重启后自动恢复（feat-5） */
  autoStart?: boolean
  /** 结构化启动参数（服务端白名单：仅 -X/-D 前缀、-jar 与 nogui） */
  jvmArgs?: string[]
  /** null 清除启动命令 */
  startCommand?: string | null
}

export interface InstanceStatus {
  id: string
  name: string
  isRunning: boolean
  isRconConnected: boolean
  autoRestart: boolean
  /** 面板重启后自动恢复（feat-5） */
  autoStart: boolean
  /** 崩溃循环熔断已触发 */
  circuitBreakerTripped: boolean
  /** 当前滑动窗口内连续崩溃次数 */
  consecutiveCrashes: number
  /** 本次运行秒数 */
  uptime: number
  address: string
  players: unknown[]
  playerCount: number
  maxPlayers: number
  mcVersion: string
  modLoader: string
  tps: number
  mspt: number
  cpuUsage: number
  memoryUsage: number
  totalMemory: number
  worldSize: string | null
  seed: string | null
  lastSave: string | null
  lastOutput: string | null
  gameMode: string
  difficulty: string
  whitelisted: boolean
  onlineMode: boolean
  viewDistance: number
  spawnProtection: number
  worldDay: number | null
  worldTime: number | null
  weather: WeatherType | null
  opCount: number
  opNames: string[]
  todayNewPlayers: number
  sleepingPlayers: number
  sleepingPlayerNames: string[]
  awakePlayerNames: string[]
  totalUptime: number
  startTime: string | null
  startCommand: string | null
  /** 结构化启动参数数组（null 表示未持久化） */
  jvmArgs: string[] | null
  javaPath: string
  /** 服务端持久化格式为 '2G'/'2048M' 字符串；旧数据可能为 MB 数值 */
  maxMemory: string | number
  minMemory: string | number
  jarFile: string
}

// ── WS 事件 payload（服务端 websocket.js / mc_server.js 契约）──
/** 订阅后立即回发的 status 快照 */
export interface WsStatusSnapshot {
  status: string
  isRunning: boolean
  players: unknown[]
  tps: number | null
}

export interface WsPerformancePayload {
  cpu: number
  memory: number
  tps: number
  mspt: number
  worldTime: number | null
  worldDay: number | null
  sleepingPlayers: number
  sleepingPlayerNames: string[]
  awakePlayerNames: string[]
}

export interface WsLogPayload {
  text: string
  type: 'stdout' | 'stderr' | 'command'
}

export interface WsStatusEventPayload {
  event: 'started' | 'stopped' | 'ready' | 'crash' | 'save' | 'circuit_breaker'
  code?: number | null
  autoRestart?: boolean
  consecutiveCrashes?: number
  windowMs?: number
}

export interface WsPlayerEventPayload {
  name?: string
  message?: string
  cause?: string
  advancement?: string
  isChallenge?: boolean
  sleeping?: boolean
}

export interface WsWeatherPayload {
  weather: WeatherType
}

export interface WsBackupPayload {
  id?: number
  name?: string
  [key: string]: unknown
}

// ── 备份（对照服务端 routes/backups.js 契约）────────────────
export interface BackupItem {
  id: number
  instanceId: string
  name: string
  description?: string | null
  type: 'manual'
  /** 字节原值 */
  size: number
  status: 'completed' | 'failed' | 'creating' | 'restoring'
  worldName: string
  format: 'snapshot' | 'zip'
  createdAt: string
  updatedAt: string
}

// ── WS 事件（服务端 websocket.js WSEvents，19 种）───────────────
export const WS_EVENT_TYPES = [
  'log',
  'status',
  'tpsUpdate',
  'performanceUpdate',
  'weatherUpdate',
  'playerStatsUpdate',
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
  'restoreStart',
  'restoreComplete',
  'restoreFailed',
  'taskExecute',
  'taskFailed',
  'deployProgress',
  'circuit_breaker',
  'upgradeProgress',
  'error',
] as const

export type WsEventType = (typeof WS_EVENT_TYPES)[number]

export interface WsMessage {
  type: WsEventType | 'pong'
  eventId?: number
  instanceId?: string
  data?: unknown
  timestamp?: number
}

/** 通知类事件（服务端落库集合，断线补齐用） */
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
  'restoreStart',
  'restoreComplete',
  'restoreFailed',
  'taskFailed',
])

// ── 世界信息（GET /instances/:id/world；服务端 status.js L734-765 全字段）──
export interface WorldDimension {
  name: string
  icon: string
  playerCount: number
}

export interface WorldInfo {
  name: string
  type: string
  /** level.dat NBT 读取的真实种子（兼容 1.16+ 与旧版结构） */
  seed: string
  /** 世界目录占用（GB） */
  sizeGB: number
  difficulty: string
  gameMode: string
  viewDistance: number
  simulationDistance: number
  onlinePlayers: number
  maxPlayers: number
  spawnProtection: number
  maxWorldSize: number
  allowFlight: boolean
  hardcore: boolean
  pvp: boolean
  commandBlock: boolean
  generateStructures: boolean
  whiteList: boolean
  onlineMode: boolean
  /** 最后存档时间戳（ms；服务端 _getLastSaveTime，可能为 null） */
  lastSave: number | null
  /** 游戏天数（time query gametime ÷ 24000）；RCON 不可用时为 null */
  gameDays: number | null
  dimensions: WorldDimension[]
}

// ── server.properties（GET/PUT /instances/:id/properties）───────────
/**
 * server.properties 键值对（值统一为字符串）。
 * GET 时敏感键（rcon.password/server-port/online-mode 等 9 项）以占位符
 * "********" 返回；PUT 提交占位符视为未修改，提交其余值 400 拒绝。
 */
export type ServerProperties = Record<string, string>

/** PUT /properties 响应：需重启服务器才能生效的属性键列表（空 = 全部已生效） */
export interface UpdatePropertiesResponse {
  restartRequired: string[]
}

// ── 文件（GET/PUT/DELETE /instances/:id/files + files/content）───────
export interface FileEntry {
  name: string
  /** 相对实例根目录的完整路径（如 "/world/dat"） */
  path: string
  type: 'directory' | 'file'
  /** 目录为 0 */
  size: number
  modifiedAt: string
  isDirectory: boolean
}

/** GET /files（目录目标）：目录列表 */
export interface FileListResponse {
  path: string
  isDirectory: boolean
  files: FileEntry[]
}

/** GET /files（文件目标）：单文件信息 */
export interface FileInfoResponse {
  name: string
  path: string
  type: 'file'
  size: number
  modifiedAt: string
  isDirectory: false
}

/** GET /files/content：文件内容（10MB 内文本；二进制拒绝） */
export interface FileContentResponse {
  path: string
  name: string
  size: number
  content: string
  encoding: 'utf-8' | 'gbk'
  modifiedAt: string
}

/** PUT /files/content 响应 */
export interface FileSaveResponse {
  path: string
  size: number
  modifiedAt: string
}

// ── 定时任务（mc_commander_server/routes/tasks.js 契约）──

export type ScheduledTaskType = 'restart' | 'backup' | 'command' | 'stop' | 'start'

/** 定时任务（ScheduledTaskModel._toCamel 契约） */
export interface ScheduledTask {
  id: number
  instanceId: string | null
  name: string
  type: ScheduledTaskType
  cronExpression: string
  command: string | null
  isEnabled: boolean
  lastRunAt: string | null
  /** 上次运行结果；never = 尚未运行（与 lastRunAt null 对齐） */
  lastRunStatus: 'never' | 'success' | 'failed' | 'skipped'
  /** 上次运行失败原因（仅 failed 时有值） */
  lastRunError: string | null
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
}

/** POST /instances/:id/tasks 载荷 */
export interface TaskCreatePayload {
  name: string
  type: ScheduledTaskType
  cronExpression: string
  command?: string | null
  isEnabled?: boolean
}

/** PUT /tasks/:id 载荷（局部更新） */
export type TaskUpdatePayload = Partial<TaskCreatePayload>

// ── 部署（mc_commander_server/routes/server-jar.js 契约）──

/** GET /versions?type= 响应（fabric 额外带 loaders） */
export interface VersionsResponse {
  type: string
  versions: string[]
  loaders?: string[]
}

/** POST /instances/deploy 载荷 */
export interface DeployRequest {
  type: 'vanilla' | 'paper' | 'fabric' | 'forge' | 'purpur'
  mcVersion: string
  instanceName: string
  maxMemory?: string
  loaderVersion?: string
}

/** POST /instances/deploy 成功响应 */
export interface DeployResult {
  id: string
  name: string
  type: string
  mcVersion: string
  javaVersion: string
  path: string
  maxMemory: string
}

/** WS deployProgress 事件载荷（stage: download/download_complete/forge_install/first_launch/complete/error） */
export interface DeployProgress {
  stage: string
  percent: number
  transferred: number
  total: number
  error?: string
}

/** 审计日志条目（服务端 routes/audit.js + db/audit.model.js） */
export interface AuditLogItem {
  id: number
  instanceId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  detail: unknown
  source: string
  createdAt: string
}

/** 命令历史条目（服务端 routes/audit.js + db/command_history.model.js） */
export interface CommandHistoryItem {
  id: number
  instanceId: string | null
  command: string
  source: string
  success: boolean
  response: string | null
  durationMs: number | null
  createdAt: string
}

// ── Webhook（服务端 routes/webhooks.js + db/webhook.model.js）──
export interface Webhook {
  id: number
  name: string
  url: string
  secret: string | null
  events: string[]
  instanceId: string | null
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookCreatePayload {
  name: string
  url: string
  secret?: string | null
  events?: string[]
  instanceId?: string | null
  isEnabled?: boolean
}

export interface WebhookDelivery {
  id: number
  webhookId: number
  eventType: string
  instanceId: string | null
  payload: unknown
  status: 'pending' | 'success' | 'failed'
  responseStatus: number | null
  responseBody: string | null
  durationMs: number | null
  attempts: number
  createdAt: string
}

// ── 更新检查（GET /check-update）────────────────────────────
export interface UpdateCheckResult {
  current: string
  latest: string | null
  hasUpdate: boolean
  offline?: boolean
  url?: string
}

export interface WebhookTestResult {
  statusCode: number
  body: string | null
}

// -- 升级（P0-4，服务端 routes/upgrade.js）--
export type UpgradeStage =
  | 'backup'
  | 'download'
  | 'replace'
  | 'verify'
  | 'completed'
  | 'failed'
  | 'rolled_back'

export interface UpgradeProgress {
  instanceId: string
  stage: UpgradeStage
  percent: number
  detail: string
  timestamp: number
}

export interface UpgradeRequest {
  mcVersion: string
  type?: 'vanilla' | 'paper' | 'purpur'
}

export interface UpgradeStartResponse {
  message: string
  instanceId: string
  mcVersion: string
  type: string
}

// ── 插件管理（feat-8 P0-5）────────────────────────────

/** jar 内 plugin.yml / paper-plugin.yml 解析出的元数据；读取失败为 null */
export interface PluginMeta {
  name: string | null
  version: string | null
  main: string | null
  /** Bukkit `api-version` / Paper `apiVersion` 归一化字段 */
  apiVersion: string | null
  description: string | null
  authors: string[]
  depend: string[]
  /** 软依赖：存在则先于本插件加载，缺失不影响（详情面板展示） */
  softdepend: string[]
  /** 插件官网（详情面板展示） */
  website: string | null
  /** 加载时机：STARTUP（世界加载前）/ POSTWORLD（默认，世界后） */
  load: 'STARTUP' | 'POSTWORLD' | null
}

/** plugins/ 目录内单个插件（启用 = *.jar，禁用 = *.jar.disabled） */
export interface PluginInfo {
  /** 文件名（含扩展名与 .disabled 后缀，作为启停/删除的 URL 参数） */
  file: string
  /** 展示名：去掉 .jar(.disabled) 的文件名 */
  name: string
  enabled: boolean
  sizeBytes: number
  mtimeMs: number
  meta: PluginMeta | null
}

/** GET /instances/:id/plugins 响应 */
export interface PluginList {
  plugins: PluginInfo[]
}

/** POST /instances/:id/plugins/check-updates 单条结果（feat-8 延伸：更新检测） */
export interface PluginUpdateStatus {
  file: string
  /** plugin.yml name（命中 Modrinth 的匹配键） */
  name: string
  installedVersion: string | null
  enabled: boolean
  /** Modrinth 是否找到对应项目（未收录/名称差异大 → false，保守不猜测） */
  matched: boolean
  slug: string | null
  title: string | null
  iconUrl: string | null
  /** Modrinth 最新版本号（matched 时才有值） */
  latestVersion: string | null
  /** 版本号与最新版不一致（无论新旧方向——版本风格差异也提示） */
  updateAvailable: boolean
  /** 本地版本 < 最新版（真正的"落后"），与 updateAvailable 区分展示强度 */
  hasNewer: boolean
}

/** POST /instances/:id/plugins/check-updates 响应 */
export interface PluginUpdateCheckResult {
  checkedAt: string
  results: PluginUpdateStatus[]
}

/** PUT /instances/:id/plugins/:file/enabled 响应 */
export interface PluginToggleResult {
  file: string
  enabled: boolean
}

/** POST /instances/:id/plugins/upload 响应（新建 201 / 覆盖 200） */
export interface PluginUploadResult {
  file: string
  sizeBytes: number
  mtimeMs: number
  meta: PluginMeta | null
  /** 是否覆盖了同名旧文件（overwrite=true 时可能为 true） */
  overwritten: boolean
}

// ── 插件市场（feat-8 延伸：Modrinth 代理，对照 services/market.service.js）──

/** GET /instances/:id/plugins/market/search 单条结果 */
export interface MarketSearchHit {
  projectId: string | null
  slug: string | null
  title: string | null
  description: string | null
  author: string | null
  downloads: number
  follows: number
  iconUrl: string | null
  dateModified: string | null
  categories: string[]
  serverSide: string | null
  clientSide: string | null
}

/** GET /instances/:id/plugins/market/search 响应 */
export interface MarketSearchResult {
  totalHits: number
  hits: MarketSearchHit[]
  /** 是否命中服务端 60s TTL 缓存（展示层可提示数据新鲜度） */
  cached: boolean
}

/** 版本 primary 文件（服务端已过滤无文件版本） */
export interface MarketVersionFile {
  url: string | null
  filename: string
  size: number
}

/** GET /instances/:id/plugins/market/projects/:slug/versions 单版本 */
export interface MarketVersion {
  versionNumber: string
  versionType: 'release' | 'beta' | 'alpha' | null
  name: string | null
  changelog: string | null
  datePublished: string | null
  downloads: number
  gameVersions: string[]
  loaders: string[]
  file: MarketVersionFile
}

/** GET /instances/:id/plugins/market/projects/:slug/versions 响应 */
export interface MarketVersionsResult {
  projectSlug: string
  versions: MarketVersion[]
  cached: boolean
}

/** POST /instances/:id/plugins/market/install 响应（新建 201 / 覆盖 200） */
export interface MarketInstallResult extends PluginUploadResult {
  slug: string
  versionNumber: string
  source: 'modrinth' | string
  /** Modrinth 原始文件名（落盘文件名经服务端安全净化，可能与之不同） */
  originalFileName: string
}
