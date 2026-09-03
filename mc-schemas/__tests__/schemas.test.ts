import { describe, it, expect } from 'vitest'
import {
  playerSchema,
  banRecordSchema,
  backupItemSchema,
  scheduledTaskSchema,
  taskCreatePayloadSchema,
  webhookSchema,
  instanceStatusSchema,
  apiEnvelopeSchema,
  apiErrorEnvelopeSchema,
  paginationSchema,
  wsMessageSchema,
  WS_EVENT_TYPES,
  fileEntrySchema,
  auditLogItemSchema,
  deployRequestSchema,
  pluginInfoSchema,
  worldInfoSchema,
  systemStatsSchema,
  NOTIFICATION_EVENT_TYPES,
  fileUploadQuerySchema,
  filePathRequestSchema,
  fileSaveRequestSchema,
  auditLogsQuerySchema,
  marketSearchRequestSchema,
  pluginOverwriteQuerySchema,
  pluginEnabledRequestSchema,
  marketInstallRequestSchema,
  upgradeRequestSchema,
} from '../src/index'

describe('schemas 基础校验', () => {
  it('pagination schema 解析合法数据', () => {
    const result = paginationSchema.parse({ total: 100, page: 1, pageSize: 20, totalPages: 5 })
    expect(result).toEqual({ total: 100, page: 1, pageSize: 20, totalPages: 5 })
  })

  it('apiEnvelope schema 解析成功响应', () => {
    const env = apiEnvelopeSchema.parse({
      status: 'ok', code: 0, message: 'Success', data: null, timestamp: '2026-01-01T00:00:00Z',
    })
    expect(env.status).toBe('ok')
  })

  it('apiErrorEnvelope schema 解析错误响应', () => {
    const env = apiErrorEnvelopeSchema.parse({
      status: 'error', code: 40401, message: 'Not found', details: null, timestamp: '2026-01-01T00:00:00Z',
    })
    expect(env.code).toBe(40401)
  })

  it('player schema 解析在线玩家完整数据', () => {
    const player = playerSchema.parse({
      name: 'Steve', uuid: '00000000-0000-0000-0000-000000000001', isOnline: true,
      ip: '1.2.3.4', joinTime: 1704067200000, onlineTime: 3600, totalPlayTime: 7200,
      isOp: false, isWhitelisted: false, isBanned: false, banExpiresAt: null,
      isIpBanned: false, ipBanExpiresAt: null, isFakePlayer: false, lastSeen: null,
      health: 20, maxHealth: 20, hunger: 20, xpLevel: 5, spawnPoint: null, respawnPoint: null,
      position: { x: 100, y: 64, z: -200 }, gameMode: 'survival', dimension: 'overworld',
      armor: 0, xpProgress: 0.5, ping: 50, isSleeping: false, isAfk: false,
      isFlying: false, isSneaking: false, isSprinting: false, isBurning: false, isFrozen: false,
      events: [], sessions: [], stats: {
        totalOnline: 100, loginCount: 50, offlineSince: 0,
        deathCount: 5, achievementCount: 10, sleepCount: 2,
      },
      inventory: {
        quickbar: Array(9).fill(null), main: Array(27).fill(null),
        equipment: { helmet: null, chestplate: null, leggings: null, boots: null, offhand: null },
        enderChest: Array(27).fill(null), source: 'snapshot', partial: false,
      },
    })
    expect(player.name).toBe('Steve')
    expect(player.gameMode).toBe('survival')
  })

  it('player schema 允许离线玩家最小集', () => {
    const player = playerSchema.parse({
      name: 'Alex', uuid: '00000000-0000-0000-0000-000000000002', isOnline: false,
      ip: '', joinTime: null, onlineTime: 0, totalPlayTime: 0,
      isOp: false, isWhitelisted: false, isBanned: false, banExpiresAt: null,
      isIpBanned: false, ipBanExpiresAt: null, isFakePlayer: false, lastSeen: '2026-01-01T00:00:00Z',
      health: null, maxHealth: null, hunger: null, xpLevel: null,
      spawnPoint: null, respawnPoint: null, position: null, gameMode: null, dimension: null,
      armor: null, xpProgress: null, ping: null,
      isSleeping: false, isAfk: false, isFlying: false, isSneaking: false, isSprinting: false,
      isBurning: false, isFrozen: false,
      events: [], sessions: [], stats: {
        totalOnline: 0, loginCount: 0, offlineSince: 1704067200000,
        deathCount: 0, achievementCount: 0, sleepCount: 0,
      },
      inventory: null,
    })
    expect(player.isOnline).toBe(false)
  })

  it('banRecord schema 解析封禁记录', () => {
    const ban = banRecordSchema.parse({
      targetType: 'player', target: 'Steve', reason: 'Griefing',
      isActive: true, isPermanent: false, expiresAt: 1704153600000, createdAt: '2026-01-01T00:00:00Z',
    })
    expect(ban.isPermanent).toBe(false)
  })

  it('backupItem schema 解析备份条目', () => {
    const backup = backupItemSchema.parse({
      id: 1, instanceId: 'inst-1', name: 'backup-1', description: null,
      type: 'manual', size: 1024000, status: 'completed',
      worldName: 'world', format: 'snapshot', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    })
    expect(backup.format).toBe('snapshot')
  })

  it('scheduledTask schema 解析定时任务', () => {
    const task = scheduledTaskSchema.parse({
      id: 1, instanceId: 'inst-1', name: '每日重启', type: 'restart',
      cronExpression: '0 4 * * *', command: null, isEnabled: true,
      lastRunAt: null, lastRunStatus: 'never', lastRunError: null,
      nextRunAt: '2026-01-02T04:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    })
    expect(task.type).toBe('restart')
  })

  it('WS_EVENT_TYPES 与 wsMessage schema 联动', () => {
    for (const eventType of WS_EVENT_TYPES) {
      const msg = wsMessageSchema.parse({ type: eventType, timestamp: Date.now() })
      expect(msg.type).toBe(eventType)
    }
    const pong = wsMessageSchema.parse({ type: 'pong' })
    expect(pong.type).toBe('pong')
  })

  it('NOTIFICATION_EVENT_TYPES 是 WS_EVENT_TYPES 子集', () => {
    for (const t of NOTIFICATION_EVENT_TYPES) {
      expect(WS_EVENT_TYPES).toContain(t)
    }
  })

  it('fileEntry schema 解析文件条目', () => {
    const f = fileEntrySchema.parse({
      name: 'server.properties', path: '/server.properties',
      type: 'file', size: 1234, modifiedAt: '2026-01-01T00:00:00Z', isDirectory: false,
    })
    expect(f.isDirectory).toBe(false)
  })

  it('auditLogItem schema 解析审计条目', () => {
    const a = auditLogItemSchema.parse({
      id: 1, instanceId: 'inst-1', action: 'player.ban',
      targetType: 'player', targetId: 'Steve', detail: null, source: 'web', createdAt: '2026-01-01T00:00:00Z',
    })
    expect(a.action).toBe('player.ban')
  })

  it('deployRequest schema 解析部署请求', () => {
    const d = deployRequestSchema.parse({ type: 'vanilla', mcVersion: '1.21.4', instanceName: 'test' })
    expect(d.type).toBe('vanilla')
  })

  it('pluginInfo schema 解析插件信息', () => {
    const p = pluginInfoSchema.parse({
      file: 'TestPlugin.jar', name: 'TestPlugin', enabled: true,
      sizeBytes: 1024, mtimeMs: 1704067200000, meta: {
        name: 'TestPlugin', version: '1.0.0', main: 'com.test.Main',
        apiVersion: '1.21', description: null, authors: [], depend: [],
        softdepend: [], website: null, load: null,
      },
    })
    expect(p.meta?.name).toBe('TestPlugin')
  })

  it('worldInfo schema 解析世界信息', () => {
    const w = worldInfoSchema.parse({
      name: 'world', type: 'minecraft:overworld', seed: '12345', sizeGB: 0.5,
      difficulty: 'easy', gameMode: 'survival', viewDistance: 10, simulationDistance: 10,
      onlinePlayers: 1, maxPlayers: 20, spawnProtection: 0, maxWorldSize: 29999984,
      allowFlight: false, hardcore: false, pvp: true, commandBlock: false,
      generateStructures: true, whiteList: false, onlineMode: true,
      lastSave: '2026-01-01T00:00:00.000Z', gameDays: 42, dimensions: [],
    })
    expect(w.seed).toBe('12345')
  })

  it('systemStats schema 解析系统统计', () => {
    const s = systemStatsSchema.parse({
      cpuUsage: 25.5, memoryUsage: 512, totalMemory: 2048, memoryPercent: 25,
      cpuCores: 4, loadAvg: [0.5, 0.3, 0.2], uptime: 86400,
    })
    expect(s.cpuCores).toBe(4)
  })
})

describe('请求侧契约（issue 391 路由层 zod 统一）', () => {
  it('fileUploadQuerySchema：缺省归一为 /，无前导斜杠补全，空串非法', () => {
    expect(fileUploadQuerySchema.parse({}).targetDir).toBe('/')
    expect(fileUploadQuerySchema.parse({ targetDir: 'world' }).targetDir).toBe('/world')
    expect(fileUploadQuerySchema.parse({ targetDir: '/a/b' }).targetDir).toBe('/a/b')
    expect(() => fileUploadQuerySchema.parse({ targetDir: '' })).toThrow()
    expect(() => fileUploadQuerySchema.parse({ targetDir: 'a\x00b' })).toThrow()
  })

  it('filePathRequestSchema：path 必填非空，剥离未知字段', () => {
    expect(filePathRequestSchema.parse({ path: '/a.txt', junk: 1 })).toEqual({ path: '/a.txt' })
    expect(() => filePathRequestSchema.parse({ path: '' })).toThrow()
    expect(() => filePathRequestSchema.parse({})).toThrow()
  })

  it('fileSaveRequestSchema：path/content 类型守护', () => {
    expect(fileSaveRequestSchema.parse({ path: '/a', content: 'x' })).toEqual({ path: '/a', content: 'x' })
    expect(() => fileSaveRequestSchema.parse({ path: '/a', content: 1 })).toThrow()
  })

  it('auditLogsQuerySchema：order 缺省/非法回落 desc（issue 383 向后兼容语义），合法值保留', () => {
    expect(auditLogsQuerySchema.parse({}).order).toBe('desc')
    expect(auditLogsQuerySchema.parse({ order: 'asc' }).order).toBe('asc')
    expect(auditLogsQuerySchema.parse({ order: 'desc' }).order).toBe('desc')
    expect(auditLogsQuerySchema.parse({ order: 'DROP TABLE' }).order).toBe('desc')
  })

  it('auditLogsQuerySchema：page/pageSize 原样透传（#392 分页边界）', () => {
    const parsed = auditLogsQuerySchema.parse({ page: '3', pageSize: '50' })
    expect(parsed.page).toBe('3')
    expect(parsed.pageSize).toBe('50')
  })

  it('marketSearchRequestSchema：offset/limit 透传 + 未知字段剥离', () => {
    const parsed = marketSearchRequestSchema.parse({ q: 'vault', offset: '10', junk: 'x' })
    expect(parsed).toEqual({ q: 'vault', offset: '10' })
  })

  it('pluginOverwriteQuerySchema：仅接受 true/false 字符串枚举', () => {
    expect(pluginOverwriteQuerySchema.parse({ overwrite: 'true' })).toEqual({ overwrite: 'true' })
    expect(pluginOverwriteQuerySchema.parse({})).toEqual({})
    expect(() => pluginOverwriteQuerySchema.parse({ overwrite: 'yes' })).toThrow()
  })

  it('pluginEnabledRequestSchema：enabled 必须为布尔', () => {
    expect(pluginEnabledRequestSchema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(() => pluginEnabledRequestSchema.parse({ enabled: 'yes' })).toThrow(/enabled must be a boolean/)
  })

  it('marketInstallRequestSchema：slug/versionNumber 必填字符串', () => {
    expect(marketInstallRequestSchema.parse({ slug: 'vault', versionNumber: '1.0.0' })).toEqual({
      slug: 'vault', versionNumber: '1.0.0',
    })
    expect(() => marketInstallRequestSchema.parse({ slug: 1, versionNumber: '1.0.0' })).toThrow()
  })

  it('upgradeRequestSchema：mcVersion 必填（保留原文案），type 缺省 vanilla、非法保留 Invalid type 文案', () => {
    expect(() => upgradeRequestSchema.parse({ type: 'vanilla' })).toThrow(/mcVersion is required/)
    const parsed = upgradeRequestSchema.parse({ mcVersion: '1.21.4' })
    expect(parsed.type).toBe('vanilla')
    expect(() => upgradeRequestSchema.parse({ mcVersion: '1.21.4', type: 'bukkit' })).toThrow(/Invalid type/)
  })
})
