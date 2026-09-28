import { http, HttpResponse } from 'msw'
import { restoreConfirmTarget } from '@mc-commander/schemas'
import { LEGACY_GAMERULES } from '@/lib/mc-gamerules'
import { todayIso } from '@/lib/mc-calendar'
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
  taskRunHistorySchema,
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
  worldSize: 1.2,
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
  lastSave: new Date(Date.now() - 5 * 60_000).toISOString(),
  gameDays: 42,
  dimensions: [
    { name: '主世界', icon: '🌍', playerCount: 2 },
    { name: '下界', icon: '🔥', playerCount: 1 },
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
    {
      name: 'server.properties',
      path: '/server.properties',
      type: 'file',
      size: 1024,
      modifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
      isDirectory: false,
    },
    {
      name: 'whitelist.json',
      path: '/whitelist.json',
      type: 'file',
      size: 128,
      modifiedAt: new Date(Date.now() - 7_200_000).toISOString(),
      isDirectory: false,
    },
    {
      name: 'ops.json',
      path: '/ops.json',
      type: 'file',
      size: 64,
      modifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
      isDirectory: false,
    },
    {
      name: 'world',
      path: '/world',
      type: 'directory',
      size: 0,
      modifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
      isDirectory: true,
    },
    {
      name: 'logs',
      path: '/logs',
      type: 'directory',
      size: 0,
      modifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
      isDirectory: true,
    },
  ],
}

