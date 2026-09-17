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
  marketVersionsResultSchema,
  pluginOverwriteQuerySchema,
  pluginEnabledRequestSchema,
  marketInstallRequestSchema,
  upgradeRequestSchema,
  fileListResponseSchema,
  fileMkdirResponseSchema,
  fileRenameResponseSchema,
  fileUploadResponseSchema,
  pluginDeleteResultSchema,
  upgradeStatusResponseSchema,
  authSessionResponseSchema,
  authSetupResponseSchema,
  authSessionsResponseSchema,
  authPasswordChangeResponseSchema,
  authLogoutResponseSchema,
  authSessionKickResponseSchema,
  apiKeyRotateResponseSchema,
  instanceSettingsRequestBodySchema,
  instanceStartRequestBodySchema,
  instanceCommandRequestBodySchema,
  instancePropertiesRequestBodySchema,
  instanceEulaRequestBodySchema,
  instanceDeleteRequestBodySchema,
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
      worldName: 'world', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    })
    expect(backup.worldName).toBe('world')
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

  // 实例名是卸载/备份恢复等破坏性操作的确认值：写入侧不归一化首尾空白，用户按
  // 界面所见名字确认就会永远对不上，实例再也删不掉
  it('实例名写入路径归一化首尾空白，trim 后为空一律拒绝', () => {
    expect(instanceSettingsRequestBodySchema.parse({ name: ' 生存服 ' }).name).toBe('生存服')
    expect(instanceSettingsRequestBodySchema.safeParse({ name: '   ' }).success).toBe(false)

    expect(deployRequestSchema.parse({ type: 'vanilla', mcVersion: '1.21.4', instanceName: ' 生存服 ' }).instanceName)
      .toBe('生存服')
    expect(deployRequestSchema.safeParse({ type: 'vanilla', mcVersion: '1.21.4', instanceName: '  ' }).success)
      .toBe(false)
  })

  it('卸载确认 confirmName 只锁字符串类型：空串与纯空白是合法入参（语义在路由层比对）', () => {
    // 存量空名实例只能靠空串确认，故 schema 不设最小长度、也不在此 trim
    expect(instanceDeleteRequestBodySchema.parse({ confirmName: '' }).confirmName).toBe('')
    expect(instanceDeleteRequestBodySchema.parse({ confirmName: '  ' }).confirmName).toBe('  ')
    expect(instanceDeleteRequestBodySchema.parse({ confirmName: ' 生存服 ' }).confirmName).toBe(' 生存服 ')
    // 类型收口：非字符串（null/number/数组/对象）与缺失一律拒绝
    for (const bad of [null, 42, [], {}]) {
      expect(instanceDeleteRequestBodySchema.safeParse({ confirmName: bad }).success, JSON.stringify(bad)).toBe(false)
    }
    expect(instanceDeleteRequestBodySchema.safeParse({}).success).toBe(false)
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

  it('marketVersionsResultSchema：file.sha512 透传（上游缺省为 null；未知字段剥离）', () => {
    const withHash = marketVersionsResultSchema.parse({
      projectSlug: 'vault', cached: false,
      versions: [{
        versionNumber: '1.0.0', versionType: 'release', name: 'Vault 1.0.0',
        changelog: null, datePublished: '2026-01-01T00:00:00Z', downloads: 1,
        gameVersions: ['1.21.4'], loaders: ['paper'],
        file: {
          url: 'https://cdn.modrinth.com/data/v/versions/a/vault.jar',
          filename: 'vault.jar', size: 100, sha512: 'ab'.repeat(32), junk: 'x',
        },
      }],
    })
    expect(withHash.versions[0]?.file).toEqual({
      url: 'https://cdn.modrinth.com/data/v/versions/a/vault.jar',
      filename: 'vault.jar', size: 100, sha512: 'ab'.repeat(32),
    })
    const withoutHash = marketVersionsResultSchema.parse({
      projectSlug: 'vault', cached: false,
      versions: [{
        versionNumber: '1.0.0', versionType: 'release', name: null,
        changelog: null, datePublished: null, downloads: 0,
        gameVersions: [], loaders: [],
        file: { url: null, filename: 'vault.jar', size: 0, sha512: null },
      }],
    })
    expect(withoutHash.versions[0]?.file?.sha512).toBeNull()
    expect(() => marketVersionsResultSchema.parse({
      projectSlug: 'vault', cached: false,
      versions: [{
        versionNumber: '1.0.0', versionType: 'release', name: null,
        changelog: null, datePublished: null, downloads: 0,
        gameVersions: [], loaders: [],
        file: { url: null, filename: 'vault.jar', size: 0, sha512: 123 },
      }],
    })).toThrow()
  })

  it('upgradeRequestSchema：mcVersion 必填（保留原文案），type 缺省 vanilla、非法保留 Invalid type 文案', () => {
    expect(() => upgradeRequestSchema.parse({ type: 'vanilla' })).toThrow(/mcVersion is required/)
    const parsed = upgradeRequestSchema.parse({ mcVersion: '1.21.4' })
    expect(parsed.type).toBe('vanilla')
    expect(() => upgradeRequestSchema.parse({ mcVersion: '1.21.4', type: 'bukkit' })).toThrow(/Invalid type/)
  })
})

