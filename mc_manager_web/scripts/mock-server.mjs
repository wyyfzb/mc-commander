/**
 * E2E mock 服务端（Playwright webServer 依赖，端口 5198）
 * 模拟 MC Commander 服务端 API 契约（信封格式与字段对齐 routes/*）。
 * 数据为结构占位 mock，严禁真实服务器信息（项目规则 8）。
 * WS：最小握手 + subscribe 快照 + ping/pong（对齐 index.js handleProtocols
 * 与 websocket.js 消息契约；手写 RFC 6455 握手避免引入 ws 依赖——web 包
 * devDeps 无 ws，mock 端点不需要完整实现）。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const PORT = Number(process.env.MOCK_PORT) || 5198

const now = () => new Date().toISOString()

/** 本地时区日期键（与服务端 utils/local-date.js 同口径；toISOString 是 UTC，东八区凌晨会写成昨天） */
const localDateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Webhook 演示数据（对齐 @mc-commander/schemas webhook 契约；模块级以支持 POST 后持久） */
const webhooks = [
  {
    id: 1,
    name: '运维群通知',
    url: 'https://example.com/webhook/ops',
    secret: null,
    events: ['instance.started', 'instance.stopped', 'backup.completed'],
    instanceId: 'e2e-demo',
    isEnabled: true,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
  },
  {
    id: 2,
    name: '玩家事件流水',
    url: 'https://example.com/webhook/players',
    secret: null,
    events: ['player.joined', 'player.left'],
    instanceId: null,
    isEnabled: false,
    createdAt: '2026-08-15T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
  },
]
const ok = (data, message = 'Success') =>
  JSON.stringify({ status: 'ok', code: 0, message, data, timestamp: now() })
const err = (code, message) =>
  JSON.stringify({ status: 'error', code, message, details: null, timestamp: now() })

/** 本 mock 签发的唯一会话令牌（登录/设密固定返回；鉴权建模见请求入口） */
const MOCK_SESSION_TOKEN = 'e2e-mock-session-token-0000000001'

/** 首访设密是否已完成（记忆态，进程级）：Referer 推断出的 fresh 在 SPA 客户端路由期间一直成立，
 *  若不落这个状态，设密后再查一次 /auth/status 会又回 hasPassword:false、把用户弹回设密向导 */
let passwordSet = false

// 只读凭据的 mock 台账（进程内，供设置面板 e2e 用）：生成后 configured 翻真。
// 开关与 capabilities 上报同源，可用 MOCK_READONLY_ENABLED=false 构造关闭态
// 归档快照台账：挂载后清空，与真实服务端的「挂载即建索引 → 清点里不再出现」同形
let mockArchivedAttached = false

let mockReadonlyConfigured = false
const mockReadonlyEnabled = !['0', 'false', 'no', 'off'].includes(
  (process.env.MOCK_READONLY_ENABLED ?? 'true').trim().toLowerCase(),
)
/** 升级在途快照（#94）：非 null 表示 mock 正在「升级中」，取消后清空 */
let upgradeInFlight = null
/** 无需凭据即可访问的端点（登录前必须可达，与真实服务端一致） */
const PUBLIC_PATHS = new Set(['/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup'])