export const mockFileListWorld: FileListResponse = {
  path: '/world',
  isDirectory: true,
  files: [
    {
      name: 'level.dat',
      path: '/world/level.dat',
      type: 'file',
      size: 2048,
      modifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
      isDirectory: false,
    },
    {
      name: 'region',
      path: '/world/region',
      type: 'directory',
      size: 0,
      modifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
      isDirectory: true,
    },
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

export const mockBans: BanRecord[] = [
  {
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
/** 部署 mock 控制：cancelEcho 模拟「部署被取消后在途请求以 409 40915 结束」 */
export const deployMock: {
  shouldFail: boolean
  cancelEcho: boolean
  /** 取消回声携带的收尾明细（服务端 details.cleanup；null = 收尾正常） */
  cancelEchoDetails: unknown
  lastBody: { eula?: boolean } | null
} = {
  shouldFail: false,
  cancelEcho: false,
  cancelEchoDetails: null,
  lastBody: null,
}

/** 取消部署（POST /instances/deploy/cancel）mock 控制：notInFlight 模拟服务端 40906（任务已结束） */
export const deployCancelMock: { notInFlight: boolean; lastBody: { instanceId?: string } | null } =
  {
    notInFlight: false,
    lastBody: null,
  }

/**
 * 部署进度兜底快照开关（测试注入）：默认空态（无在途部署），
 * 用例置 active 后 mock GET /instances/deploy/status 返回在途快照
 * （结构占位虚构数据，严禁真实服务器信息）
 */
export const deployStatusMock: { active: boolean } = { active: false }

/** 实例列表运行态开关（测试注入：false → 卡片显示启动按钮，供 EULA 首启用例） */
export const instanceListMock = { running: true }

/** 启动开关（测试注入：eulaRequired=EULA 首启特例 / shouldFail=普通失败；calls 供断言续启） */
export const startMock = { eulaRequired: false, shouldFail: false, calls: 0 }

/** EULA 写入开关（测试注入：shouldFail=写入失败；calls 供断言自动同意） */
export const eulaMock = { shouldFail: false, calls: 0 }

/**
 * 卸载开关（测试注入）：retainedBackupCount=0 走服务端 409 前置清单校验分支；
 * bodies 记录每次请求体，供断言二次确认带上了 acknowledgeIrreversible；
 * expectedName 覆盖「实例名不匹配 → 400」场景
 */
export const uninstallMock = {
  calls: 0,
  retainedBackupCount: 0,
  bodies: [] as Record<string, unknown>[],
  expectedName: null as string | null,
}

/** 升级失败开关（测试注入：结构占位，非真实错误） */
export const upgradeMock = { shouldFail: false, conflict: false }

/** 取消升级（POST /instances/:id/upgrade/cancel）mock 控制：notInProgress 模拟服务端 40908 */
export const upgradeCancelMock: { notInProgress: boolean; calls: number } = {
  notInProgress: false,
  calls: 0,
}

/** 恢复端点 mock 控制：instanceName 覆盖实例名场景（空串 = 无名称实例）；bodies 供请求体断言 */
export const restoreMock: {
  instanceName: string | null
  calls: number
  bodies: { confirmName?: string }[]
} = { instanceName: null, calls: 0, bodies: [] }

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
    name: '手动备份',
    description: null,
    type: 'manual',
    size: 524_288_000,
    status: 'completed',
    worldName: 'world',
    createdAt: '2026-08-14T20:00:00.000Z',
    updatedAt: '2026-08-14T20:05:00.000Z',
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
    createdAt: '2026-07-02T08:00:00.000Z',
    updatedAt: '2026-07-02T08:00:30.000Z',
  },
]

/** 备份域 mock 端点（服务端 routes/backups.js 契约） */
const backupHandlers = [
  http.get('*/api/v1/instances/:id/backups', () => ok(backupItemSchema.array().parse(mockBackups))),
  // 归档清点/挂载必须排在 `/backups/:id` 之前：MSW 首个匹配胜出，而 `:id` 是通配段，
  // 排在前面会把 `/backups/archived` 当详情查询吃掉（返回 404 → 面板渲染清点失败）
  // 归档快照：默认空清单（多数用例不关心）；需要的用例自行 use() 覆盖
  http.get('*/api/v1/backups/archived', () => ok([])),
  // 挂载：默认「没有可挂载项」；用例自行 use() 覆盖出参与失败分支
  http.post('*/api/v1/instances/:id/backups/attach', () => ok({ attached: 0, skipped: 0 })),
  http.get('*/api/v1/backups/:id', ({ params }) => {
    const found = mockBackups.find((b) => String(b.id) === String(params.id))
    return found
      ? ok(found)
      : HttpResponse.json(
          {
            status: 'error',
            code: 40403,
            message: '备份不存在',
            details: null,
            timestamp: new Date().toISOString(),
          },
          { status: 404 },
        )
  }),
  http.post('*/api/v1/instances/:id/backups', () =>
    ok({
      id: 12,
      instanceId: 'demo',
      // 与服务端默认命名同源（routes/backups.js：未传 name 时用 Backup_<本地日期>，
      // 见服务端 utils/local-date.js——UTC 口径会在东八区凌晨写成昨天）
      name: `Backup_${todayIso()}`,
      description: null,
      type: 'manual',
      size: 0,
      status: backupMock.createStatus,
      worldName: 'world',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  ),
  // 恢复：服务端强制确认串（缺/不匹配 → 400 40017）。按真实语义校验（同用契约层的
  // restoreConfirmTarget 派生链），前端漏带/带错 confirmName 的回归会直接红
  http.post('*/api/v1/backups/:id/restore', async ({ request, params }) => {
    const body = (await request.json().catch(() => ({}))) as { confirmName?: string }
    restoreMock.calls += 1
    restoreMock.bodies.push(body)
    const backup = mockBackups.find((b) => String(b.id) === String(params.id))
    const expected = restoreConfirmTarget({
      instanceName: restoreMock.instanceName ?? mockInstanceStatus.name,
      backupName: backup?.name,
      backupId: String(params.id ?? ''),
    })
    if ((body.confirmName ?? '').trim() !== expected) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40017,
          message: '需在请求体提供 confirmName 且与该备份所属实例名完全一致才能恢复',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 400 },
      )
    }
    return ok(null)
  }),
  http.delete('*/api/v1/backups/:id', () => ok(null)),
  // 下载（GET /backups/:id/download；gzip magic bytes 占位流，服务端为 tar.gz 流）
  http.get(
    '*/api/v1/backups/:id/download',
    () =>
      new HttpResponse(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]), {
        status: 200,
        headers: { 'Content-Type': 'application/gzip' },
      }),
  ),
]

/** 玩家域 mock 端点 */
const playerHandlers = [
  http.get('*/api/v1/instances/:id/players/bans', () =>
    ok(banRecordSchema.array().parse(mockBans)),
  ),
  http.get('*/api/v1/instances/:id/players/:player/details', ({ params }) => {
    const found = mockPlayers.find((p) => p.name === params.player)
    return found
      ? ok(found)
      : HttpResponse.json(
          {
            status: 'error',
            code: 40403,
            message: '玩家不存在',
            details: null,
            timestamp: new Date().toISOString(),
          },
          { status: 404 },
        )
  }),
  http.get('*/api/v1/instances/:id/players', () => ok(playerSchema.array().parse(mockPlayers))),
  http.post('*/api/v1/instances/:id/players/:player/op', () => ok(null)),
  http.delete('*/api/v1/instances/:id/players/:player/op', () => ok(null)),
  http.post('*/api/v1/instances/:id/players/:player/kick', () => ok(null)),
  http.post('*/api/v1/instances/:id/players/:player/ban', () =>
    ok({ expiresAt: Date.now() + 3_600_000 }),
  ),
  http.post('*/api/v1/instances/:id/players/:player/pardon', () => ok(null)),
  http.post('*/api/v1/instances/:id/players/bans/:target/pardon', () => ok(null)),
  http.post('*/api/v1/instances/:id/players/:player/whitelist/add', () => ok(null)),
  http.delete('*/api/v1/instances/:id/players/:player/whitelist', () => ok(null)),
]

