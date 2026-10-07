/**
 * world API 函数行为级测试（issue 476：tasks/world 数据访问层零防护收口）
 * msw 局部拦截真链路：GET/PUT 契约断言 + 错误传播（错误信封 / 非 JSON 载荷 / 网络层失败）
 * 数据均为虚构测试值，不含真实服务器信息（敏感键以 ******** 占位断言）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { apiGetProperties, apiGetWorld, apiUpdateProperties } from '../world'
import { ApiError, NetworkError, type ConnectionConfig } from '../client'
import type { ServerProperties, WorldInfo } from '../types'

const mockWorld: WorldInfo = {
  name: 'world',
  type: 'normal',
  seed: '1234567890',
  sizeGB: 1.2,
  difficulty: 'easy',
  gameMode: 'survival',
  viewDistance: 10,
  simulationDistance: 10,
  onlinePlayers: 0,
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
  lastSave: null,
  gameDays: 12,
  dimensions: [{ name: 'overworld', icon: 'grass_block', playerCount: 0 }],
}

const mockProps: ServerProperties = {
  motd: 'A Demo Server',
  'view-distance': '10',
  'rcon.password': '********',
  'white-list': 'false',
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

function err(code: number, message: string, httpStatus: number) {
  return HttpResponse.json(
    { status: 'error', code, message, details: null, timestamp: '' },
    { status: httpStatus },
  )
}

let lastPutBody: unknown

const server = setupServer(
  http.get('*/api/v1/instances/inst1/world', () => ok(mockWorld)),
  http.get('*/api/v1/instances/inst1/properties', () => ok(mockProps)),
  http.put('*/api/v1/instances/inst1/properties', async ({ request }) => {
    lastPutBody = await request.json()
    return ok({ restartRequired: ['view-distance'] })
  }),
  // 错误传播专用实例（正常用例不可见，仅错误用例命中）
  http.get('*/api/v1/instances/inst-err/world', () => err(50300, 'server offline', 503)),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

const config: ConnectionConfig = { baseUrl: 'http://localhost:25566', apiKey: 'test-key' }

describe('world API', () => {
  it('GET 世界信息：嵌套字段解包（dimensions 数组保持结构）', async () => {
    const res = await apiGetWorld(config, 'inst1')
    expect(res.name).toBe('world')
    expect(res.difficulty).toBe('easy')
    expect(res.gameMode).toBe('survival')
    expect(res.dimensions).toHaveLength(1)
    expect(res.dimensions[0]).toMatchObject({ name: 'overworld', playerCount: 0 })
    expect(res.lastSave).toBeNull()
  })

  it('GET server.properties：Record 键值解包（敏感键 ******** 占位原样透传）', async () => {
    const res = await apiGetProperties(config, 'inst1')
    expect(res).toMatchObject({ motd: 'A Demo Server', 'view-distance': '10' })
    expect(res['rcon.password']).toBe('********')
  })

  it('PUT 更新属性：payload 透传请求体，restartRequired 数组解包', async () => {
    const props: ServerProperties = { ...mockProps, 'view-distance': '12' }
    const res = await apiUpdateProperties(config, 'inst1', props)
    expect(res.restartRequired).toEqual(['view-distance'])
    expect(lastPutBody).toEqual(props)
  })

  it('非 2xx 错误信封：ApiError 携带错误码与 HTTP 状态传播', async () => {
    await expect(apiGetWorld(config, 'inst-err')).rejects.toBeInstanceOf(ApiError)
    await expect(apiGetWorld(config, 'inst-err')).rejects.toMatchObject({
      name: 'ApiError',
      code: 50300,
      httpStatus: 503,
    })
  })

  it('200 非 JSON 载荷：NetworkError（响应解析失败）', async () => {
    server.use(
      http.get('*/api/v1/instances/inst1/properties', () =>
        HttpResponse.text('gateway timeout html'),
      ),
    )
    await expect(apiGetProperties(config, 'inst1')).rejects.toMatchObject({
      name: 'NetworkError',
      message: expect.stringContaining('响应解析失败'),
    })
  })

  it('网络层失败：NetworkError（fetch TypeError 归一）', async () => {
    server.use(http.get('*/api/v1/instances/inst1/world', () => HttpResponse.error()))
    await expect(apiGetWorld(config, 'inst1')).rejects.toBeInstanceOf(NetworkError)
    await expect(apiGetWorld(config, 'inst1')).rejects.not.toBeInstanceOf(ApiError)
  })
})