/** 解析 URL query 参数（decodeURIComponent 容错） */
const parseQuery = (url) => {
  const qs = url.split('?')[1] ?? ''
  const params = {}
  for (const pair of qs.split('&')) {
    if (!pair) continue
    const [k, v] = pair.split('=')
    params[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
  }
  return params
}

const instance = {
  id: 'e2e-demo',
  name: 'E2E 演示实例',
  isRunning: true,
  isRconConnected: true,
  autoRestart: true,
  uptime: 7200,
  address: 'localhost:25565',
  players: [{ name: 'Steve' }, { name: 'Alex' }, { name: 'Bob' }],
  playerCount: 3,
  maxPlayers: 20,
  mcVersion: '1.21.4',
  modLoader: 'vanilla',
  tps: 20,
  mspt: 12,
  cpuUsage: 15,
  memoryUsage: 3.2,
  totalMemory: 16,
  worldSize: '1.2GB',
  seed: null,
  lastSave: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastOutput: null,
  gameMode: 'survival',
  difficulty: 'normal',
  whitelisted: false,
  onlineMode: true,
  viewDistance: 10,
  spawnProtection: 16,
  worldDay: 42,
  worldTime: 6000,
  weather: 'clear',
  opCount: 1,
  todayNewPlayers: 2,
  opNames: ['Steve'],
  sleepingPlayers: 1,
  sleepingPlayerNames: ['Alex'],
  awakePlayerNames: ['Steve', 'Bob'],
  totalUptime: 172800,
  startTime: new Date(Date.now() - 7200_000).toISOString(),
  startCommand: null,
  jvmArgs: null,
  javaPath: 'java',
  maxMemory: 4096,
  minMemory: 1024,
  jarFile: 'server.jar',
}

/**
 * 实例运行态的**逐请求**视图（`x-mock-instance-running: true|false`）。
 * mock 是多 spec 并行共享的进程：把「已停止」这类场景态写进全局，会把别的 spec
 * 正在断言的运行态改脏（dashboard 的命令输入框可用性就依赖它，实测与升级类
 * spec 并行时被拖到超时）。故场景态按请求头覆写，全局状态恒为默认。
 */
function instanceView(req) {
  const raw = req?.headers?.['x-mock-instance-running']
  if (raw !== 'true' && raw !== 'false') return instance
  return { ...instance, isRunning: raw === 'true' }
}

const overview = {
  version: '1.1.0',
  instanceCount: 1,
  runningCount: 1,
  totalPlayers: 3,
  systemCpuUsage: 12.5,
  systemMemoryUsage: 4.2,
  systemMemoryTotal: 16,
  systemMemoryPercent: 26.3,
  totalMemory: 16,
  freeMemory: 11.8,
  instances: [{ id: 'e2e-demo', name: 'E2E 演示实例', isRunning: true, playerCount: 3 }],
}

const systemStats = {
  cpuUsage: 12.5,
  memoryUsage: 4.2,
  totalMemory: 16,
  memoryPercent: 26.3,
  cpuCores: 4,
  loadAvg: [0.1, 0.2, 0.15],
  uptime: 86400,
  diskUsage: {
    primary: { mountpoint: '/', totalGB: 39, usedGB: 5.5, percent: 14.2 },
    all: [{ mountpoint: '/', totalGB: 39, usedGB: 5.5, percent: 14.2 }],
  },
}

const logs = [
  { text: '[00:00:01] [Server thread/INFO]: Starting minecraft server', type: 'stdout' },
  { text: '[00:00:05] [Server thread/INFO]: Done (1.2s)! For help, type "help"', type: 'stdout' },
  { text: '[00:00:06] [Server thread/WARN]: Can\'t keep up! Is the server overloaded?', type: 'stdout' },
  // 超长行占位（真实场景：MC 会回显玩家执行的完整命令，长 NBT 命令回显超宽）
  { text: '[00:00:07] [Server thread/INFO]: Steve issued server command: /give Steve minecraft:diamond_sword{Enchantments:[{id:"minecraft:sharpness",lvl:5},{id:"minecraft:unbreaking",lvl:3},{id:"minecraft:mending",lvl:1},{id:"minecraft:looting",lvl:3},{id:"minecraft:fire_aspect",lvl:2}]} 1', type: 'stdout' },
]

// ── 世界/属性/文件 mock 数据（结构占位，虚构内容）──────────────────
const worldInfo = {
  name: 'E2E演示世界',
  type: 'minecraft:normal',
  seed: '887654321',
  sizeGB: 1.8,
  difficulty: 'normal',
  gameMode: 'survival',
  viewDistance: 10,
  simulationDistance: 10,
  onlinePlayers: 3,
  maxPlayers: 20,
  spawnProtection: 16,
  maxWorldSize: 29999984,
  allowFlight: false,
  hardcore: false,
  pvp: true,
  commandBlock: false,
  generateStructures: true,
  whiteList: false,
  onlineMode: true,
  lastSave: new Date(Date.now() - 5 * 60_000).getTime(),
  gameDays: 42,
  dimensions: [
    { name: '主世界', icon: '🌍', playerCount: 2 },
    { name: '下界', icon: '🔥', playerCount: 1 },
    { name: '末地', icon: '🟣', playerCount: 0 },
  ],
}

// 9 个敏感键占位符掩码 + 常用键（结构与真实 server.properties 对齐）
const properties = {
  'enable-rcon': '********',
  'rcon.password': '********',
  'rcon.port': '********',
  'enable-query': '********',
  'enable-status': '********',
  'enable-command-block': '********',
  'online-mode': '********',
  'server-port': '********',
  'server-ip': '********',
  'level-name': 'world',
  'level-type': 'minecraft:normal',
  'level-seed': '',
  motd: 'E2E 演示服务器',
  difficulty: 'normal',
  gamemode: 'survival',
  'white-list': 'false',
  'enforce-whitelist': 'false',
  'max-players': '20',
  'view-distance': '10',
  'simulation-distance': '10',
  'spawn-protection': '16',
  'max-world-size': '29999984',
  'allow-flight': 'false',
  hardcore: 'false',
  pvp: 'true',
  'generate-structures': 'true',
  'max-tick-time': '60000',
  'network-compression-threshold': '256',
}

const serverPropertiesText = `#Minecraft server properties
#E2E mock 文件内容（虚构占位，勿当真）
motd=E2E 演示服务器
difficulty=normal
gamemode=survival
white-list=false
max-players=20
view-distance=10
online-mode=true
`

// ── 定时任务 mock 数据（结构占位，虚构内容）─────────────────
const mockTasks = [
  {
    id: 1,
    instanceId: 'e2e-demo',
    name: '每日自动重启',
    type: 'restart',
    cronExpression: '0 4 * * *',
    command: null,
    isEnabled: true,
    lastRunAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    nextRunAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    createdAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
    updatedAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
  },
  {
    id: 2,
    instanceId: 'e2e-demo',
    name: '每日备份',
    type: 'backup',
    cronExpression: '0 0 * * *',
    command: null,
    isEnabled: true,
    lastRunAt: null,
    nextRunAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    createdAt: new Date(Date.now() - 10 * 86400_000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 86400_000).toISOString(),
  },
  {
    id: 3,
    instanceId: 'e2e-demo',
    name: '清理告示牌命令',
    type: 'command',
    cronExpression: '*/30 * * * *',
    command: 'say 服务器每半小时自动公告',
    isEnabled: false,
    lastRunAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    nextRunAt: null,
    createdAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
    updatedAt: new Date(Date.now() - 86400_000).toISOString(),
  },
]

// ── 备份 mock 数据（M6；结构占位虚构，E2E 断言用）────────────
const mockBackups = [
  {
    id: 21,
    instanceId: 'e2e-demo',
    name: '手动备份',
    description: null,
    type: 'manual',
    size: 524_288_000,
    status: 'completed',
    worldName: 'world',
    createdAt: new Date(Date.now() - 86400_000).toISOString(),
    updatedAt: new Date(Date.now() - 86_340_000).toISOString(),
  },
  {
    id: 19,
    instanceId: 'e2e-demo',
    name: '失败的备份',
    description: null,
    type: 'manual',
    size: 0,
    status: 'failed',
    worldName: 'world',
    createdAt: new Date(Date.now() - 6 * 86400_000).toISOString(),
    updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString(),
  },
]

const rootFileList = {
  path: '/',
  isDirectory: true,
  files: [
    { name: 'server.properties', path: '/server.properties', type: 'file', size: 1024, modifiedAt: new Date(Date.now() - 3600_000).toISOString(), isDirectory: false },
    { name: 'whitelist.json', path: '/whitelist.json', type: 'file', size: 128, modifiedAt: new Date(Date.now() - 7200_000).toISOString(), isDirectory: false },
    { name: 'ops.json', path: '/ops.json', type: 'file', size: 64, modifiedAt: new Date(Date.now() - 86400_000).toISOString(), isDirectory: false },
    { name: 'world', path: '/world', type: 'directory', size: 0, modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), isDirectory: true },
    { name: 'logs', path: '/logs', type: 'directory', size: 0, modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), isDirectory: true },
  ],
}

const worldDirList = {
  path: '/world',
  isDirectory: true,
  files: [
    { name: 'level.dat', path: '/world/level.dat', type: 'file', size: 2048, modifiedAt: new Date(Date.now() - 3600_000).toISOString(), isDirectory: false },
    { name: 'region', path: '/world/region', type: 'directory', size: 0, modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), isDirectory: true },
  ],
}

// ── 玩家 mock 数据（结构占位，虚构玩家名；E2E 断言用）────────────
const statsPlaceholder = {
  totalOnline: 86400, loginCount: 12, offlineSince: 0,
  deathCount: 3, achievementCount: 25, sleepCount: 2,
}

function mockPlayer(overrides) {
  return {
    name: 'Steve',
    uuid: '00000000-0000-4000-8000-000000000001',
    isOnline: true,
    ip: '',
    joinTime: Date.now() - 3600000,
    onlineTime: 3600,
    totalPlayTime: 36000,
    isOp: false,
    isWhitelisted: false,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: new Date().toISOString(),
    health: 20, maxHealth: 20, hunger: 18, xpLevel: 12,
    spawnPoint: { x: 0, y: 64, z: 0 },
    respawnPoint: null,
    position: { x: 123.5, y: 64, z: -456.2 },
    gameMode: 'survival',
    dimension: 'overworld',
    armor: 15,
    xpProgress: 0.4,
    ping: 35,
    isSleeping: false,
    isAfk: false, isFlying: false, isSneaking: false, isSprinting: false,
    isBurning: false, isFrozen: false,
    potionEffects: [],
    ipHistory: [],
    inventory: null,
    events: [],
    sessions: [],
    stats: { ...statsPlaceholder },
    ...overrides,
  }
}