export const handlers = [
  ...playerHandlers,
  ...backupHandlers,
  // 任务执行历史（编辑对话框最近执行时间线；结构占位，虚构任务数据）
  http.get('*/api/v1/tasks/:id/history', () =>
    ok(
      taskRunHistorySchema.array().parse([
        {
          id: 12,
          taskId: 1,
          runAt: '2026-09-02T04:00:05.000Z',
          status: 'success',
          error: null,
          durationMs: 850,
        },
        {
          id: 11,
          taskId: 1,
          runAt: '2026-09-01T04:00:03.000Z',
          status: 'failed',
          error: 'RCON 不可用（虚构占位文案）',
          durationMs: 3000,
        },
        {
          id: 10,
          taskId: 1,
          runAt: '2026-08-31T04:00:01.000Z',
          status: 'skipped',
          error: null,
          durationMs: null,
        },
      ]),
    ),
  ),
  http.get('*/api/v1/overview', () => ok(overviewDataSchema.parse(mockOverview))),
  http.get('*/api/v1/system-stats', () => ok(systemStatsSchema.parse(mockSystemStats))),
  http.get('*/api/v1/check-update', () =>
    ok({ current: '0.1.0', latest: null, hasUpdate: false, offline: true }),
  ),
  http.get('*/api/v1/instances', () =>
    ok([
      instanceStatusSchema.parse({ ...mockInstanceStatus, isRunning: instanceListMock.running }),
    ]),
  ),
  http.get('*/api/v1/instances/:id', () => ok(instanceStatusSchema.parse(mockInstanceStatus))),
  // DELETE /instances/:id 卸载：实例名确认由服务端强制（前端输入框只是 UX）；
  // 备份清单为空时还必须带 acknowledgeIrreversible（与 routes/status.js 同语义）
  http.delete('*/api/v1/instances/:id', async ({ request }) => {
    uninstallMock.calls += 1
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    uninstallMock.bodies.push(body)
    const expectedName = uninstallMock.expectedName ?? mockInstanceStatus.name
    // 与服务端同口径：两侧 trim 后比对（兼容库里带首尾空白的旧实例名）
    if (typeof body.confirmName !== 'string' || body.confirmName.trim() !== expectedName.trim()) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40016,
          message: '需在请求体提供 confirmName 且与实例名完全一致才能卸载实例',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 400 },
      )
    }
    // 与服务端同口径：空名实例的实例名确认空转 → 额外要求 acknowledgeIrreversible（40916）
    if (expectedName.trim() === '' && body.acknowledgeIrreversible !== true) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40916,
          message:
            '该实例无名称，名称确认不构成有效确认；确认后请携带 acknowledgeIrreversible=true 重试',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      )
    }
    if (uninstallMock.retainedBackupCount === 0 && body.acknowledgeIrreversible !== true) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40914,
          message:
            '该实例没有任何备份，删除后世界数据与配置不可恢复；确认后请携带 acknowledgeIrreversible=true 重试',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      )
    }
    // 与真实契约同形：数量全量、名字只列最近 10 条（按修改时间倒序）
    const count = uninstallMock.retainedBackupCount
    return ok({
      retainedBackupCount: count,
      retainedBackupNames: Array.from(
        { length: Math.min(count, 10) },
        (_, i) => `快照-${String(i + 1).padStart(2, '0')}`,
      ),
    })
  }),
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
  http.post('*/api/v1/instances/:id/start', () => {
    startMock.calls += 1
    if (startMock.eulaRequired) {
      // 服务端 start 前置检查：eula.txt 缺失或 eula=false → 403 EULA_NOT_ACCEPTED
      return HttpResponse.json(
        {
          status: 'error',
          code: 40000,
          message: 'EULA_NOT_ACCEPTED',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 403 },
      )
    }
    if (startMock.shouldFail) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 50000,
          message: 'start failed',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 500 },
      )
    }
    return ok({ started: true })
  }),
  // POST /instances/:id/eula 写入 EULA 协议确认（eulaAgree 开关控制失败）
  http.post('*/api/v1/instances/:id/eula', () => {
    eulaMock.calls += 1
    if (eulaMock.shouldFail) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 50000,
          message: 'eula write failed',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 500 },
      )
    }
    return ok({ accepted: true })
  }),
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
    return ok({
      path: body.path ?? '/server.properties',
      size: 1024,
      modifiedAt: new Date().toISOString(),
    })
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
  // ── 部署域 ──
  // 部署进度兜底快照（GET /instances/deploy/status；服务端契约 deployStatusResponseSchema）
  http.get('*/api/v1/instances/deploy/status', () =>
    ok(
      deployStatusMock.active
        ? {
            deploying: true,
            instanceId: 'paper-a1b2c3d4',
            instanceName: '生存服',
            type: 'paper',
            mcVersion: '1.21.4',
            stage: 'forge_install',
            percent: 0.45,
            transferred: 52_428_800,
            total: 104_857_600,
            updatedAt: Date.now(),
          }
        : { deploying: false },
    ),
  ),
  http.post('*/api/v1/instances/deploy/cancel', async ({ request }) => {
    const body = (await request.json()) as { instanceId?: string }
    deployCancelMock.lastBody = body
    if (deployCancelMock.notInFlight) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40906,
          message: 'No deployment in progress for this instance',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      )
    }
    return ok({ instanceId: body.instanceId ?? 'paper-a1b2c3d4', cancelled: true })
  }),
  http.post('*/api/v1/instances/deploy', async ({ request }) => {
    if (deployMock.cancelEcho) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40915,
          message: 'Task cancelled by user',
          details: deployMock.cancelEchoDetails,
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      )
    }
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
      eula?: boolean
    }
    deployMock.lastBody = body
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
  // ── 升级域──
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
  http.post('*/api/v1/instances/:id/upgrade/cancel', ({ params }) => {
    upgradeCancelMock.calls += 1
    if (upgradeCancelMock.notInProgress) {
      return HttpResponse.json(
        {
          status: 'error',
          code: 40908,
          message: 'No upgrade in progress for this instance',
          details: null,
          timestamp: new Date().toISOString(),
        },
        { status: 409 },
      )
    }
    return ok({ instanceId: String(params.id ?? 'inst-001'), cancelled: true })
  }),
  http.get('*/api/v1/instances/:id/upgrade/status', () => ok(upgradeStatusMock)),
  // 未提供凭据场景：401（与服务端 authMiddleware 的无凭据分支同码同文案：
  // 40107 AUTH_CREDENTIALS_REQUIRED，与「凭据无效」的 40101 分开）
  http.get('*/api/v1/unauthorized-probe', () =>
    HttpResponse.json(
      {
        status: 'error',
        code: 40107,
        message: '未提供访问凭据：请携带 X-API-Key 头或登录会话令牌',
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
        message:
          '无法执行在线备份：服务器未启用 RCON。请先停止服务器，或在 server.properties 启用 RCON',
        details: null,
        timestamp: new Date().toISOString(),
      },
      { status: 409 },
    ),
  ),
  // 40000 校验失败场景：HTTP 400 错误信封（信封级 GET 请求路径测试）
  http.get('*/api/v1/bad-request-probe', () =>
    HttpResponse.json(
      {
        status: 'error',
        code: 40000,
        message: 'Validation Error',
        details: null,
        timestamp: new Date().toISOString(),
      },
      { status: 400 },
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
    ok({
      token: 'mock-session-token-0123456789abcdef',
      sessionId: 'sess-mock-1',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }),
  ),
  // 首访设密（同登录响应）
  http.post('*/api/v1/auth/setup', async () =>
    ok({
      hasPassword: true,
      token: 'mock-session-token-0123456789abcdef',
      sessionId: 'sess-mock-1',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }),
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
  // 两步验证状态（默认未启用；各用例按需覆写 enabled/剩余数量）
  http.get('*/api/v1/auth/totp/status', () =>
    ok({ enabled: false, confirmedAt: null, recoveryCodesRemaining: 0 }),
  ),
  // 部署能力（默认 API Key 通道开放；关闭态由用例覆写为 apiKeyEnabled: false）
  http.get('*/api/v1/auth/capabilities', () =>
    ok({ apiKeyEnabled: true, readonlyApiKeyEnabled: true, readonlyApiKeyConfigured: false }),
  ),
  // 只读凭据生成/轮换（设置页面板用；默认返回标记串，具体用例自行 use() 覆盖）
  http.post('*/api/v1/rotate-readonly-key', () =>
    ok({ apiKey: 'mcro-mock-0000-0000-0000-0000-0000-0000-0000' }),
  ),
]
