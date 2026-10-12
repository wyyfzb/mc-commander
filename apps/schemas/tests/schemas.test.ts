import { describe, it, expect } from 'vitest'
import {
  compareVersions,
  parseVersion,
  wsStatusSnapshotSchema,
  playerSchema,
  banRecordSchema,
  backupItemSchema,
  scheduledTaskSchema,
  apiEnvelopeSchema,
  apiErrorEnvelopeSchema,
  paginationSchema,
  wsMessageSchema,
  WS_EVENT_TYPES,
  WS_EVENT_KINDS,
  WS_STATE_RECOVERY,
  WS_STATUS_EVENT_NAMES,
  CRITICAL_STATUS_EVENTS,
  wsStatusEventPayloadSchema,
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
  backupAttachRequestSchema,
  backupRestoreRequestSchema,
  instanceDeleteRequestBodySchema,
  taskCreatePayloadSchema,
  taskUpdatePayloadSchema,
} from '../src/index'

describe('schemas 基础校验', () => {
  it('pagination schema 解析合法数据', () => {
    const result = paginationSchema.parse({ total: 100, page: 1, pageSize: 20, totalPages: 5 })
    expect(result).toEqual({ total: 100, page: 1, pageSize: 20, totalPages: 5 })
  })

  it('apiEnvelope schema 解析成功响应', () => {
    const env = apiEnvelopeSchema.parse({
      status: 'ok',
      code: 0,
      message: 'Success',
      data: null,
      timestamp: '2026-01-01T00:00:00Z',
    })
    expect(env.status).toBe('ok')
  })

  it('apiErrorEnvelope schema 解析错误响应', () => {
    const env = apiErrorEnvelopeSchema.parse({
      status: 'error',
      code: 40401,
      message: 'Not found',
      details: null,
      timestamp: '2026-01-01T00:00:00Z',
    })
    expect(env.code).toBe(40401)
  })

  it('player schema 解析在线玩家完整数据', () => {
    const player = playerSchema.parse({
      name: 'Steve',
      uuid: '00000000-0000-0000-0000-000000000001',
      isOnline: true,
      ip: '1.2.3.4',
      joinTime: 1704067200000,
      onlineTime: 3600,
      totalPlayTime: 7200,
      isOp: false,
      isWhitelisted: false,
      isBanned: false,
      banExpiresAt: null,
      isIpBanned: false,
      ipBanExpiresAt: null,
      isFakePlayer: false,
      lastSeen: null,
      health: 20,
      maxHealth: 20,
      hunger: 20,
      xpLevel: 5,
      spawnPoint: null,
      respawnPoint: null,
      position: { x: 100, y: 64, z: -200 },
      gameMode: 'survival',
      dimension: 'overworld',
      armor: 0,
      xpProgress: 0.5,
      ping: 50,
      isSleeping: false,
      isAfk: false,
      isFlying: false,
      isSneaking: false,
      isSprinting: false,
      isBurning: false,
      isFrozen: false,
      events: [],
      sessions: [],
      stats: {
        totalOnline: 100,
        loginCount: 50,
        offlineSince: 0,
        deathCount: 5,
        achievementCount: 10,
        sleepCount: 2,
      },
      inventory: {
        quickbar: Array(9).fill(null),
        main: Array(27).fill(null),
        equipment: { helmet: null, chestplate: null, leggings: null, boots: null, offhand: null },
        enderChest: Array(27).fill(null),
        source: 'snapshot',
        partial: false,
      },
    })
    expect(player.name).toBe('Steve')
    expect(player.gameMode).toBe('survival')
  })

  it('player schema 允许离线玩家最小集', () => {
    const player = playerSchema.parse({
      name: 'Alex',
      uuid: '00000000-0000-0000-0000-000000000002',
      isOnline: false,
      ip: '',
      joinTime: null,
      onlineTime: 0,
      totalPlayTime: 0,
      isOp: false,
      isWhitelisted: false,
      isBanned: false,
      banExpiresAt: null,
      isIpBanned: false,
      ipBanExpiresAt: null,
      isFakePlayer: false,
      lastSeen: '2026-01-01T00:00:00Z',
      health: null,
      maxHealth: null,
      hunger: null,
      xpLevel: null,
      spawnPoint: null,
      respawnPoint: null,
      position: null,
      gameMode: null,
      dimension: null,
      armor: null,
      xpProgress: null,
      ping: null,
      isSleeping: false,
      isAfk: false,
      isFlying: false,
      isSneaking: false,
      isSprinting: false,
      isBurning: false,
      isFrozen: false,
      events: [],
      sessions: [],
      stats: {
        totalOnline: 0,
        loginCount: 0,
        offlineSince: 1704067200000,
        deathCount: 0,
        achievementCount: 0,
        sleepCount: 0,
      },
      inventory: null,
    })
    expect(player.isOnline).toBe(false)
  })

  it('banRecord schema 解析封禁记录', () => {
    const ban = banRecordSchema.parse({
      targetType: 'player',
      target: 'Steve',
      reason: 'Griefing',
      isActive: true,
      isPermanent: false,
      expiresAt: 1704153600000,
      expired: false,
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(ban.isPermanent).toBe(false)
    expect(ban.expired).toBe(false)
  })

  it('backupItem schema 解析备份条目', () => {
    const backup = backupItemSchema.parse({
      id: 1,
      instanceId: 'inst-1',
      name: 'backup-1',
      description: null,
      type: 'manual',
      size: 1024000,
      status: 'completed',
      worldName: 'world',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    expect(backup.worldName).toBe('world')
  })

  it('scheduledTask schema 解析定时任务', () => {
    const task = scheduledTaskSchema.parse({
      id: 1,
      instanceId: 'inst-1',
      name: '每日重启',
      type: 'restart',
      cronExpression: '0 4 * * *',
      command: null,
      isEnabled: true,
      lastRunAt: null,
      lastRunStatus: 'never',
      lastRunError: null,
      nextRunAt: '2026-01-02T04:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
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
      name: 'server.properties',
      path: '/server.properties',
      type: 'file',
      size: 1234,
      modifiedAt: '2026-01-01T00:00:00Z',
      isDirectory: false,
    })
    expect(f.isDirectory).toBe(false)
  })

  it('auditLogItem schema 解析审计条目', () => {
    const a = auditLogItemSchema.parse({
      id: 1,
      instanceId: 'inst-1',
      action: 'player.ban',
      targetType: 'player',
      targetId: 'Steve',
      detail: null,
      source: 'web',
      createdAt: '2026-01-01T00:00:00Z',
    })
    expect(a.action).toBe('player.ban')
  })

  it('deployRequest schema 解析部署请求', () => {
    const d = deployRequestSchema.parse({
      type: 'vanilla',
      mcVersion: '1.21.4',
      instanceName: 'test',
    })
    expect(d.type).toBe('vanilla')
  })

  // 实例名是卸载/备份恢复等破坏性操作的确认值：写入侧不归一化首尾空白，用户按
  // 界面所见名字确认就会永远对不上，实例再也删不掉
  it('实例名写入路径归一化首尾空白，trim 后为空一律拒绝', () => {
    expect(instanceSettingsRequestBodySchema.parse({ name: ' 生存服 ' }).name).toBe('生存服')
    expect(instanceSettingsRequestBodySchema.safeParse({ name: '   ' }).success).toBe(false)

    expect(
      deployRequestSchema.parse({ type: 'vanilla', mcVersion: '1.21.4', instanceName: ' 生存服 ' })
        .instanceName,
    ).toBe('生存服')
    expect(
      deployRequestSchema.safeParse({ type: 'vanilla', mcVersion: '1.21.4', instanceName: '  ' })
        .success,
    ).toBe(false)
  })

  it('卸载确认 confirmName 只锁字符串类型：空串与纯空白是合法入参（语义在路由层比对）', () => {
    // 存量空名实例只能靠空串确认，故 schema 不设最小长度、也不在此 trim
    expect(instanceDeleteRequestBodySchema.parse({ confirmName: '' }).confirmName).toBe('')
    expect(instanceDeleteRequestBodySchema.parse({ confirmName: '  ' }).confirmName).toBe('  ')
    expect(instanceDeleteRequestBodySchema.parse({ confirmName: ' 生存服 ' }).confirmName).toBe(
      ' 生存服 ',
    )
    // 类型收口：非字符串（null/number/数组/对象）与缺失一律拒绝
    for (const bad of [null, 42, [], {}]) {
      expect(
        instanceDeleteRequestBodySchema.safeParse({ confirmName: bad }).success,
        JSON.stringify(bad),
      ).toBe(false)
    }
    // 文案也是契约：缺键与类型错走的是 error 回调的两个分支，须逐字锁住
    // （zod 4 的 `error` 回调若不按 `issue.code` 限定，会连 check 的默认文案一起接管）
    expect(() => instanceDeleteRequestBodySchema.parse({})).toThrow(/confirmName is required/)
    expect(() => instanceDeleteRequestBodySchema.parse({ confirmName: 42 })).toThrow(
      /confirmName must be a string/,
    )
  })

  it('pluginInfo schema 解析插件信息', () => {
    const p = pluginInfoSchema.parse({
      file: 'TestPlugin.jar',
      name: 'TestPlugin',
      enabled: true,
      sizeBytes: 1024,
      mtimeMs: 1704067200000,
      meta: {
        name: 'TestPlugin',
        version: '1.0.0',
        main: 'com.test.Main',
        apiVersion: '1.21',
        description: null,
        authors: [],
        depend: [],
        softdepend: [],
        website: null,
        load: null,
      },
    })
    expect(p.meta?.name).toBe('TestPlugin')
  })

  it('worldInfo schema 解析世界信息', () => {
    const w = worldInfoSchema.parse({
      name: 'world',
      type: 'minecraft:overworld',
      seed: '12345',
      sizeGB: 0.5,
      difficulty: 'easy',
      gameMode: 'survival',
      viewDistance: 10,
      simulationDistance: 10,
      onlinePlayers: 1,
      maxPlayers: 20,
      spawnProtection: 0,
      maxWorldSize: 29999984,
      allowFlight: false,
      hardcore: false,
      pvp: true,
      commandBlock: false,
      generateStructures: true,
      whiteList: false,
      onlineMode: true,
      lastSave: '2026-01-01T00:00:00.000Z',
      gameDays: 42,
      dimensions: [],
    })
    expect(w.seed).toBe('12345')
  })

  it('systemStats schema 解析系统统计', () => {
    const s = systemStatsSchema.parse({
      cpuUsage: 25.5,
      memoryUsage: 512,
      totalMemory: 2048,
      memoryPercent: 25,
      cpuCores: 4,
      loadAvg: [0.5, 0.3, 0.2],
      uptime: 86400,
    })
    expect(s.cpuCores).toBe(4)
  })

  it('systemStats schema 解析磁盘告警阈值（前端据此判告警，故须随读数下发）', () => {
    const s = systemStatsSchema.parse({
      cpuUsage: 25.5,
      memoryUsage: 512,
      totalMemory: 2048,
      memoryPercent: 25,
      cpuCores: 4,
      loadAvg: [0.5, 0.3, 0.2],
      uptime: 86400,
      diskUsage: {
        primary: { mountpoint: '/', totalGB: 39, usedGB: 37, percent: 94.9 },
        all: [{ mountpoint: '/', totalGB: 39, usedGB: 37, percent: 94.9 }],
      },
      diskAlert: { warningPercent: 85, errorPercent: 95 },
    })
    expect(s.diskAlert).toEqual({ warningPercent: 85, errorPercent: 95 })
    expect(s.diskUsage?.primary?.percent).toBe(94.9)
  })

  it('systemStats schema：diskAlert 可选（旧服务端不出该字段仍可解析）', () => {
    const s = systemStatsSchema.parse({
      cpuUsage: 25.5,
      memoryUsage: 512,
      totalMemory: 2048,
      memoryPercent: 25,
      cpuCores: 4,
      loadAvg: [0.5, 0.3, 0.2],
      uptime: 86400,
    })
    expect(s.diskAlert).toBeUndefined()
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
    expect(() => filePathRequestSchema.parse({ path: '' })).toThrow(/File path is required/)
    expect(() => filePathRequestSchema.parse({})).toThrow(/File path is required/)
  })

  it('fileSaveRequestSchema：path/content 类型守护', () => {
    expect(fileSaveRequestSchema.parse({ path: '/a', content: 'x' })).toEqual({
      path: '/a',
      content: 'x',
    })
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
    expect(() => pluginEnabledRequestSchema.parse({ enabled: 'yes' })).toThrow(
      /enabled must be a boolean/,
    )
  })

  it('marketInstallRequestSchema：slug/versionNumber 必填字符串', () => {
    expect(marketInstallRequestSchema.parse({ slug: 'vault', versionNumber: '1.0.0' })).toEqual({
      slug: 'vault',
      versionNumber: '1.0.0',
    })
    expect(() => marketInstallRequestSchema.parse({ slug: 1, versionNumber: '1.0.0' })).toThrow()
  })

  it('marketVersionsResultSchema：file.sha512 透传（上游缺省为 null；未知字段剥离）', () => {
    const withHash = marketVersionsResultSchema.parse({
      projectSlug: 'vault',
      cached: false,
      versions: [
        {
          versionNumber: '1.0.0',
          versionType: 'release',
          name: 'Vault 1.0.0',
          changelog: null,
          datePublished: '2026-01-01T00:00:00Z',
          downloads: 1,
          gameVersions: ['1.21.4'],
          loaders: ['paper'],
          file: {
            url: 'https://cdn.modrinth.com/data/v/versions/a/vault.jar',
            filename: 'vault.jar',
            size: 100,
            sha512: 'ab'.repeat(32),
            junk: 'x',
          },
        },
      ],
    })
    expect(withHash.versions[0]?.file).toEqual({
      url: 'https://cdn.modrinth.com/data/v/versions/a/vault.jar',
      filename: 'vault.jar',
      size: 100,
      sha512: 'ab'.repeat(32),
    })
    const withoutHash = marketVersionsResultSchema.parse({
      projectSlug: 'vault',
      cached: false,
      versions: [
        {
          versionNumber: '1.0.0',
          versionType: 'release',
          name: null,
          changelog: null,
          datePublished: null,
          downloads: 0,
          gameVersions: [],
          loaders: [],
          file: { url: null, filename: 'vault.jar', size: 0, sha512: null },
        },
      ],
    })
    expect(withoutHash.versions[0]?.file?.sha512).toBeNull()
    expect(() =>
      marketVersionsResultSchema.parse({
        projectSlug: 'vault',
        cached: false,
        versions: [
          {
            versionNumber: '1.0.0',
            versionType: 'release',
            name: null,
            changelog: null,
            datePublished: null,
            downloads: 0,
            gameVersions: [],
            loaders: [],
            file: { url: null, filename: 'vault.jar', size: 0, sha512: 123 },
          },
        ],
      }),
    ).toThrow()
  })

  it('upgradeRequestSchema：mcVersion 必填（保留原文案），type 缺省 vanilla、非法保留 Invalid type 文案', () => {
    expect(() => upgradeRequestSchema.parse({ type: 'vanilla' })).toThrow(/mcVersion is required/)
    const parsed = upgradeRequestSchema.parse({ mcVersion: '1.21.4' })
    expect(parsed.type).toBe('vanilla')
    expect(() => upgradeRequestSchema.parse({ mcVersion: '1.21.4', type: 'bukkit' })).toThrow(
      /Invalid type/,
    )
  })

  it('taskCreatePayloadSchema：name/type/cronExpression 必填，type 限五值枚举', () => {
    const base = { name: '每日重启', type: 'restart', cronExpression: '0 4 * * *' }
    expect(taskCreatePayloadSchema.parse(base)).toEqual(base)
    for (const type of ['restart', 'backup', 'command', 'stop', 'start']) {
      expect(taskCreatePayloadSchema.parse({ ...base, type }).type).toBe(type)
    }
    expect(() =>
      taskCreatePayloadSchema.parse({ type: 'restart', cronExpression: '0 4 * * *' }),
    ).toThrow()
    expect(() =>
      taskCreatePayloadSchema.parse({ name: 'x', cronExpression: '0 4 * * *' }),
    ).toThrow()
    expect(() => taskCreatePayloadSchema.parse({ name: 'x', type: 'restart' })).toThrow()
    expect(() => taskCreatePayloadSchema.parse({ ...base, type: 'upgrade' })).toThrow()
  })

  it('taskCreatePayloadSchema：name 归一化首尾空白并拒空（与实例名同口径）', () => {
    expect(
      taskCreatePayloadSchema.parse({
        name: '  每日重启  ',
        type: 'restart',
        cronExpression: '0 4 * * *',
      }).name,
    ).toBe('每日重启')
    expect(() =>
      taskCreatePayloadSchema.parse({ name: '', type: 'restart', cronExpression: '0 4 * * *' }),
    ).toThrow(/name 不能为空或纯空白/)
    expect(() =>
      taskCreatePayloadSchema.parse({ name: '   ', type: 'restart', cronExpression: '0 4 * * *' }),
    ).toThrow(/name 不能为空或纯空白/)
  })

  it('taskCreatePayloadSchema：command/isEnabled 缺省可选——command 允许 null（非 command 型任务的清空形态）', () => {
    const parsed = taskCreatePayloadSchema.parse({
      name: '每晚广播',
      type: 'command',
      cronExpression: '0 22 * * *',
      command: 'say hi',
      isEnabled: false,
    })
    expect(parsed).toEqual({
      name: '每晚广播',
      type: 'command',
      cronExpression: '0 22 * * *',
      command: 'say hi',
      isEnabled: false,
    })
    // 缺省：两键缺席即不出现（路由据此走 isEnabled !== false 的默认启用）
    expect(
      taskCreatePayloadSchema.parse({ name: 'x', type: 'restart', cronExpression: '0 4 * * *' }),
    ).toEqual({ name: 'x', type: 'restart', cronExpression: '0 4 * * *' })
    expect(
      taskCreatePayloadSchema.parse({
        name: 'x',
        type: 'restart',
        cronExpression: '0 4 * * *',
        command: null,
      }).command,
    ).toBeNull()
    // 类型守护：command 非字符串、isEnabled 非布尔一律拒收
    expect(() =>
      taskCreatePayloadSchema.parse({
        name: 'x',
        type: 'command',
        cronExpression: '0 4 * * *',
        command: 1,
      }),
    ).toThrow()
    expect(() =>
      taskCreatePayloadSchema.parse({
        name: 'x',
        type: 'restart',
        cronExpression: '0 4 * * *',
        isEnabled: 'yes',
      }),
    ).toThrow()
  })

  it('taskCreatePayloadSchema：剥离未知字段（含模型 fieldMap 认得的 lastRunAt/nextRunAt）', () => {
    // lastRunAt/nextRunAt 在 ScheduledTaskModel.update 的 fieldMap 里，靠契约剥离才无法被
    // 客户端直写（否则可伪造执行时间）；lastRunStatus 则由模型刻意不映射
    const parsed = taskCreatePayloadSchema.parse({
      name: 'x',
      type: 'restart',
      cronExpression: '0 4 * * *',
      id: 7,
      instanceId: 'other',
      lastRunAt: '2026-01-01T00:00:00.000Z',
      nextRunAt: '2026-01-02T00:00:00.000Z',
      lastRunStatus: 'success',
    })
    expect(parsed).toEqual({ name: 'x', type: 'restart', cronExpression: '0 4 * * *' })
  })

  it('taskUpdatePayloadSchema：partial——全字段可选（空体合法），name 仍拒空', () => {
    expect(taskUpdatePayloadSchema.parse({})).toEqual({})
    expect(taskUpdatePayloadSchema.parse({ isEnabled: false })).toEqual({ isEnabled: false })
    expect(taskUpdatePayloadSchema.parse({ name: ' 改名 ' }).name).toBe('改名')
    expect(() => taskUpdatePayloadSchema.parse({ name: '  ' })).toThrow(/name 不能为空或纯空白/)
    expect(() => taskUpdatePayloadSchema.parse({ type: 'upgrade' })).toThrow()
  })
})

describe('响应侧契约（issue 402 files/plugins/upgrade 接入）', () => {
  it('fileMkdirResponseSchema：path/name 必填字符串', () => {
    expect(fileMkdirResponseSchema.parse({ path: '/world', name: 'world' })).toEqual({
      path: '/world',
      name: 'world',
    })
    expect(() => fileMkdirResponseSchema.parse({ path: '/world' })).toThrow()
  })

  it('fileRenameResponseSchema：oldPath/newPath/name 三字段', () => {
    expect(
      fileRenameResponseSchema.parse({ oldPath: '/a.jar', newPath: '/b.jar', name: 'b.jar' }),
    ).toEqual({
      oldPath: '/a.jar',
      newPath: '/b.jar',
      name: 'b.jar',
    })
    expect(() => fileRenameResponseSchema.parse({ oldPath: '/a.jar', newPath: '/b.jar' })).toThrow()
  })

  it('fileUploadResponseSchema：isDirectory 必须为字面 false（上传结果不含目录）', () => {
    const data = {
      path: '/plugins/x.jar',
      name: 'x.jar',
      size: 1024,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      isDirectory: false,
    }
    expect(fileUploadResponseSchema.parse(data)).toEqual(data)
    expect(() => fileUploadResponseSchema.parse({ ...data, isDirectory: true })).toThrow()
  })

  it('pluginDeleteResultSchema：deleted 为被删文件名', () => {
    expect(pluginDeleteResultSchema.parse({ deleted: 'vault.jar' })).toEqual({
      deleted: 'vault.jar',
    })
    expect(() => pluginDeleteResultSchema.parse({ deleted: 1 })).toThrow()
  })

  it('upgradeStatusResponseSchema：upgrading 判别联合——空闲与升级中两分支', () => {
    const idle = upgradeStatusResponseSchema.parse({ upgrading: false })
    expect(idle).toEqual({ upgrading: false })
    const busy = upgradeStatusResponseSchema.parse({
      upgrading: true,
      instanceId: 'inst-1',
      stage: 'download',
      percent: 40,
      detail: 'downloading jar',
      timestamp: 1760000000000,
    })
    expect(busy.upgrading).toBe(true)
    expect(() => upgradeStatusResponseSchema.parse({ upgrading: true })).toThrow()
    expect(() => upgradeStatusResponseSchema.parse({ upgrading: 'yes' })).toThrow()
    // zod 默认 strip：false 分支上的多余字段不出现在输出
    expect(upgradeStatusResponseSchema.parse({ upgrading: false, stage: 'download' })).toEqual({
      upgrading: false,
    })
  })

  it('fileListResponseSchema：目录列表结构（既有响应首次入契约观测）', () => {
    const data = {
      path: '/',
      isDirectory: true,
      files: [
        {
          name: 'plugins',
          path: '/plugins',
          type: 'directory',
          size: 0,
          modifiedAt: '2026-01-01T00:00:00.000Z',
          isDirectory: true,
        },
      ],
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
        {
          id: 's-uuid-1',
          userAgent: 'vitest',
          ip: '127.0.0.1',
          createdAt: '2026-01-01 00:00:00',
          lastSeenAt: '2026-01-01 00:00:00',
          expiresAt: '2026-01-02T00:00:00.000Z',
          current: true,
        },
        {
          id: 's-uuid-2',
          userAgent: null,
          ip: null,
          createdAt: '2026-01-01 00:00:00',
          lastSeenAt: '2026-01-01 00:00:00',
          expiresAt: '2026-01-02T00:00:00.000Z',
          current: false,
        },
      ],
    }
    expect(authSessionsResponseSchema.parse(data)).toEqual(data)
    expect(() =>
      authSessionsResponseSchema.parse({ sessions: [{ ...data.sessions[0], current: 'yes' }] }),
    ).toThrow()
  })

  it('authPasswordChangeResponseSchema / authLogoutResponseSchema / authSessionKickResponseSchema：ok 恒 true 结构', () => {
    expect(authPasswordChangeResponseSchema.parse({ ok: true, kickedSessions: 2 })).toEqual({
      ok: true,
      kickedSessions: 2,
    })
    expect(() => authPasswordChangeResponseSchema.parse({ ok: false, kickedSessions: 0 })).toThrow()
    expect(authLogoutResponseSchema.parse({ ok: true })).toEqual({ ok: true })
    expect(authSessionKickResponseSchema.parse({ ok: true, current: false })).toEqual({
      ok: true,
      current: false,
    })
  })

  it('apiKeyRotateResponseSchema：明文新 Key 白名单单字段', () => {
    // 夹具与服务端 generateApiKey 同构（mcck- 前缀 + 8 位 hex 分组，共 32 字节熵），按段拼接构造——
    // 避免源码出现 apiKey=高熵字面量触发 gitleaks generic-api-key 误报
    const data = {
      apiKey: [
        'mcck',
        '11223344-55667788-99aabbcc-11223344-55667788-99aabbcc-11223344-55667788',
      ].join('-'),
    }
    expect(apiKeyRotateResponseSchema.parse(data)).toEqual(data)
    expect(apiKeyRotateResponseSchema.parse(data).apiKey).toMatch(
      /^mcck-[0-9a-f]{8}(-[0-9a-f]{8}){7}$/,
    )
    expect(() => apiKeyRotateResponseSchema.parse({ apiKey: 123 })).toThrow()
  })
})

describe('实例控制面输入侧契约（issue 486 五 body 端点）', () => {
  it('instanceSettingsRequestBodySchema：白名单字段形状锁定，未知字段剥离', () => {
    const parsed = instanceSettingsRequestBodySchema.parse({
      name: 'survival',
      maxMemory: '4G',
      autoRestart: true,
      jvmArgs: ['-Xmx4G'],
      junk: 1,
    })
    expect(parsed).toEqual({
      name: 'survival',
      maxMemory: '4G',
      autoRestart: true,
      jvmArgs: ['-Xmx4G'],
    })
    expect(instanceSettingsRequestBodySchema.parse({})).toEqual({})
  })

  it('instanceSettingsRequestBodySchema：startCommand 仅允许 null 清除，字符串/其他类型拒收（原文案）', () => {
    expect(instanceSettingsRequestBodySchema.parse({ startCommand: null })).toEqual({
      startCommand: null,
    })
    expect(() => instanceSettingsRequestBodySchema.parse({ startCommand: 'java -jar' })).toThrow(
      /startCommand 已不再支持通过 API 更新/,
    )
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
    expect(instanceSettingsRequestBodySchema.parse({ description: null })).toEqual({
      description: null,
    })
    expect(() => instanceSettingsRequestBodySchema.parse({ maxMemory: null })).toThrow()
    expect(() => instanceSettingsRequestBodySchema.parse({ name: null })).toThrow()
    expect(() => instanceSettingsRequestBodySchema.parse({ jvmArgs: null })).toThrow()
  })

  it('instanceStartRequestBodySchema：禁用键契约——startCommand 任何值（含 null）拒收，未知字段剥离', () => {
    expect(instanceStartRequestBodySchema.parse({})).toEqual({})
    expect(instanceStartRequestBodySchema.parse({ junk: 1 })).toEqual({})
    expect(() => instanceStartRequestBodySchema.parse({ startCommand: 'java -jar' })).toThrow(
      /startCommand 已不再支持通过 API 传入/,
    )
    expect(() => instanceStartRequestBodySchema.parse({ startCommand: null })).toThrow()
  })

  it('instanceCommandRequestBodySchema：非空字符串（原文案）+ 长度上限，合法命令透传', () => {
    expect(instanceCommandRequestBodySchema.parse({ command: 'say hi' })).toEqual({
      command: 'say hi',
    })
    expect(instanceCommandRequestBodySchema.parse({ command: '/list' })).toEqual({
      command: '/list',
    })
    expect(() => instanceCommandRequestBodySchema.parse({})).toThrow(/Command is required/)
    expect(() => instanceCommandRequestBodySchema.parse({ command: '' })).toThrow(
      /Command is required/,
    )
    expect(() => instanceCommandRequestBodySchema.parse({ command: 123 })).toThrow(
      /Command must be a string/,
    )
    // 超长走的是 .max() 的 too_big 分支，文案必须仍是 v3 的那句：error 回调若不按
    // issue.code 限定，会把它接管成 'Command must be a string'（对用户是误导性表述）
    expect(() => instanceCommandRequestBodySchema.parse({ command: 'x'.repeat(2001) })).toThrow(
      /String must contain at most 2000 character\(s\)/,
    )
    expect(
      instanceCommandRequestBodySchema.parse({ command: 'x'.repeat(2000) }).command,
    ).toHaveLength(2000)
  })

  it('instancePropertiesRequestBodySchema：passthrough 保留全部属性键，数组/标量/null 拒收（原文案）', () => {
    const props = { difficulty: 'hard', 'view-distance': '12', 'allow-nether': 'true' }
    expect(instancePropertiesRequestBodySchema.parse(props)).toEqual(props)
    expect(() => instancePropertiesRequestBodySchema.parse(['difficulty'])).toThrow()
    expect(() => instancePropertiesRequestBodySchema.parse('hard')).toThrow(
      /请求体必须是 JSON 对象/,
    )
    expect(() => instancePropertiesRequestBodySchema.parse(null)).toThrow(/请求体必须是 JSON 对象/)
  })

  it('instanceEulaRequestBodySchema：agreed 必须为布尔（原文案）', () => {
    expect(instanceEulaRequestBodySchema.parse({ agreed: true })).toEqual({ agreed: true })
    expect(instanceEulaRequestBodySchema.parse({ agreed: false })).toEqual({ agreed: false })
    expect(() => instanceEulaRequestBodySchema.parse({})).toThrow(/agreed must be a boolean/)
    expect(() => instanceEulaRequestBodySchema.parse({ agreed: 'yes' })).toThrow(
      /agreed must be a boolean/,
    )
  })
})

describe('备份请求侧契约（attach / restore 的必填文案）', () => {
  // 这两个 schema 此前零 schema 级覆盖：服务端的 attach 用例只断言 status=400、
  // restore 只断言路由层比对，文案写错不会转红 ⇒ 补齐（zod 4 的 error 回调若不按
  // issue.code 限定，会把 check 的默认文案一并接管）
  it('backupRestoreRequestSchema：confirmName 缺键报原文案', () => {
    expect(() => backupRestoreRequestSchema.parse({})).toThrow(/confirmName 必填/)
    // 类型错走的是回调的 else 分支（返回 undefined ⇒ 回退 v4 默认文案）
    expect(() => backupRestoreRequestSchema.parse({ confirmName: 42 })).toThrow()
    expect(backupRestoreRequestSchema.parse({ confirmName: '' }).confirmName).toBe('')
  })

  it('backupAttachRequestSchema：archiveId 缺键与空串各报原文案', () => {
    expect(() => backupAttachRequestSchema.parse({})).toThrow(/archiveId 必填/)
    // .min(1) 显式带文案：v4 默认文案与 v3 不同，而该 400 直接对用户可见
    expect(() => backupAttachRequestSchema.parse({ archiveId: '' })).toThrow(
      /String must contain at least 1 character\(s\)/,
    )
    expect(backupAttachRequestSchema.parse({ archiveId: 'paper-1a2b3c4d' }).archiveId).toBe(
      'paper-1a2b3c4d',
    )
  })
})

describe('信封的未知负载字段（zod 4 起 z.unknown() 不再隐式可选）', () => {
  // zod 3 里对象字段的 z.unknown() 缺键即通过；zod 4 改为报 invalid_type。
  // 本仓生产路径恒给这些字段赋值（response.js 的 `data || null` / `details || null`、
  // audit.model 与 webhook.model 的 `let x = null`），故必须显式 .optional() 保持原语义，
  // 否则缺键响应会触发 validate.js 的假契约告警（logContractAlarm）。
  const base = { status: 'ok', code: 0, message: 'ok', timestamp: '2026-01-01T00:00:00.000Z' }
  it('apiEnvelopeSchema：缺 data / pagination 应通过', () => {
    expect(apiEnvelopeSchema.safeParse(base).success).toBe(true)
    expect(apiEnvelopeSchema.safeParse({ ...base, data: null }).success).toBe(true)
    expect(apiEnvelopeSchema.safeParse({ ...base, data: { a: 1 } }).success).toBe(true)
  })

  it('apiErrorEnvelopeSchema：缺 details 应通过', () => {
    const err = {
      status: 'error',
      code: 40000,
      message: 'bad',
      timestamp: '2026-01-01T00:00:00.000Z',
    }
    expect(apiErrorEnvelopeSchema.safeParse(err).success).toBe(true)
    expect(apiErrorEnvelopeSchema.safeParse({ ...err, details: null }).success).toBe(true)
  })
})

describe('运行态跃迁的取值与关键子事件', () => {
  it('关键子事件必须是合法的跃迁取值（否则服务端落库那条路径永远不匹配）', () => {
    const names = new Set<string>(WS_STATUS_EVENT_NAMES)
    expect(CRITICAL_STATUS_EVENTS.size).toBeGreaterThan(0)
    for (const ev of CRITICAL_STATUS_EVENTS) {
      expect(names.has(ev), `${ev} 不在 WS_STATUS_EVENT_NAMES 里`).toBe(true)
    }
  })

  it('关键子事件是显式清单：改这里＝承认落库面（全局补齐）变了', () => {
    // 用 it.each 遍历集合只能发现「多了一格」，删掉一格会静默少跑一行 ⇒ 这里锁死内容
    expect([...CRITICAL_STATUS_EVENTS].sort()).toEqual(['circuit_breaker', 'crash'])
  })

  it('载荷 schema 接受全部跃迁取值（枚举与取值清单同源）', () => {
    for (const ev of WS_STATUS_EVENT_NAMES) {
      expect(wsStatusEventPayloadSchema.safeParse({ event: ev }).success, ev).toBe(true)
    }
  })
})

describe('事件通道口径（状态 vs 事件）', () => {
  it('每个事件都被分类，且没有多余键', () => {
    expect(Object.keys(WS_EVENT_KINDS).sort()).toEqual([...WS_EVENT_TYPES].sort())
  })

  it('state 类必须声明自愈路径，event 类不得声明', () => {
    const states = WS_EVENT_TYPES.filter((t) => WS_EVENT_KINDS[t] === 'state')
    expect(Object.keys(WS_STATE_RECOVERY).sort()).toEqual([...states].sort())
  })

  it('落库面只收「发生过的事实」：与 state 类不相交', () => {
    for (const t of NOTIFICATION_EVENT_TYPES) {
      expect(WS_EVENT_KINDS[t], `${t} 是 state 类，进度写库是纯放大`).toBe('event')
    }
  })

  it('落库面覆盖服务端实际落库的部署/升级终态（两处清单曾不一致）', () => {
    for (const t of [
      'deployComplete',
      'deployFailed',
      'deployCancelled',
      'upgradeComplete',
      'upgradeFailed',
      'upgradeCancelled',
    ] as const) {
      expect(NOTIFICATION_EVENT_TYPES.has(t)).toBe(true)
    }
  })

  it('已知缺口是显式清单：当前为空，再出现就必须登记', () => {
    const gaps = Object.entries(WS_STATE_RECOVERY)
      .filter(([, path]) => path === 'none')
      .map(([type]) => type)
      .sort()
    // 缺口不是「可以忽略」，而是「已登记、等 owner 定」——往这个数组里加名字，就是承认又多了一个
    // 没有自愈路径的通道（state 类事件必须能被晚订阅者在有限时间内读到）。
    expect(gaps).toEqual([])
  })
})

// 版本解析与比较是 web 与服务端**共用唯一一份**：同一串版本号在两处必须得出同一结论，
// 否则服务端会替不支持的版本写配置（或反过来该写不写）。
describe('版本号解析与比较（契约包唯一一份）', () => {
  it('取第一段连续数字及其后点分段，缺失段按 0', () => {
    expect(parseVersion('1.21.9')).toEqual([1, 21, 9])
    expect(parseVersion('v1.21')).toEqual([1, 21, 0])
    expect(parseVersion('26.3-snapshot-2')).toEqual([26, 3, 0])
    expect(parseVersion('weird')).toBeNull()
  })

  it('逐段数值比较（不是字符串比较）', () => {
    expect(compareVersions('26.3', '1.21.9')).toBeGreaterThan(0)
    expect(compareVersions('1.21.4', '1.21.9')).toBeLessThan(0)
    expect(compareVersions('1.21.9', '1.21.9')).toBe(0)
    // 字符串比较会把 1.9 排在 1.21 前面，这里必须按数值
    expect(compareVersions('1.9', '1.21')).toBeLessThan(0)
  })

  it('任一串读不懂 ⇒ 返回 null（不返回 NaN 三元组，避免所有分支静默为 false）', () => {
    expect(compareVersions('weird', '1.0.0')).toBeNull()
    expect(compareVersions('1.0.0', '')).toBeNull()
  })
})

// 快照载荷里的 msmpPush 沿用 worldUpgrade 的三态口径：布尔＝权威值、**字段缺席＝未知**
// （旧服务端）⇒ 客户端保持现状，不能读成「断开」。
describe('状态快照载荷：msmpPush 可选', () => {
  const base = { status: 'running', isRunning: true, players: [], tps: 20 }

  it('带上布尔值 ⇒ 解析通过', () => {
    expect(wsStatusSnapshotSchema.parse({ ...base, msmpPush: false }).msmpPush).toBe(false)
  })

  it('字段缺席 ⇒ 解析通过且不臆断（未知，不是 false）', () => {
    expect(wsStatusSnapshotSchema.parse(base).msmpPush).toBeUndefined()
  })

  it('类型不对 ⇒ 拦下（不能把字符串当布尔用）', () => {
    expect(() => wsStatusSnapshotSchema.parse({ ...base, msmpPush: 'true' })).toThrow()
  })
})