const players = [
  mockPlayer({ name: 'Steve', isOp: true }),
  mockPlayer({
    name: 'Alex', uuid: '00000000-0000-4000-8000-000000000002',
    isSleeping: true, gameMode: 'creative',
    potionEffects: [{ id: 'speed', name: '迅捷', level: 2, durationSeconds: 240, isBeneficial: true }],
  }),
  mockPlayer({
    name: 'Bob', uuid: '00000000-0000-4000-8000-000000000003',
    isOnline: false, isWhitelisted: true, totalPlayTime: 180000,
    health: null, maxHealth: null, hunger: null, xpLevel: null,
    armor: null, ping: null, position: null, joinTime: null, onlineTime: 0,
    lastSeen: new Date(Date.now() - 86400000).toISOString(),
  }),
  mockPlayer({
    name: 'Charlie', uuid: '00000000-0000-4000-8000-000000000004',
    isOnline: false, isBanned: true, banExpiresAt: Date.now() + 43200000,
    health: null, maxHealth: null, hunger: null, xpLevel: null,
    armor: null, ping: null, position: null, joinTime: null, onlineTime: 0,
    lastSeen: new Date(Date.now() - 172800000).toISOString(),
  }),
  mockPlayer({
    name: 'Bot_farm1', uuid: '00000000-0000-4000-8000-000000000005',
    isFakePlayer: true, dimension: 'nether',
  }),
]