describe('响应侧契约（issue 402 files/plugins/upgrade 接入）', () => {
  it('fileMkdirResponseSchema：path/name 必填字符串', () => {
    expect(fileMkdirResponseSchema.parse({ path: '/world', name: 'world' })).toEqual({ path: '/world', name: 'world' })
    expect(() => fileMkdirResponseSchema.parse({ path: '/world' })).toThrow()
  })

  it('fileRenameResponseSchema：oldPath/newPath/name 三字段', () => {
    expect(fileRenameResponseSchema.parse({ oldPath: '/a.jar', newPath: '/b.jar', name: 'b.jar' })).toEqual({
      oldPath: '/a.jar', newPath: '/b.jar', name: 'b.jar',
    })
    expect(() => fileRenameResponseSchema.parse({ oldPath: '/a.jar', newPath: '/b.jar' })).toThrow()
  })

  it('fileUploadResponseSchema：isDirectory 必须为字面 false（上传结果不含目录）', () => {
    const data = { path: '/plugins/x.jar', name: 'x.jar', size: 1024, modifiedAt: '2026-01-01T00:00:00.000Z', isDirectory: false }
    expect(fileUploadResponseSchema.parse(data)).toEqual(data)
    expect(() => fileUploadResponseSchema.parse({ ...data, isDirectory: true })).toThrow()
  })

  it('pluginDeleteResultSchema：deleted 为被删文件名', () => {
    expect(pluginDeleteResultSchema.parse({ deleted: 'vault.jar' })).toEqual({ deleted: 'vault.jar' })
    expect(() => pluginDeleteResultSchema.parse({ deleted: 1 })).toThrow()
  })

  it('upgradeStatusResponseSchema：upgrading 判别联合——空闲与升级中两分支', () => {
    const idle = upgradeStatusResponseSchema.parse({ upgrading: false })
    expect(idle).toEqual({ upgrading: false })
    const busy = upgradeStatusResponseSchema.parse({
      upgrading: true, instanceId: 'inst-1', stage: 'download', percent: 40, detail: 'downloading jar', timestamp: 1760000000000,
    })
    expect(busy.upgrading).toBe(true)
    expect(() => upgradeStatusResponseSchema.parse({ upgrading: true })).toThrow()
    expect(() => upgradeStatusResponseSchema.parse({ upgrading: 'yes' })).toThrow()
    // zod 默认 strip：false 分支上的多余字段不出现在输出
    expect(upgradeStatusResponseSchema.parse({ upgrading: false, stage: 'download' })).toEqual({ upgrading: false })
  })

  it('fileListResponseSchema：目录列表结构（既有响应首次入契约观测）', () => {
    const data = {
      path: '/',
      isDirectory: true,
      files: [{ name: 'plugins', path: '/plugins', type: 'directory', size: 0, modifiedAt: '2026-01-01T00:00:00.000Z', isDirectory: true }],
    }
    expect(fileListResponseSchema.parse(data)).toEqual(data)
  })

  it('authSessionResponseSchema：登录会话结构（token/UUID/expiresAt）', () => {
    const data = {
      token: 'abc-def_123',
      sessionId: '0b8f6d1e-1111-4222-8333-444455556666',
      expiresAt: '2026-01-01T00:00:00.000Z',
    }
    expect(authSessionResponseSchema.parse(data)).toEqual(data)
    expect(() => authSessionResponseSchema.parse({ ...data, token: 1 })).toThrow()
  })

  it('authSetupResponseSchema：设密即登录（hasPassword 恒 true + 会话）', () => {
    const data = {
      hasPassword: true,
      token: 'abc',
      sessionId: '0b8f6d1e-1111-4222-8333-444455556666',
      expiresAt: '2026-01-01T00:00:00.000Z',
    }
    expect(authSetupResponseSchema.parse(data)).toEqual(data)
    expect(() => authSetupResponseSchema.parse({ ...data, hasPassword: false })).toThrow()
  })

  it('authSessionsResponseSchema：会话列表条目（userAgent/ip 可 null，current 标记）', () => {
    const data = {
      sessions: [
        { id: 's-uuid-1', userAgent: 'vitest', ip: '127.0.0.1', createdAt: '2026-01-01 00:00:00', lastSeenAt: '2026-01-01 00:00:00', expiresAt: '2026-01-02T00:00:00.000Z', current: true },
        { id: 's-uuid-2', userAgent: null, ip: null, createdAt: '2026-01-01 00:00:00', lastSeenAt: '2026-01-01 00:00:00', expiresAt: '2026-01-02T00:00:00.000Z', current: false },
      ],
    }
    expect(authSessionsResponseSchema.parse(data)).toEqual(data)
    expect(() => authSessionsResponseSchema.parse({ sessions: [{ ...data.sessions[0], current: 'yes' }] })).toThrow()
  })

  it('authPasswordChangeResponseSchema / authLogoutResponseSchema / authSessionKickResponseSchema：ok 恒 true 结构', () => {
    expect(authPasswordChangeResponseSchema.parse({ ok: true, kickedSessions: 2 })).toEqual({ ok: true, kickedSessions: 2 })
    expect(() => authPasswordChangeResponseSchema.parse({ ok: false, kickedSessions: 0 })).toThrow()
    expect(authLogoutResponseSchema.parse({ ok: true })).toEqual({ ok: true })
    expect(authSessionKickResponseSchema.parse({ ok: true, current: false })).toEqual({ ok: true, current: false })
  })

  it('apiKeyRotateResponseSchema：明文新 Key 白名单单字段', () => {
    // 夹具与服务端 generateApiKey 同构（mcck- 前缀 + 8 位 hex 分组，共 32 字节熵），按段拼接构造——
    // 避免源码出现 apiKey=高熵字面量触发 gitleaks generic-api-key 误报
    const data = { apiKey: ['mcck', '11223344-55667788-99aabbcc-11223344-55667788-99aabbcc-11223344-55667788'].join('-') }
    expect(apiKeyRotateResponseSchema.parse(data)).toEqual(data)
    expect(apiKeyRotateResponseSchema.parse(data).apiKey).toMatch(/^mcck-[0-9a-f]{8}(-[0-9a-f]{8}){7}$/)
    expect(() => apiKeyRotateResponseSchema.parse({ apiKey: 123 })).toThrow()
  })
})

