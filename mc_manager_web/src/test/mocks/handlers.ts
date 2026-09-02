import { http, HttpResponse } from 'msw'
import { LEGACY_GAMERULES } from '@/lib/mc-gamerules'
import type {
  BackupItem,
  BanRecord,
  ScheduledTask,
  FileContentResponse,
  FileListResponse,
  InstanceStatus,
  OverviewData,
  Player,
  ServerProperties,
  SystemStats,
  WorldInfo,
} from '@/api/types'
import {
  overviewDataSchema,
  systemStatsSchema,
  playerSchema,
  banRecordSchema,
  backupItemSchema,
  instanceStatusSchema,
} from '@mc-commander/schemas'

/**
 * MSW handlers 基座（设计文档 §六：单测/组件测试拦截 API）
 * 数据为结构占位 mock，使用虚构测试数据，不含真实服务器信息/玩家数据
 */

export const mockOverview: OverviewData = {
  version: '0.1.0',
  instanceCount: 1,
  runningCount: 1,
  totalPlayers: 0,
  systemCpuUsage: 12.5,
  systemMemoryUsage: 4.2,
  systemMemoryTotal: 16,
  systemMemoryPercent: 26.3,
  totalMemory: 16,
  freeMemory: 11.8,
  instances: [{ id: 'demo', name: '演示实例', isRunning: true, playerCount: 0 }],
}

export const mockSystemStats: SystemStats = {
  cpuUsage: 12.5,
  memoryUsage: 4.2,
  totalMemory: 16,
  memoryPercent: 26.3,
  cpuCores: 4,
  loadAvg: [0.1, 0.2, 0.15],
  uptime: 86_400,
}

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

/** 实例详情 mock（可运行实例；TPS 健康 20） */
export const mockInstanceStatus: InstanceStatus = {
  id: 'demo',
  name: '演示实例',
  isRunning: true,
  isRconConnected: true,
  autoRestart: true,
  autoStart: false,
  circuitBreakerTripped: false,
  consecutiveCrashes: 0,
  uptime: 7200,
  address: 'localhost:25565',
  players: [],
  playerCount: 3,
  maxPlayers: 20,
  todayNewPlayers: 2,
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
  opNames: ['Steve'],
  sleepingPlayers: 1,
  sleepingPlayerNames: ['Alex'],
  awakePlayerNames: ['Steve', 'Bob'],
  totalUptime: 86400,
  startTime: new Date(Date.now() - 7200_000).toISOString(),
  startCommand: null,
  jvmArgs: null,
  javaPath: 'java',
  maxMemory: 4096,
  minMemory: 1024,
  jarFile: 'server.jar',
}

// ── 玩家 mock 数据（结构占位，虚构玩家名）──────────────────────
const statsPlaceholder: Player['stats'] = {
  totalOnline: 86_400,
  loginCount: 12,
  offlineSince: 0,
  deathCount: 3,
  achievementCount: 25,
  sleepCount: 2,
}

function mockPlayer(overrides: Partial<Player>): Player {
  return {
    name: 'Steve',
    uuid: '00000000-0000-4000-8000-000000000001',
    isOnline: true,
    ip: '',
    joinTime: Date.now() - 3_600_000,
    onlineTime: 3600,
    totalPlayTime: 36_000,
    isOp: false,
    isWhitelisted: false,
    isBanned: false,
    banExpiresAt: null,
    isIpBanned: false,
    ipBanExpiresAt: null,
    isFakePlayer: false,
    lastSeen: new Date().toISOString(),
    health: 20,
    maxHealth: 20,
    hunger: 18,
    xpLevel: 12,
    spawnPoint: { x: 0, y: 64, z: 0 },
    respawnPoint: null,
    position: { x: 123.5, y: 64, z: -456.2 },
    gameMode: 'survival',
    dimension: 'overworld',
    armor: 15,
    xpProgress: 0.4,
    ping: 35,
    isSleeping: false,
    isAfk: false,
    isFlying: false,
    isSneaking: false,
    isSprinting: false,
    isBurning: false,
    isFrozen: false,
    potionEffects: [],
    ipHistory: [],
    inventory: null,
    events: [],
    sessions: [],
    stats: { ...statsPlaceholder },
    ...overrides,
  }
}