const bans = [
  {
    targetType: 'player', target: 'Charlie', reason: '作弊',
    isActive: true, isPermanent: false,
    expiresAt: Date.now() + 43200000,
    createdAt: new Date(Date.now() - 43200000).toISOString(),
  },
  {
    targetType: 'player', target: 'Ghost', reason: '恶意破坏',
    isActive: false, isPermanent: false,
    expiresAt: Date.now() - 3600000,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
]

/** 插件演示数据（模块级以支持 enabled 状态在 PUT 后持久） */
const plugins = [
  {
    file: 'EssentialsX-2.20.1.jar',
    name: 'EssentialsX',
    enabled: true,
    sizeBytes: 2_201_600,
    mtimeMs: Date.now() - 86_400_000,
    meta: { name: 'EssentialsX', version: '2.20.1', main: 'com.earth2me.essentials.Essentials', apiVersion: '1.13', description: '提供基础指令与权限管理', authors: ['EssentialsX Team'], depend: [], softdepend: ['Vault'] },
  },
  {
    file: 'Vault.jar',
    name: 'Vault',
    enabled: true,
    sizeBytes: 331_264,
    mtimeMs: Date.now() - 2 * 86_400_000,
    meta: { name: 'Vault', version: '1.7.3', main: 'net.milkbowl.vault.Vault', apiVersion: null, description: '经济与权限抽象层', authors: ['Sleaker'], depend: [], softdepend: [] },
  },
  {
    file: 'WorldEdit.jar',
    name: 'WorldEdit',
    enabled: false,
    sizeBytes: 8_912_896,
    mtimeMs: Date.now() - 7 * 86_400_000,
    meta: { name: 'WorldEdit', version: '7.3.0', main: 'com.sk89q.worldedit.bukkit.WorldEditPlugin', apiVersion: '1.17', description: '世界编辑工具', authors: ['EngineHub'], depend: [], softdepend: ['CommandBook'] },
  },
]

const server = createServer((req, res) => {
  const url = req.url ?? ''
  const path = url.split('?')[0]

  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')

    // 会话鉴权最小建模：带 Bearer 的请求，令牌必须是本 mock 签发的（登录/设密固定返回
    // MOCK_SESSION_TOKEN），否则回 40103。缺少这层校验时，「拿 A 面板的令牌请求 B 面板」
    // 在 e2e 里永远成功，异面板用例断言不承重。X-API-Key 不校验（mock 无 Key 台账）。
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    if (bearer && bearer !== MOCK_SESSION_TOKEN && !PUBLIC_PATHS.has(path)) {
      res.statusCode = 401
      return res.end(JSON.stringify({ status: 'error', code: 40103, message: '会话已过期，请重新登录', details: null, timestamp: now() }))
    }

    if (path === '/api/v1/overview') return res.end(ok(overview))
    if (path === '/api/v1/system-stats') return res.end(ok(systemStats))
    // ── 安全主线：auth 端点（登录 e2e 用；mock 固定凭据，严禁真实密码） ──
    if (path === '/api/v1/auth/status') {
      // 默认已设密（登录模式）；首访（设密向导模式）有两条构造路径：
      //   ① 接口 query `?fresh=1`（直接打 API 的用例）
      //   ② 页面 URL 带 `?fresh=1` —— 前端不读、也不透传该参数（生产代码里没有它的位置），
      //      故由 mock 从 Referer 推断；不这么做时文档里的「URL 加 ?fresh=1」其实点了没反应
      const freshByQuery = new URL(url, 'http://x').searchParams.get('fresh') === '1'
      const referer = (req.headers.referer ?? '').toString()
      const freshByReferer = /[?&]fresh=1(?:&|$)/.test(referer)
      // 设密态与其它场景态同款：允许按请求头覆写，避免「另一个 spec 走过设密向导后
      // 本 spec 的 ?fresh=1 静默失效」（该副作用是进程级的，当前无 e2e 触达，
      // 这里先把覆写通道准备好——与 x-mock-instance-running 同一范式）
      const passwordSetOverride = (() => {
        const raw = req.headers['x-mock-password-set']
        if (raw === 'true') return true
        if (raw === 'false') return false
        return null
      })()
      const fresh = (freshByQuery || freshByReferer) && !(passwordSetOverride ?? passwordSet)
      return res.end(ok({ hasPassword: !fresh }))
    }
    if (path === '/api/v1/auth/capabilities') {
      // 鉴权与真实服务端对齐：该端点不在 authMiddleware 的公开白名单内，**未认证一律 401**
      // （真实中间件无凭据分支回 40107「未提供访问凭据：请携带 X-API-Key 头或登录会话令牌」，
      // 与「凭据无效」的 40101 分开）。mock 无 Key 台账，故只要求「带了凭据」而不校验 Key 值；
      // Bearer 的值已由上方全局会话校验把关。
      const apiKeyHeader = (req.headers['x-api-key'] ?? '').toString().trim()
      if (!apiKeyHeader && !bearer) {
        res.statusCode = 401
        return res.end(JSON.stringify({
          status: 'error',
          code: 40107,
          message: '未提供访问凭据：请携带 X-API-Key 头或登录会话令牌',
          details: null,
          timestamp: now(),
        }))
      }
      // 部署能力探测（服务端 API_KEY_ENABLED）。默认开放——多数 spec 走 API Key 通道。
      //
      // false 态有三条构造路径，均为「按请求」判定（不是启动时一次性读），
      // 故同一轮 e2e 里真假两态可并存：
      //   ① request header `x-mock-api-key-enabled: 0`（e2e 用：page.setExtraHTTPHeaders 注入）
      //   ② query `?apiKeyEnabled=0`
      //   ③ env `MOCK_API_KEY_ENABLED=false`
      // 之所以不把开关定死在启动参数：Playwright 的 webServer 前后端共用一轮，环境变量改不了，
      // 而「通道关闭 ⇒ 入口不可见」必须真的被 e2e 跑到（夹具里结构性不可达的 false 态等于没有防线）。
      const headerFlag = (req.headers['x-mock-api-key-enabled'] ?? '').toString().trim()
      const queryFlag = new URL(url, 'http://x').searchParams.get('apiKeyEnabled') ?? ''
      const envFlag = (process.env.MOCK_API_KEY_ENABLED ?? 'true').trim()
      const raw = headerFlag || queryFlag || envFlag
      const apiKeyEnabled = !['0', 'false', 'no', 'off'].includes(raw.toLowerCase())
      // 只读凭据两字段：与真实服务端同形。configured 有两条构造路径——
      //   ① 进程内台账（rotate-readonly-key 置位，跑完「生成」用例后自然为真）
      //   ② 请求头 `x-mock-readonly-configured: 0|1`（用例显式钉死初始态，避免依赖
      //      同轮其它用例的执行顺序：webServer 一轮共享一个 mock 进程）
      const readonlyFlagHeader = (req.headers['x-mock-readonly-configured'] ?? '').toString().trim()
      const readonlyConfigured = readonlyFlagHeader === ''
        ? mockReadonlyConfigured
        : ['1', 'true', 'yes', 'on'].includes(readonlyFlagHeader.toLowerCase())
      // 通道关闭态同样支持按请求构造（与 apiKeyEnabled 同款理由：webServer 一轮共享进程，
      // 环境变量改不了，而「通道关闭 ⇒ 入口禁用 + 说明恢复方法」必须真被 e2e 跑到）
      const readonlyEnabledHeader = (req.headers['x-mock-readonly-enabled'] ?? '').toString().trim()
      const readonlyEnabled = readonlyEnabledHeader === ''
        ? mockReadonlyEnabled
        : !['0', 'false', 'no', 'off'].includes(readonlyEnabledHeader.toLowerCase())
      return res.end(ok({
        apiKeyEnabled,
        readonlyApiKeyEnabled: readonlyEnabled,
        readonlyApiKeyConfigured: readonlyConfigured,
      }))
    }
    if (path === '/api/v1/rotate-readonly-key' && req.method === 'POST') {
      // 与真实端点同门：真实服务端该端点要求管理员凭据（只读凭据调用 403/40305）。
      // mock 无 Key 台账，故只要求「带了凭据」——否则「面板忘带凭据」在 e2e 里永远成功
      const rotateKey = (req.headers['x-api-key'] ?? '').toString().trim()
      if (!rotateKey && !bearer) {
        res.statusCode = 401
        return res.end(JSON.stringify({
          status: 'error',
          code: 40107,
          message: '未提供访问凭据：请携带 X-API-Key 头或登录会话令牌',
          details: null,
          timestamp: now(),
        }))
      }
      // 明文只在响应里出现一次；此后能力探测回报「已配置」
      if (!mockReadonlyEnabled) {
        res.statusCode = 403
        return res.end(JSON.stringify({
          status: 'error',
          code: 40304,
          message: '只读 API Key 通道已关闭，无法轮换；如需只读凭据请先启用该通道',
          details: null,
          timestamp: now(),
        }))
      }
      mockReadonlyConfigured = true
      return res.end(ok({ apiKey: 'mcro-mock-1234-5678-90ab-cdef-1234-5678-90ab-cdef' }))
    }
    if (path === '/api/v1/auth/login' && req.method === 'POST') {
      const mockSession = { token: MOCK_SESSION_TOKEN, sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }
      try {
        const { password } = JSON.parse(body || '{}')
        if (password !== 'e2e-correct-pass') {
          res.statusCode = 401
          return res.end(JSON.stringify({ status: 'error', code: 40102, message: '密码错误', details: null, timestamp: '' }))
        }
      } catch {}
      return res.end(ok(mockSession))
    }
    if (path === '/api/v1/auth/setup' && req.method === 'POST') {
      passwordSet = true
      return res.end(ok({ hasPassword: true, token: MOCK_SESSION_TOKEN, sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }))
    }
    if (path === '/api/v1/auth/sessions') {
      return res.end(ok({ sessions: [{ id: 1, userAgent: 'Playwright E2E', ip: '127.0.0.1', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(), current: true }] }))
    }
    if (path === '/api/v1/auth/logout' && req.method === 'POST') return res.end(ok({ ok: true }))
    if (path === '/api/v1/auth/password' && req.method === 'PUT') return res.end(ok({ ok: true, kickedSessions: 1 }))
    if (path === '/api/v1/rotate-key' && req.method === 'POST') {
      // API Key 轮换（mock：固定返回演示 key；生产为随机生成）
      return res.end(ok({ apiKey: 'mcck-mock-0000-0000-0000-0001' }, 'API Key 已轮换：旧 Key 立即失效，请立即保存新 Key'))
    }
    // ── Webhook 端点（对齐 @mc-commander/schemas webhook 契约） ──
    if (path === '/api/v1/webhooks' && req.method === 'GET') {
      const q = parseQuery(url)
      const page = Math.max(1, parseInt(q.page) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize) || 20))
      // 剔除 secret（列表契约不回传密钥）
      const list = webhooks.map(({ secret: _secret, ...rest }) => rest)
      return res.end(JSON.stringify({
        status: 'ok', code: 0, message: 'Success',
        data: list.slice((page - 1) * pageSize, page * pageSize),
        pagination: { total: list.length, page, pageSize, totalPages: Math.ceil(list.length / pageSize) || 1 },
        timestamp: now(),
      }))
    }
    if (path === '/api/v1/webhooks/event-types') {
      return res.end(ok(['instance.started', 'instance.stopped', 'backup.completed', 'player.joined', 'player.left']))
    }
    if (path === '/api/v1/webhooks' && req.method === 'POST') {
      let created
      try {
        const payload = JSON.parse(body || '{}')
        created = {
          id: webhooks.length + 1,
          name: payload.name ?? '新建 Webhook',
          url: payload.url ?? 'https://example.com/webhook/new',
          secret: payload.secret ?? null,
          events: payload.events ?? [],
          instanceId: payload.instanceId ?? null,
          isEnabled: payload.isEnabled ?? true,
          createdAt: now(),
          updatedAt: now(),
        }
      } catch {
        created = webhooks[0]
      }
      webhooks.push(created)
      return res.end(ok(created))
    }
    if (/^\/api\/v1\/webhooks\/\d+\/test$/.test(path) && req.method === 'POST') {
      return res.end(ok({ success: true, statusCode: 200, durationMs: 120, error: null }))
    }
    if (/^\/api\/v1\/webhooks\/\d+\/deliveries$/.test(path)) {
      const q = parseQuery(url)
      const page = Math.max(1, parseInt(q.page) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize) || 20))
      // 字段对齐 webhookDeliverySchema（eventType/responseStatus/status）；payload=事件发送内容示例（虚构数据）
      const deliveries = [
        { id: 1, webhookId: 1, eventType: 'instance.started', instanceId: 'e2e-demo', payload: { event: 'instance.started', instance: 'E2E 演示实例', timestamp: Date.now() - 3600_000 }, status: 'success', responseStatus: 200, durationMs: 110, attempts: 1, createdAt: new Date(Date.now() - 3600_000).toISOString(), responseBody: '{"ok":true}' },
        { id: 2, webhookId: 1, eventType: 'backup.completed', instanceId: 'e2e-demo', payload: { event: 'backup.completed', file: 'world-backup-test.zip', size: 1024 }, status: 'failed', responseStatus: 502, durationMs: 3000, attempts: 3, createdAt: new Date(Date.now() - 86_400_000).toISOString(), responseBody: 'Bad Gateway' },
      ]
      return res.end(JSON.stringify({
        status: 'ok', code: 0, message: 'Success',
        data: deliveries.slice((page - 1) * pageSize, page * pageSize),
        pagination: { total: deliveries.length, page, pageSize, totalPages: Math.ceil(deliveries.length / pageSize) || 1 },
        timestamp: now(),
      }))
    }
    if (/^\/api\/v1\/webhooks\/\d+$/.test(path) && req.method === 'DELETE') return res.end(ok(null))
    // ── 插件域（对齐 @mc-commander/schemas plugin 契约；数据见模块级 plugins） ──
    if (path === '/api/v1/instances/e2e-demo/plugins' && req.method === 'GET') {
      return res.end(ok({ plugins }))
    }
    if (/^\/api\/v1\/instances\/e2e-demo\/plugins\/[^/]+\/enabled$/.test(path) && req.method === 'PUT') {
      let target = null
      try {
        const file = decodeURIComponent(path.split('/')[6])
        const { enabled } = JSON.parse(body || '{}')
        target = plugins.find((p) => p.file === file)
        if (target) target.enabled = Boolean(enabled)
      } catch {}
      return res.end(ok({ ok: Boolean(target) }))
    }
    if (/^\/api\/v1\/instances\/e2e-demo\/plugins\/[^/]+$/.test(path) && req.method === 'DELETE') {
      return res.end(ok({ ok: true }))
    }
    if (path === '/api/v1/instances/e2e-demo/plugins/check-updates' && req.method === 'POST') {
      return res.end(ok({ results: plugins.map((p) => ({
        file: p.file, name: p.name, installedVersion: p.meta?.version ?? null, enabled: p.enabled,
        matched: true, slug: p.name.toLowerCase(), title: p.name, iconUrl: null,
        latestVersion: p.meta?.version ?? '1.0.0', updateAvailable: false, hasNewer: false,
      })) }))
    }
    if (/^\/api\/v1\/instances\/e2e-demo\/plugins\/market\/search$/.test(path) && req.method === 'GET') {
      return res.end(ok({ hits: [], total: 0 }))
    }
    if (path === '/api/v1/instances') return res.end(ok([instanceView(req)]))
    if (path === '/api/v1/instances/e2e-demo') {
      // PUT：实例配置更新（general-panel autoRestart 用；合并白名单字段）
      if (req.method === 'PUT') {
        try {
          Object.assign(instance, JSON.parse(body || '{}'))
        } catch {}
        return res.end(ok(instance, 'Instance updated successfully'))
      }
      // DELETE：卸载（数据安全契约，与 routes/status.js 同语义）——实例名确认由
      // 服务端强制（前端输入框只是 UX）；实例无备份快照时还需 acknowledgeIrreversible。
      // 快照目录名用备份记录的 name 占位（mock 不建真实目录）
      if (req.method === 'DELETE') {
        let uninstallBody = {}
        try { uninstallBody = JSON.parse(body || '{}') } catch {}
        const confirmName = typeof uninstallBody.confirmName === 'string' ? uninstallBody.confirmName.trim() : null
        // 与服务端同口径：两侧 trim 后比对（兼容库里带首尾空白的旧实例名）
        if (confirmName !== instance.name.trim()) {
          res.statusCode = 400
          return res.end(err(40016, '需在请求体提供 confirmName 且与实例名完全一致才能卸载实例'))
        }
        const snapshots = mockBackups
          .filter((b) => b.instanceId === instance.id)
          .map((b) => b.name)
        if (snapshots.length === 0 && uninstallBody.acknowledgeIrreversible !== true) {
          res.statusCode = 409
          return res.end(err(40914, '该实例没有任何备份，删除后世界数据与配置不可恢复；确认后请携带 acknowledgeIrreversible=true 重试'))
        }
        return res.end(ok({
          retainedBackupCount: snapshots.length,
          // 与真实契约同形：数量全量、名字只列最近 10 条
          retainedBackupNames: snapshots.slice(0, 10),
        }, 'Instance deleted'))
      }
      return res.end(ok(instanceView(req)))
    }
    if (path === '/api/v1/instances/e2e-demo/logs') return res.end(ok(logs))
    if (path === '/api/v1/instances/e2e-demo/command') {
      let cmd = ''
      try { cmd = JSON.parse(body || '{}').command ?? '' } catch {}
      // gamerule 无参查询 → 全量规则文本（≥ 规则集 1/3 才能过 parseGameruleOutput 阈值，返回 20 条）
      if (/^gamerule\s*$/i.test(cmd)) {
        return res.end(ok([
          'allowEnteringNetherUsingPortals = true',
          'announceAdvancements = true',
          'blockExplosionDropDecay = true',
          'commandBlockOutput = true',
          'commandBlocksEnabled = true',
          'commandModificationBlockLimit = 32768',
          'disableElytraMovementCheck = false',
          'disablePlayerMovementCheck = false',
          'disableRaids = false',
          'doDaylightCycle = true',
          'doEntityDrops = true',
          'doImmediateRespawn = false',
          'doInsomnia = true',
          'doLimitedCrafting = false',
          'doMobLoot = true',
          'doMobSpawning = true',
          'doPatrolSpawning = true',
          'doTileDrops = true',
          'doTraderSpawning = true',
          'doVinesSpread = true',
        ].join('\n')))
      }
      // gamerule 修改（带值）→ RCON 成功文本
      if (/^gamerule\s+\S+\s+\S+\s*$/i.test(cmd)) {
        return res.end(ok('Game rule has been updated'))
      }
      return res.end(ok({ response: `已执行: ${cmd}` }))
    }
    if (path === '/api/v1/instances/e2e-demo/start') return res.end(ok({ started: true }))
    if (path === '/api/v1/instances/e2e-demo/stop') return res.end(ok({ stopped: true }))
    if (path === '/api/v1/instances/e2e-demo/restart') return res.end(ok({ restarted: true }))
    // EULA 首启闭环（issue 312）：部署产物实例的同意写入 + 自动启动端点
    if (path === '/api/v1/instances/paper-a1b2c3d4/eula') return res.end(ok({ accepted: true }))
    if (path === '/api/v1/instances/paper-a1b2c3d4/start') return res.end(ok({ started: true }))

    // ── 任务域 ──
    if (path === '/api/v1/instances/e2e-demo/tasks') {
      if (req.method === 'POST') {
        const bodyObj = JSON.parse(body || '{}')
        return res.end(ok({
          id: 99,
          instanceId: 'e2e-demo',
          name: bodyObj.name ?? '新任务',
          type: bodyObj.type ?? 'restart',
          cronExpression: bodyObj.cronExpression ?? '0 0 * * *',
          command: bodyObj.command ?? null,
          isEnabled: bodyObj.isEnabled ?? true,
          lastRunAt: null,
          nextRunAt: null,
          createdAt: now(),
          updatedAt: now(),
        }, 'Scheduled task created successfully'))
      }
      return res.end(ok(mockTasks))
    }
    const taskMatch = path.match(/^\/api\/v1\/tasks\/(\d+)$/)
    if (taskMatch) {
      const task = mockTasks.find((t) => t.id === Number(taskMatch[1]))
      if (req.method === 'PUT') {
        return res.end(ok({ ...(task ?? {}), ...JSON.parse(body || '{}') }, 'Scheduled task updated successfully'))
      }
      if (req.method === 'DELETE') {
        return res.end(ok(null, 'Scheduled task deleted successfully'))
      }
    }
    if (path.match(/^\/api\/v1\/tasks\/(\d+)\/run$/)) {
      return res.end(ok(null, 'Task execution triggered'))
    }
    // ── 备份域（M6；虚构占位数据）──
    if (path === '/api/v1/instances/e2e-demo/backups') {
      if (req.method === 'POST') {
        return res.end(ok({
          id: 23,
          instanceId: 'e2e-demo',
          // 与服务端默认命名同源（routes/backups.js：未传 name 时用 Backup_<本地日期>），
          // 与 createdAt 同刻生成，不再写死日期
          name: `Backup_${localDateKey()}`,
          description: null,
          type: 'manual',
          size: 0,
          status: 'creating',
          worldName: 'world',
          createdAt: now(),
          updatedAt: now(),
        }, 'Backup created successfully'))
      }
      return res.end(ok(mockBackups))
    }
    // 归档快照：磁盘上有、备份表里没有索引的快照目录
    if (path === '/api/v1/backups/archived' && req.method === 'GET') {
      if (mockArchivedAttached) return res.end(ok([]))
      return res.end(ok([{
        archiveId: 'paper-1a2b3c4d',
        instanceExists: false,
        snapshotCount: 3,
        usableCount: 2,
        latestMtime: '2026-09-01T00:00:00.000Z',
      }]))
    }
    if (/^\/api\/v1\/instances\/[^/]+\/backups\/attach$/.test(path) && req.method === 'POST') {
      // 与真实端点同门：要求管理员凭据（mock 无 Key 台账，只要求「带了凭据」）
      const attachKey = (req.headers['x-api-key'] ?? '').toString().trim()
      if (!attachKey && !bearer) {
        res.statusCode = 401
        return res.end(err(40107, '未提供访问凭据：请携带 X-API-Key 头或登录会话令牌'))
      }
      let archiveId = ''
      try {
        archiveId = String(JSON.parse(body || '{}').archiveId ?? '')
      } catch {
        archiveId = ''
      }
      if (!archiveId) {
        res.statusCode = 400
        return res.end(err(40000, 'archiveId 必填'))
      }
      mockArchivedAttached = true
      return res.end(ok({ attached: 2, skipped: 1 }, '已挂载 2 份归档快照（跳过 1 份：已挂载过或无法识别）'))
    }
    if (path.match(/^\/api\/v1\/backups\/\d+\/restore$/)) {
      // 与真实服务端同语义：恢复必须带实例名确认（mock 的实例名为「E2E 演示实例」）
      let confirmName = ''
      try {
        confirmName = String(JSON.parse(body || '{}').confirmName ?? '')
      } catch {
        confirmName = ''
      }
      if (confirmName.trim() !== instance.name.trim()) {
        res.statusCode = 400
        return res.end(err(40017, '需在请求体提供 confirmName 且与该备份所属实例名完全一致才能恢复'))
      }
      return res.end(ok(null, 'Restore started'))
    }
    if (path.match(/^\/api\/v1\/backups\/\d+$/)) {
      if (req.method === 'DELETE') {
        return res.end(ok(null, 'Backup deleted successfully'))
      }
    }
    // ── 部署域 ──
    if (path === '/api/v1/versions') {
      const { type } = parseQuery(url)
      const verType = type || 'vanilla'
      return res.end(ok({
        type: verType,
        versions: ['26.2', '1.21.4', '1.21.1', '1.20.6', '1.20.4', '1.19.4'],
        ...(verType === 'fabric' ? { loaders: ['0.16.10', '0.16.9', '0.15.11'] } : {}),
      }))
    }
    if (path === '/api/v1/instances/deploy' && req.method === 'POST') {
      return res.end(ok({
        id: 'paper-a1b2c3d4',
        name: '新部署实例',
        type: 'paper',
        mcVersion: '1.21.4',
        javaVersion: '21',
        path: '/mock/instances/paper-a1b2c3d4',
        maxMemory: '2G',
      }, 'Instance deployed successfully'))
    }
    // 部署进度兜底快照（对齐 @mc-commander/schemas deployStatusResponseSchema）：
    // 默认空态；?active=1 或 ?mockInFlight=1 返回在途快照（后者由面板按
    // localStorage 场景开关追加，供 e2e 复现「刷新/断线后服务端仍在部署」；
    // 不保存服务端状态 → 用例之间零串扰）。结构占位虚构数据。
    if (path === '/api/v1/instances/deploy/status') {
      const q = parseQuery(url)
      if (q.active === '1' || q.mockInFlight === '1') {
        return res.end(ok({
          deploying: true,
          instanceId: 'paper-a1b2c3d4',
          instanceName: '新部署实例',
          type: 'paper',
          mcVersion: '1.21.4',
          stage: 'download',
          percent: 0.45,
          transferred: 52_428_800,
          total: 104_857_600,
          updatedAt: Date.now(),
        }))
      }
      return res.end(ok({ deploying: false }))
    }
    // mock 专用控制端点：把「场景态」复位到默认。mock 状态是进程级共享的，制造场景态的
    // 用例必须在 finally 里调它——但**按域复位**（body `{ only: 'upgrade' | 'archive' |
    // 'readonly' }`）：全量复位会把并行 spec 正在用的场景态一起清掉（归档用例刚断言
    // 「挂载后清点收敛」，升级用例的 finally 一复位就又让归档冒出来）。不传 only 时全量复位
    if (path === '/api/v1/mock/reset' && req.method === 'POST') {
      let only = null
      try {
        const parsed = JSON.parse(body || '{}')
        // 显式传了 only 但取值不认识（含非字符串）：什么都不复位——写错域名的用例
        // 会看到「复位没生效」，而不是悄悄把并行 spec 的场景态全清掉
        if (Object.prototype.hasOwnProperty.call(parsed, 'only')) only = String(parsed.only)
      } catch {}
      const knownOnly = only === null || ['upgrade', 'readonly', 'archive'].includes(only)
      if (!knownOnly) return res.end(ok({ only, reset: 'none' }))
      if (only === null || only === 'upgrade') upgradeInFlight = null
      if (only === null || only === 'readonly') mockReadonlyConfigured = false
      if (only === null || only === 'archive') mockArchivedAttached = false
      return res.end(ok({ only, reset: only ?? 'all' }))
    }
    // 强制断开全部 WS 连接（mock 专用控制端点：e2e 复现「实时通道断开」边沿，HTTP 不动）
    if (path === '/api/v1/instances/deploy/drop-ws' && req.method === 'POST') {
      // 按请求头分组断开（两侧都不带分组头时即『断开全部无分组连接』＝旧行为）
      const group = String(req.headers['x-mock-ws-group'] ?? '')
      let dropped = 0
      for (const s of wsSockets) {
        if ((s.mockWsGroup ?? '') !== group) continue
        s.destroy()
        wsSockets.delete(s)
        dropped += 1
      }
      return res.end(ok({ dropped }))
    }
    // 取消在途部署（对齐服务端 POST /instances/deploy/cancel）：受理后按真实链路
    // 补一条 cancelled 终态进度事件——前端据此从「部署中」切到「已取消」视图，
    // 只回 HTTP 而不发事件会让用例停在「正在取消…」（真实服务端不会）
    if (path === '/api/v1/instances/deploy/cancel' && req.method === 'POST') {
      let requestedId = ''
      try {
        requestedId = String(JSON.parse(body || '{}').instanceId ?? '')
      } catch {
        requestedId = ''
      }
      const instanceId = requestedId || 'paper-a1b2c3d4'
      broadcastWs('deployProgress', {
        stage: 'cancelled',
        percent: 0,
        transferred: 0,
        total: 0,
        instanceId,
        instanceName: '新部署实例',
      })
      broadcastWs('deployCancelled', { stage: 'cancelled', instanceId, instanceName: '新部署实例' })
      return res.end(ok({ instanceId, cancelled: true }, 'Deployment cancellation requested'))
    }
    // ── 升级域（#94）──
    // 受理后按真实链路补发进度事件：前端据 WS 事件进入「升级中」视图（只回 HTTP 不发事件
    // 会让用例停在初始表单，真实服务端不会）
    if (path === '/api/v1/instances/e2e-demo/upgrade' && req.method === 'POST') {
      let target = '26.2'
      try {
        target = String(JSON.parse(body || '{}').mcVersion ?? target)
      } catch {
        target = '26.2'
      }
      upgradeInFlight = { stage: 'download', detail: '正在下载新版本服务端…' }
      broadcastWs('upgradeProgress', { instanceId: 'e2e-demo', stage: 'backup', percent: 0, detail: '正在创建备份…', timestamp: Date.now() }, 'e2e-demo')
      broadcastWs('upgradeProgress', { instanceId: 'e2e-demo', stage: 'download', percent: 40, detail: '正在下载新版本服务端…', timestamp: Date.now() }, 'e2e-demo')
      res.statusCode = 202
      return res.end(ok({ message: 'Upgrade started', instanceId: 'e2e-demo', mcVersion: target, type: 'vanilla' }))
    }
    if (path === '/api/v1/instances/e2e-demo/upgrade/status') {
      if (!upgradeInFlight) return res.end(ok({ upgrading: false }))
      return res.end(ok({ upgrading: true, instanceId: 'e2e-demo', percent: 40, timestamp: Date.now(), ...upgradeInFlight }))
    }
    if (path === '/api/v1/instances/e2e-demo/upgrade/cancel' && req.method === 'POST') {
      if (!upgradeInFlight) {
        res.statusCode = 409
        return res.end(err(40908, 'No upgrade in progress for this instance'))
      }
      const detail = '已取消，实例保持 1.21.4'
      upgradeInFlight = null
      broadcastWs('upgradeProgress', { instanceId: 'e2e-demo', stage: 'cancelled', percent: 0, detail, timestamp: Date.now() }, 'e2e-demo')
      broadcastWs('upgradeCancelled', { instanceId: 'e2e-demo', instanceName: 'E2E 演示实例', stage: 'cancelled', detail, timestamp: Date.now() }, 'e2e-demo')
      return res.end(ok({ instanceId: 'e2e-demo', cancelled: true }, 'Upgrade cancellation requested'))
    }

    // ── 世界/属性域 ──
    if (path === '/api/v1/instances/e2e-demo/world') return res.end(ok(worldInfo))
    if (path === '/api/v1/instances/e2e-demo/properties') {
      if (req.method === 'PUT') {
        return res.end(ok({ restartRequired: [] }, 'Properties updated'))
      }
      return res.end(ok(properties))
    }

    // ── 文件域 ──
    if (path === '/api/v1/instances/e2e-demo/files/content') {
      const { path: filePath } = parseQuery(url)
      if (req.method === 'PUT') {
        return res.end(ok({ path: filePath, size: 1024, modifiedAt: now() }, 'File saved successfully'))
      }
      const name = filePath.split('/').filter(Boolean).pop() || 'server.properties'
      return res.end(ok({
        path: filePath,
        name,
        size: 1024,
        content: serverPropertiesText,
        encoding: 'utf-8',
        modifiedAt: now(),
      }))
    }
    if (path === '/api/v1/instances/e2e-demo/files') {
      if (req.method === 'DELETE') {
        return res.end(ok(null, 'File/directory deleted successfully'))
      }
      const { path: dirPath } = parseQuery(url)
      return res.end(ok(dirPath === '/world' ? worldDirList : rootFileList))
    }

    // ── 审计域（操作日志 + 命令历史：action/时间过滤 + order 排序 + 分页信封）──
    if (path === '/api/v1/audit-logs' || path === '/api/v1/command-history') {
      const q = parseQuery(url)
      // 对齐真服务端口径：SQLite CURRENT_TIMESTAMP = UTC「YYYY-MM-DD HH:MM:SS」（空格分隔，
      // 无时区标记）；ISO「T」分隔会与前端按该口径构造的 startTime/endTime 字符串比较失配
      const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString().replace('T', ' ').slice(0, 19)
      const auditLogs = [
        { id: 1, instanceId: 'e2e-demo', action: 'INSTANCE_START', targetType: 'instance', targetId: 'e2e-demo', detail: { reason: '手动启动' }, source: 'web', createdAt: hoursAgo(30) },
        { id: 2, instanceId: 'e2e-demo', action: 'PLAYER_OP', targetType: 'player', targetId: 'Steve', detail: { by: 'admin' }, source: 'rcon', createdAt: hoursAgo(20) },
        { id: 3, instanceId: 'e2e-demo', action: 'CONFIG_CHANGE', targetType: 'properties', targetId: 'server.properties', detail: { key: 'view-distance', from: '10', to: '12' }, source: 'web', createdAt: hoursAgo(8) },
        { id: 4, instanceId: 'e2e-demo', action: 'PLAYER_KICK', targetType: 'player', targetId: 'Alex', detail: { reason: '违规行为' }, source: 'web', createdAt: hoursAgo(2) },
        { id: 5, instanceId: 'e2e-demo', action: 'BACKUP_CREATE', targetType: 'backup', targetId: 'backup-demo', detail: { sizeBytes: 1048576 }, source: 'cron', createdAt: hoursAgo(1) },
      ]
      const commandHistory = [
        { id: 1, instanceId: 'e2e-demo', command: 'list', source: 'web', success: true, response: 'There are 3 of a max of 20 players online', durationMs: 42, createdAt: hoursAgo(3) },
        { id: 2, instanceId: 'e2e-demo', command: 'time set day', source: 'web', success: true, response: 'Set the time to 1000', durationMs: 18, createdAt: hoursAgo(2.5) },
        { id: 3, instanceId: 'e2e-demo', command: 'gamemode creative Steve', source: 'web', success: false, response: 'No player was found', durationMs: 21, createdAt: hoursAgo(2) },
        { id: 4, instanceId: 'e2e-demo', command: 'say hello', source: 'rcon', success: true, response: null, durationMs: 9, createdAt: hoursAgo(1) },
      ]
      const isAudit = path === '/api/v1/audit-logs'
      let list = isAudit ? auditLogs : commandHistory
      if (isAudit && q.action) list = list.filter((l) => l.action === q.action)
      if (q.startTime) list = list.filter((l) => l.createdAt >= q.startTime)
      if (q.endTime) list = list.filter((l) => l.createdAt <= q.endTime)
      // order：asc 正序 / desc 倒序（缺省倒序，对齐 audit.model.js ORDER BY id 方向）
      if (q.order === 'asc') list = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      else list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const page = Math.max(1, parseInt(q.page) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize) || 20))
      const total = list.length
      return res.end(JSON.stringify({
        status: 'ok', code: 0, message: 'Success',
        data: list.slice((page - 1) * pageSize, page * pageSize),
        pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 },
        timestamp: now(),
      }))
    }

    // ── 玩家域 ──
    if (path === '/api/v1/instances/e2e-demo/players') return res.end(ok(players))
    if (path === '/api/v1/instances/e2e-demo/players/bans') return res.end(ok(bans))
    if (path === '/api/v1/instances/e2e-demo/players/bans/Charlie/pardon') return res.end(ok(null))
    const detailsMatch = path.match(/^\/api\/v1\/instances\/e2e-demo\/players\/([^/]+)\/details$/)
    if (detailsMatch) {
      const found = players.find((p) => p.name === detailsMatch[1])
      if (found) return res.end(ok(found))
      res.statusCode = 404
      return res.end(JSON.stringify({ status: 'error', code: 40403, message: '玩家不存在', details: null, timestamp: now() }))
    }
    const opMatch = path.match(/^\/api\/v1\/instances\/e2e-demo\/players\/([^/]+)\/op$/)
    if (opMatch) return res.end(ok(null))
    const kickMatch = path.match(/^\/api\/v1\/instances\/e2e-demo\/players\/([^/]+)\/kick$/)
    if (kickMatch) return res.end(ok(null))
    const banMatch = path.match(/^\/api\/v1\/instances\/e2e-demo\/players\/([^/]+)\/ban$/)
    if (banMatch) return res.end(ok({ expiresAt: Date.now() + 3600000 }))
    const pardonMatch = path.match(/^\/api\/v1\/instances\/e2e-demo\/players\/([^/]+)\/pardon$/)
    if (pardonMatch) return res.end(ok(null))
    const whitelistAddMatch = path.match(/^\/api\/v1\/instances\/e2e-demo\/players\/([^/]+)\/whitelist\/add$/)
    if (whitelistAddMatch) return res.end(ok(null))
    const whitelistRemoveMatch = path.match(/^\/api\/v1\/instances\/e2e-demo\/players\/([^/]+)\/whitelist$/)
    if (whitelistRemoveMatch) return res.end(ok(null))

    res.statusCode = 404
    res.end(JSON.stringify({ status: 'error', code: 40400, message: 'Not found', details: null, timestamp: now() }))
  })
})