describe('实例控制面输入侧契约（issue 486 五 body 端点）', () => {
  it('instanceSettingsRequestBodySchema：白名单字段形状锁定，未知字段剥离', () => {
    const parsed = instanceSettingsRequestBodySchema.parse({
      name: 'survival', maxMemory: '4G', autoRestart: true, jvmArgs: ['-Xmx4G'], junk: 1,
    })
    expect(parsed).toEqual({ name: 'survival', maxMemory: '4G', autoRestart: true, jvmArgs: ['-Xmx4G'] })
    expect(instanceSettingsRequestBodySchema.parse({})).toEqual({})
  })

  it('instanceSettingsRequestBodySchema：startCommand 仅允许 null 清除，字符串/其他类型拒收（原文案）', () => {
    expect(instanceSettingsRequestBodySchema.parse({ startCommand: null })).toEqual({ startCommand: null })
    expect(() => instanceSettingsRequestBodySchema.parse({ startCommand: 'java -jar' }))
      .toThrow(/startCommand 已不再支持通过 API 更新/)
  })

  it('instanceSettingsRequestBodySchema：jvmArgs 非字符串数组拒收，内存字段非字符串拒收', () => {
    expect(() => instanceSettingsRequestBodySchema.parse({ jvmArgs: 'not-array' })).toThrow()
    expect(() => instanceSettingsRequestBodySchema.parse({ jvmArgs: ['-Xmx4G', 42] })).toThrow()
    expect(() => instanceSettingsRequestBodySchema.parse({ maxMemory: 4 })).toThrow()
    expect(() => instanceSettingsRequestBodySchema.parse({ autoRestart: 'yes' })).toThrow()
    // null 清除语义（与既有路由层一致）：javaPath/jarFile/description 放行，
    // maxMemory/minMemory/name/jvmArgs 拒收（jvmArgs null 原行为即 400）
    expect(instanceSettingsRequestBodySchema.parse({ javaPath: null })).toEqual({ javaPath: null })
    expect(instanceSettingsRequestBodySchema.parse({ jarFile: null })).toEqual({ jarFile: null })
    expect(instanceSettingsRequestBodySchema.parse({ description: null })).toEqual({ description: null })
    expect(() => instanceSettingsRequestBodySchema.parse({ maxMemory: null })).toThrow()
    expect(() => instanceSettingsRequestBodySchema.parse({ name: null })).toThrow()
    expect(() => instanceSettingsRequestBodySchema.parse({ jvmArgs: null })).toThrow()
  })

  it('instanceStartRequestBodySchema：禁用键契约——startCommand 任何值（含 null）拒收，未知字段剥离', () => {
    expect(instanceStartRequestBodySchema.parse({})).toEqual({})
    expect(instanceStartRequestBodySchema.parse({ junk: 1 })).toEqual({})
    expect(() => instanceStartRequestBodySchema.parse({ startCommand: 'java -jar' }))
      .toThrow(/startCommand 已不再支持通过 API 传入/)
    expect(() => instanceStartRequestBodySchema.parse({ startCommand: null })).toThrow()
  })

  it('instanceCommandRequestBodySchema：非空字符串（原文案）+ 长度上限，合法命令透传', () => {
    expect(instanceCommandRequestBodySchema.parse({ command: 'say hi' })).toEqual({ command: 'say hi' })
    expect(instanceCommandRequestBodySchema.parse({ command: '/list' })).toEqual({ command: '/list' })
    expect(() => instanceCommandRequestBodySchema.parse({})).toThrow(/Command is required/)
    expect(() => instanceCommandRequestBodySchema.parse({ command: '' })).toThrow(/Command is required/)
    expect(() => instanceCommandRequestBodySchema.parse({ command: 123 })).toThrow(/Command must be a string/)
    expect(() => instanceCommandRequestBodySchema.parse({ command: 'x'.repeat(2001) })).toThrow()
    expect(instanceCommandRequestBodySchema.parse({ command: 'x'.repeat(2000) }).command).toHaveLength(2000)
  })

  it('instancePropertiesRequestBodySchema：passthrough 保留全部属性键，数组/标量/null 拒收（原文案）', () => {
    const props = { difficulty: 'hard', 'view-distance': '12', 'allow-nether': 'true' }
    expect(instancePropertiesRequestBodySchema.parse(props)).toEqual(props)
    expect(() => instancePropertiesRequestBodySchema.parse(['difficulty'])).toThrow()
    expect(() => instancePropertiesRequestBodySchema.parse('hard')).toThrow(/请求体必须是 JSON 对象/)
    expect(() => instancePropertiesRequestBodySchema.parse(null)).toThrow(/请求体必须是 JSON 对象/)
  })

  it('instanceEulaRequestBodySchema：agreed 必须为布尔（原文案）', () => {
    expect(instanceEulaRequestBodySchema.parse({ agreed: true })).toEqual({ agreed: true })
    expect(instanceEulaRequestBodySchema.parse({ agreed: false })).toEqual({ agreed: false })
    expect(() => instanceEulaRequestBodySchema.parse({})).toThrow(/agreed must be a boolean/)
    expect(() => instanceEulaRequestBodySchema.parse({ agreed: 'yes' })).toThrow(/agreed must be a boolean/)
  })
})
