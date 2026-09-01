/**
 * RCON_UNAVAILABLE 错误码 + world gameDays null 降级测试（issue #238）
 * - 命令路由 RCON 断开时返回 50302 而非 500
 * - world info gameDays 查询失败返回 null 而非 0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mock DB 隔离
vi.mock('../db/index.js', () => ({
  InstanceModel: { update: vi.fn(), delete: vi.fn() },
}))

import { createStatusRoutes } from '../routes/status.js'
import { errorHandler } from '../middleware/error_handler.js'

describe('RCON_UNAVAILABLE 错误码', () => {
  let app, mockManager

  beforeEach(() => {
    app = express()
    app.use(express.json())
    mockManager = {
      instances: new Map(),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    }
    app.use('/api', createStatusRoutes(mockManager))
    app.use(errorHandler)
  })

  describe('POST /api/instances/:id/command', () => {
    it('RCON 断开后命令失败返回 50302 而非 500', async () => {
      const mockInstance = {
        id: 's1',
        isRunning: true,
        isRconConnected: false,
        sendCommand: vi.fn().mockRejectedValue(new Error('RCON connection closed')),
      }
      mockManager.getInstance.mockReturnValue(mockInstance)

      const res = await request(app)
        .post('/api/instances/s1/command')
        .send({ command: 'time set day' })

      expect(res.status).toBe(503)
      expect(res.body.code).toBe(50302)
      expect(res.body.status).toBe('error')
    })

    it('RCON 连接时非 RCON 错误仍返回 500', async () => {
      const mockInstance = {
        id: 's1',
        isRunning: true,
        isRconConnected: true,
        sendCommand: vi.fn().mockRejectedValue(new Error('Some other error')),
      }
      mockManager.getInstance.mockReturnValue(mockInstance)

      const res = await request(app)
        .post('/api/instances/s1/command')
        .send({ command: 'time set day' })

      expect(res.status).toBe(500)
      expect(res.body.code).toBe(50000)
    })
  })
})

describe('world info gameDays null 降级', () => {
  let app, mockManager

  beforeEach(() => {
    app = express()
    app.use(express.json())
    mockManager = {
      instances: new Map(),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    }
    app.use('/api', createStatusRoutes(mockManager))
    app.use(errorHandler)
  })

  it('RCON 查询失败时 gameDays 返回 null 而非 0', async () => {
    const mockInstance = {
      id: 's1',
      isRunning: true,
      isRconConnected: true,
      properties: { 'level-name': 'world', 'level-type': 'minecraft:normal' },
      players: new Map(),
      sendCommandWithResponse: vi.fn().mockRejectedValue(new Error('RCON timeout')),
      _readSeedFromLevelDat: vi.fn().mockReturnValue(null),
      _getWorldSize: vi.fn().mockReturnValue(1.5),
      readDifficulty: vi.fn().mockResolvedValue('normal'),
      _readGameTypeFromLevelDat: vi.fn().mockReturnValue(null),
      _getLastSaveTime: vi.fn().mockReturnValue(null),
    }
    mockManager.getInstance.mockReturnValue(mockInstance)

    const res = await request(app).get('/api/instances/s1/world')

    expect(res.status).toBe(200)
    expect(res.body.data.gameDays).toBeNull()
  })

  it('RCON 未连接时 gameDays 为 null（不尝试查询）', async () => {
    const mockInstance = {
      id: 's1',
      isRunning: true,
      isRconConnected: false,
      properties: { 'level-name': 'world', 'level-type': 'minecraft:normal' },
      players: new Map(),
      sendCommandWithResponse: vi.fn(),
      _readSeedFromLevelDat: vi.fn().mockReturnValue(null),
      _getWorldSize: vi.fn().mockReturnValue(1.5),
      readDifficulty: vi.fn().mockResolvedValue('normal'),
      _readGameTypeFromLevelDat: vi.fn().mockReturnValue(null),
      _getLastSaveTime: vi.fn().mockReturnValue(null),
    }
    mockManager.getInstance.mockReturnValue(mockInstance)

    const res = await request(app).get('/api/instances/s1/world')

    expect(res.status).toBe(200)
    expect(res.body.data.gameDays).toBeNull()
    expect(mockInstance.sendCommandWithResponse).not.toHaveBeenCalled()
  })

  it('RCON 查询成功时 gameDays 返回正确数值', async () => {
    const mockInstance = {
      id: 's1',
      isRunning: true,
      isRconConnected: true,
      properties: { 'level-name': 'world', 'level-type': 'minecraft:normal' },
      players: new Map(),
      sendCommandWithResponse: vi.fn().mockResolvedValue('The game time is 72000 tick(s)'),
      _readSeedFromLevelDat: vi.fn().mockReturnValue(null),
      _getWorldSize: vi.fn().mockReturnValue(1.5),
      readDifficulty: vi.fn().mockResolvedValue('normal'),
      _readGameTypeFromLevelDat: vi.fn().mockReturnValue(null),
      _getLastSaveTime: vi.fn().mockReturnValue(null),
    }
    mockManager.getInstance.mockReturnValue(mockInstance)

    const res = await request(app).get('/api/instances/s1/world')

    expect(res.status).toBe(200)
    expect(res.body.data.gameDays).toBe(3) // 72000 / 24000 = 3
  })
})