// ── 最小 WS 端点（对齐真实服务端契约）──────────────────────────────
// 与真实端一致支持两条鉴权通道——①subprotocol 携带凭据（向后兼容）；
// ②首帧消息 auth（客户端主线）：无凭据握手放行，第一条消息必须是
// {type:'auth', ...}，回执 {type:'auth', ok:true} 后才接受订阅
// （e2e 专用令牌恒放行——mock 不做凭据校验）
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const authProtocol = (protocols) =>
  protocols.find((p) => p.startsWith('mc-commander-apikey.') || p.startsWith('mc-commander-session.')) ?? null

/** 帧解码：客户端→服务端仅小载荷文本帧（subscribe/ping），掩码必处理 */
function decodeFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    off = 10
  }
  const masked = (buf[1] & 0x80) !== 0
  let mask = null
  if (masked) {
    mask = buf.subarray(off, off + 4)
    off += 4
  }
  const payload = buf.subarray(off, off + len)
  if (masked) {
    const unmasked = Buffer.from(payload)
    for (let i = 0; i < unmasked.length; i++) unmasked[i] ^= mask[i & 3]
    return { opcode, text: unmasked.toString('utf8') }
  }
  return { opcode, text: payload.toString('utf8') }
}

/** 帧编码：服务端→客户端文本帧不掩码 */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