export const mockPlayers: Player[] = [
  mockPlayer({ name: 'Steve', isOp: true }),
  mockPlayer({
    name: 'Alex',
    uuid: '00000000-0000-4000-8000-000000000002',
    isSleeping: true,
    gameMode: 'creative',
    potionEffects: [
      { id: 'speed', name: '迅捷', level: 2, durationSeconds: 240, isBeneficial: true },
    ],
  }),
  mockPlayer({
    name: 'Bob',
    uuid: '00000000-0000-4000-8000-000000000003',
    isOnline: false,
    isWhitelisted: true,
    totalPlayTime: 180_000,
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    armor: null,
    ping: null,
    position: null,
    gameMode: 'survival',
    dimension: 'overworld',
    joinTime: null,
    onlineTime: 0,
    lastSeen: new Date(Date.now() - 86_400_000).toISOString(),
  }),
  mockPlayer({
    name: 'Charlie',
    uuid: '00000000-0000-4000-8000-000000000004',
    isOnline: false,
    isBanned: true,
    banExpiresAt: Date.now() + 43_200_000,
    health: null,
    maxHealth: null,
    hunger: null,
    xpLevel: null,
    armor: null,
    ping: null,
    position: null,
    joinTime: null,
    onlineTime: 0,
    lastSeen: new Date(Date.now() - 172_800_000).toISOString(),
  }),
  mockPlayer({
    name: 'Bot_farm1',
    uuid: '00000000-0000-4000-8000-000000000005',
    isFakePlayer: true,
    dimension: 'nether',
  }),
]

// ── 世界/属性/文件 mock 数据（结构占位，虚构内容）─────────────────
export const mockWorldInfo: WorldInfo = {
  name: '演示世界',
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
  maxWorldSize: 29_999_984,
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
    { name: '地狱', icon: '🔥', playerCount: 1 },
    { name: '末地', icon: '🟣', playerCount: 0 },
  ],
}

/** 9 个敏感键占位符掩码 + 常用键（结构与真实 server.properties 对齐） */
export const mockProperties: ServerProperties = {
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
  motd: '演示服务器',
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

export const mockServerPropertiesText = `#Minecraft server properties
#MSW mock 文件内容（虚构占位，勿当真）
motd=演示服务器
difficulty=normal
gamemode=survival
white-list=false
max-players=20
view-distance=10
online-mode=true
`

export const mockFileListRoot: FileListResponse = {
  path: '/',
  isDirectory: true,
  files: [
    { name: 'server.properties', path: '/server.properties', type: 'file', size: 1024, modifiedAt: new Date(Date.now() - 3_600_000).toISOString(), isDirectory: false },
    { name: 'whitelist.json', path: '/whitelist.json', type: 'file', size: 128, modifiedAt: new Date(Date.now() - 7_200_000).toISOString(), isDirectory: false },
    { name: 'ops.json', path: '/ops.json', type: 'file', size: 64, modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), isDirectory: false },
    { name: 'world', path: '/world', type: 'directory', size: 0, modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), isDirectory: true },
    { name: 'logs', path: '/logs', type: 'directory', size: 0, modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), isDirectory: true },
  ],
}

export const mockFileListWorld: FileListResponse = {
  path: '/world',
  isDirectory: true,
  files: [
    { name: 'level.dat', path: '/world/level.dat', type: 'file', size: 2048, modifiedAt: new Date(Date.now() - 3_600_000).toISOString(), isDirectory: false },
    { name: 'region', path: '/world/region', type: 'directory', size: 0, modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), isDirectory: true },
  ],
}

export const mockFileContent: FileContentResponse = {
  path: '/server.properties',
  name: 'server.properties',
  size: 1024,
  content: mockServerPropertiesText,
  encoding: 'utf-8',
  modifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
}