/** 向全部在线连接推送一条事件（mock 侧模拟服务端广播；构造端点在请求处理期调用） */
function broadcastWs(type, data, instanceId) {
  const frame = encodeTextFrame(
    JSON.stringify({ type, ...(instanceId ? { instanceId } : {}), data, timestamp: Date.now() }),
  )
  for (const s of wsSockets) {
    try {
      s.write(frame)
    } catch {
      wsSockets.delete(s)
    }
  }
}

const wsSockets = new Set()

server.on('upgrade', (req, socket) => {
  const url = req.url ?? ''
  if (!url.startsWith('/ws')) return socket.destroy()
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const chosen = authProtocol(protocols)
  const firstFrameAuth = !chosen // 无凭据握手 → 走首帧鉴权通道（客户端主线）
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (chosen ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : '') +
      `\r\n`,
  )
  socket.setNoDelay(true)
  // WS 连接分组：drop-ws 这类「断开实时通道」的场景只该断自己那一组，不能把同轮
  // 其它 spec 正常断言的连接一起掐掉（实测它确实打到过别的 spec）。分组随握手请求头
  // 携带（Playwright 的 extraHTTPHeaders 会带到 WS 握手，已实测）
  socket.mockWsGroup = String(req.headers['x-mock-ws-group'] ?? '')
  // 逐连接场景态：握手请求头携带的覆写在 status 快照里沿用（与 REST 同源）
  socket.mockRunning = req.headers['x-mock-instance-running'] === 'true'
    ? true
    : req.headers['x-mock-instance-running'] === 'false' ? false : null
  // 首帧鉴权状态（对齐真实端：鉴权前收到非 auth 消息即断连）
  let authed = !firstFrameAuth
  wsSockets.add(socket)
  socket.on('data', (buf) => {
    // 一个 TCP 段可能含多帧（客户端限速下实际只有单帧，够用）
    let frame
    try {
      frame = decodeFrame(buf)
    } catch {
      return
    }
    if (!frame || frame.opcode !== 0x1) return
    let msg
    try {
      msg = JSON.parse(frame.text)
    } catch {
      return
    }
    if (msg.type === 'auth') {
      // 首帧鉴权回执（mock 恒放行）：与真实端一致——收到 auth 才回执 ok
      if (authed) return
      authed = true
      socket.write(encodeTextFrame(JSON.stringify({ type: 'auth', ok: true, timestamp: Date.now() })))
      return
    }
    // 鉴权前收到非 auth 消息：与真实端一致断连（暴露鉴权前发消息的客户端回归）
    if (!authed) return socket.destroy()
    if (msg.type === 'ping') {
      socket.write(encodeTextFrame(JSON.stringify({ type: 'pong', timestamp: Date.now() })))
      return
    }
    if (msg.type === 'subscribe' && msg.instanceId) {
      // 订阅即回 status 快照（对齐 websocket.js subscribe 分支）
      socket.write(
        encodeTextFrame(
          JSON.stringify({
            type: 'status',
            instanceId: msg.instanceId,
            data: {
              status: (socket.mockRunning ?? instance.isRunning) ? 'running' : 'stopped',
              isRunning: socket.mockRunning ?? instance.isRunning,
              players: instance.players,
              tps: instance.tps,
            },
            timestamp: Date.now(),
          }),
        ),
      )
    }
  })
  socket.on('close', () => wsSockets.delete(socket))
  socket.on('error', () => wsSockets.delete(socket))
})

server.listen(PORT, () => {
  console.log(`[mock-server] listening on http://localhost:${PORT}`)
})