// ── 定时任务 mock 数据（结构占位，虚构内容）─────────────────
export const mockTasks: ScheduledTask[] = [
  {
    id: 1,
    instanceId: 'demo',
    name: '每日自动重启',
    type: 'restart',
    cronExpression: '0 4 * * *',
    command: null,
    isEnabled: true,
    lastRunAt: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    lastRunStatus: 'success',
    lastRunError: null,
    nextRunAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  },
  {
    id: 2,
    instanceId: 'demo',
    name: '每日备份',
    type: 'backup',
    cronExpression: '0 0 * * *',
    command: null,
    isEnabled: true,
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunError: null,
    nextRunAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  },
  {
    id: 3,
    instanceId: 'demo',
    name: '清理告示牌命令',
    type: 'command',
    cronExpression: '*/30 * * * *',
    command: 'say 服务器每半小时自动公告',
    isEnabled: false,
    lastRunAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lastRunStatus: 'failed',
    lastRunError: 'RCON 不可用',
    nextRunAt: null,
    createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
]

export const mockBans: BanRecord[] = [  {
    targetType: 'player',
    target: 'Charlie',
    reason: '作弊',
    isActive: true,
    isPermanent: false,
    expiresAt: Date.now() + 43_200_000,
    createdAt: new Date(Date.now() - 43_200_000).toISOString(),
  },
  {
    targetType: 'player',
    target: 'Ghost',
    reason: '恶意破坏',
    isActive: false,
    isPermanent: false,
    expiresAt: Date.now() - 3_600_000,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
]

/** 部署失败开关（测试注入：结构占位，非真实错误） */
export const deployMock = { shouldFail: false }

/** 升级失败开关（测试注入：结构占位，非真实错误） */
export const upgradeMock = { shouldFail: false, conflict: false }

/** 升级状态轮询 mock（测试注入：模拟断线后轮询返回的进度） */
export const upgradeStatusMock = {
  upgrading: true,
  stage: 'download',
  percent: 80,
  detail: '正在下载新版本服务端…',
}

/** 版本列表 mock（结构占位版本号；fabric 额外带 loaders） */
const mockVersions = {
  vanilla: { versions: ['1.21.4', '1.21.1'] },
  paper: { versions: ['1.21.4', '1.21.1'] },
  fabric: { versions: ['1.21.4', '1.21.1'], loaders: ['0.16.9', '0.15.11'] },
  forge: { versions: ['1.21.4', '1.21.1'] },
  purpur: { versions: ['1.21.4', '1.21.1'] },
} as const

// ── 备份 mock（结构占位虚构数据）────────────

/** 备份状态机 mock（测试注入：模拟 creating → completed 状态流转） */
export const backupMock = { createStatus: 'creating' as 'creating' | 'completed' }

export const mockBackups: BackupItem[] = [
  {
    id: 11,
    instanceId: 'demo',
    name: '手动备份 2026-08-14',
    description: null,
    type: 'manual',
    size: 524_288_000,
    status: 'completed',
    worldName: 'world',
    format: 'snapshot',
    createdAt: '2026-08-14T20:00:00.000Z',
    updatedAt: '2026-08-14T20:05:00.000Z',
  },
  {
    id: 10,
    instanceId: 'demo',
    name: '旧格式压缩包',
    description: null,
    type: 'manual',
    size: 102_400_000,
    status: 'completed',
    worldName: 'world',
    format: 'zip',
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-01T08:10:00.000Z',
  },
  {
    id: 9,
    instanceId: 'demo',
    name: '失败的备份',
    description: null,
    type: 'manual',
    size: 0,
    status: 'failed',
    worldName: 'world',
    format: 'snapshot',
    createdAt: '2026-07-02T08:00:00.000Z',
    updatedAt: '2026-07-02T08:00:30.000Z',
  },
]

/** 备份域 mock 端点（服务端 routes/backups.js 契约） */
const backupHandlers = [
  http.get('*/api/v1/instances/:id/backups', () => ok(backupItemSchema.array().parse(mockBackups))),
  http.get('*/api/v1/backups/:id', ({ params }) => {
    const found = mockBackups.find((b) => String(b.id) === String(params.id))
    return found ? ok(found) : HttpResponse.json(
      { status: 'error', code: 40403, message: '备份不存在', details: null, timestamp: new Date().toISOString() },
      { status: 404 },
    )
  }),
  http.post('*/api/v1/instances/:id/backups', () =>
    ok({
      id: 12,
      instanceId: 'demo',
      name: '手动备份 2026-08-15',
      description: null,
      type: 'manual',
      size: 0,
      status: backupMock.createStatus,
      worldName: 'world',
      format: 'snapshot',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  ),
  http.post('*/api/v1/backups/:id/restore', () => ok(null)),
  http.delete('*/api/v1/backups/:id', () => ok(null)),
]

/** 玩家域 mock 端点 */
const playerHandlers = [
  http.get('*/api/v1/instances/:id/players/bans', () => ok(banRecordSchema.array().parse(mockBans))),
  http.get('*/api/v1/instances/:id/players/:player/details', ({ params }) => {
    const found = mockPlayers.find((p) => p.name === params.player)
    return found ? ok(found) : HttpResponse.json(
      { status: 'error', code: 40403, message: '玩家不存在', details: null, timestamp: new Date().toISOString() },
      { status: 404 },
    )
  }),
  http.get('*/api/v1/instances/:id/players', () => ok(playerSchema.array().parse(mockPlayers))),
  http.post('*/api/v1/instances/:id/players/:player/op', () => ok(null)),
  http.delete('*/api/v1/instances/:id/players/:player/op', () => ok(null)),
  http.post('*/api/v1/instances/:id/players/:player/kick', () => ok(null)),
  http.post('*/api/v1/instances/:id/players/:player/ban', () => ok({ expiresAt: Date.now() + 3_600_000 })),
  http.post('*/api/v1/instances/:id/players/:player/pardon', () => ok(null)),
  http.post('*/api/v1/instances/:id/players/bans/:target/pardon', () => ok(null)),
  http.post('*/api/v1/instances/:id/players/:player/whitelist/add', () => ok(null)),
  http.delete('*/api/v1/instances/:id/players/:player/whitelist', () => ok(null)),
]

export const handlers = [
  ...playerHandlers,
  ...backupHandlers,
  http.get('*/api/v1/overview', () => ok(overviewDataSchema.parse(mockOverview))),
  http.get('*/api/v1/system-stats', () => ok(systemStatsSchema.parse(mockSystemStats))),
  http.get('*/api/v1/check-update', () => ok({ current: '0.1.0', latest: null, hasUpdate: false, offline: true })),
  http.get('*/api/v1/instances', () => ok([instanceStatusSchema.parse(mockInstanceStatus)])),
  http.get('*/api/v1/instances/:id', () => ok(instanceStatusSchema.parse(mockInstanceStatus))),
  // PUT /instances/:id 实例配置更新（启动配置弹窗；回显提交字段，结构占位）
  http.put('*/api/v1/instances/:id', async ({ request, params }) => {
    const body = (await request.json()) as Record<string, unknown>
    return ok({ ...mockInstanceStatus, id: String(params.id), ...body })
  }),
  http.get('*/api/v1/instances/:id/logs', () =>
    ok([
      { text: '[00:00:01] [Server thread/INFO]: Starting minecraft server', type: 'stdout' },
      { text: '[00:00:05] [Server thread/INFO]: Done (1.2s)!', type: 'stdout' },
    ]),
  ),
  // API Key 轮换（返回固定 mock 新 key；测试断言格式与 store 更新）
  http.post('*/api/v1/rotate-key', () => ok({ apiKey: 'mcck-mock-0000-0000-0000-0001' })),
  http.post('*/api/v1/instances/:id/start', () => ok({ started: true })),
  http.post('*/api/v1/instances/:id/stop', () => ok({ stopped: true })),
  http.post('*/api/v1/instances/:id/restart', () => ok({ restarted: true })),
  http.post('*/api/v1/instances/:id/command', async ({ request }) => {
    const body = (await request.json()) as { command?: string }
    const cmd = body.command ?? ''
    // gamerule 无参查询 → 全量规则文本（≥ defs 1/3 才能过 parseGameruleOutput 阈值，取前 20 条）
    if (/^gamerule\s*$/i.test(cmd)) {
      const lines = LEGACY_GAMERULES.slice(0, 20)
        .map((r) => `${r.name} = ${String(r.defaultValue)}`)
        .join('\n')
      return ok(lines)
    }
    // gamerule 修改（带值）→ RCON 成功文本
    if (/^gamerule\s+\S+\s+\S+\s*$/i.test(cmd)) {
      return ok('Game rule has been updated')
    }
    return ok({ response: `已执行: ${cmd}` })
  }),
  // ── 世界/属性域 ──
  http.get('*/api/v1/instances/:id/world', () => ok(mockWorldInfo)),
  http.get('*/api/v1/instances/:id/properties', () => ok(mockProperties)),
  http.put('*/api/v1/instances/:id/properties', () => ok({ restartRequired: [] })),
  // ── 文件域 ──
  http.get('*/api/v1/instances/:id/files/content', ({ request }) => {
    const filePath = new URL(request.url).searchParams.get('path') ?? '/server.properties'
    return ok({
      ...mockFileContent,
      path: filePath,
      name: filePath.split('/').filter(Boolean).pop() || 'server.properties',
    })
  }),
  http.put('*/api/v1/instances/:id/files/content', async ({ request }) => {
    const body = (await request.json()) as { path?: string }
    return ok({ path: body.path ?? '/server.properties', size: 1024, modifiedAt: new Date().toISOString() })
  }),
  http.delete('*/api/v1/instances/:id/files', () => ok(null)),
  http.get('*/api/v1/instances/:id/files', ({ request }) => {
    const dir = new URL(request.url).searchParams.get('path') ?? '/'
    return ok(dir === '/world' ? mockFileListWorld : mockFileListRoot)
  }),
  // ── 部署/版本域 ──
  http.get('*/api/v1/versions', ({ request }) => {
    const type = new URL(request.url).searchParams.get('type') ?? 'paper'
    const mock = mockVersions[type as keyof typeof mockVersions] ?? mockVersions.paper
    return ok({
      type,
      versions: mock.versions,
      ...('loaders' in mock ? { loaders: mock.loaders } : {}),
    })
  }),
  http.post('*/api/v1/instances/deploy', async ({ request }) => {
    if (deployMock.shouldFail) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 50000,
          message: 'download failed',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 500 },
      )
    }
    const body = (await request.json()) as {
      type?: string
      mcVersion?: string
      instanceName?: string
      maxMemory?: string
      loaderVersion?: string
    }
    return ok({
      id: 'inst-deploy-001',
      name: body.instanceName ?? '新实例',
      type: body.type ?? 'paper',
      mcVersion: body.mcVersion ?? '1.21.4',
      javaVersion: '21',
      path: '/opt/mc/instances/inst-deploy-001',
      maxMemory: body.maxMemory ?? '2G',
    })
  }),
  // ── 升级域（P0-4）──
  http.post('*/api/v1/instances/:id/upgrade', async ({ request }) => {
    if (upgradeMock.conflict) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40907,
          message: 'Upgrade already in progress',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      )
    }
    if (upgradeMock.shouldFail) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 50000,
          message: 'upgrade start failed',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 500 },
      )
    }
    const body = (await request.json()) as { mcVersion?: string; type?: string }
    return HttpResponse.json(
      {
        status: 'ok',
        code: 0,
        message: 'Upgrade started',
        data: {
          message: 'Upgrade started',
          instanceId: 'inst-001',
          mcVersion: body.mcVersion ?? '1.21.4',
          type: body.type ?? 'vanilla',
        },
        timestamp: new Date().toISOString(),
      },
      { status: 202 },
    )
  }),
  http.get('*/api/v1/instances/:id/upgrade/status', () =>
    ok(upgradeStatusMock),
  ),
  // 未配置 API Key 场景：401
  http.get('*/api/v1/unauthorized-probe', () =>
    HttpResponse.json(
      {
        status: 'error',
        code: 40101,
        message: 'Invalid or expired API Key',
        details: null,
        timestamp: new Date().toISOString(),
      },
      { status: 401 },
    ),
  ),
  // 40902 服务端中文文案透传场景
  http.post('*/api/v1/backup-probe', () =>
    HttpResponse.json(
      {
        status: 'error',
        code: 40902,
        message: '无法执行在线备份：服务器未启用 RCON。请先停止服务器，或在 server.properties 启用 RCON',
        details: null,
        timestamp: new Date().toISOString(),
      },
      { status: 409 },
    ),
  ),

  // ── 安全主线：auth 端点（登录页/账号面板组件测试用） ──
  // 会话过期探针：40103（client 全局登出事件测试）
  http.get('*/api/v1/session-expired-probe', () =>
    HttpResponse.json(
      {
        status: 'error',
        code: 40103,
        message: '会话已过期，请重新登录',
        details: null,
        timestamp: new Date().toISOString(),
      },
      { status: 401 },
    ),
  ),
  // 登录状态探测（hasPassword 由测试用例按需覆写：http.all 场景在组件测试内自建 server）
  http.get('*/api/v1/auth/status', () => ok({ hasPassword: true })),
  // 密码登录（固定测试凭据）
  http.post('*/api/v1/auth/login', async () =>
    ok({ token: 'mock-session-token-0123456789abcdef', sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }),
  ),
  // 首访设密（同登录响应）
  http.post('*/api/v1/auth/setup', async () =>
    ok({ hasPassword: true, token: 'mock-session-token-0123456789abcdef', sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }),
  ),
  // 活跃会话列表
  http.get('*/api/v1/auth/sessions', () =>
    ok({
      sessions: [
        {
          id: 1,
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0',
          ip: '127.0.0.1',
          createdAt: new Date(Date.now() - 3_600_000).toISOString(),
          lastSeenAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
          current: true,
        },
      ],
    }),
  ),
  // 登出 / 改密 / 踢单设备（结构占位）
  http.post('*/api/v1/auth/logout', () => ok({ ok: true })),
  http.put('*/api/v1/auth/password', () => ok({ ok: true, kickedSessions: 2 })),
  http.delete('*/api/v1/auth/sessions/:id', () => ok({ ok: true, current: false })),
]
