/**
 * world 域 TanStack Query hooks 行为级测试（issue 476：数据访问层零防护收口）
 * 真链路取向：msw 拦截真实请求（不 mock api 层），保存属性后 properties+world 双失效
 * 经 msw 命中计数验证，错误传播断言 error state 携带 ApiError
 * 数据均为虚构测试值，不含真实服务器信息（敏感键以 ******** 占位）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { useServerProperties, useUpdateProperties, useWorldInfo } from '../queries'
import { useConnectionStore } from '@/stores/connection'
import { ApiError } from '@/api/client'
import type { ServerProperties, WorldInfo } from '@/api/types'

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
}

let worldHits = 0
let propsHits = 0
let putHits = 0

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

const server = setupServer(
  http.get('*/api/v1/instances/inst1/world', () => {
    worldHits++
    return ok(mockWorld)
  }),
  http.get('*/api/v1/instances/inst1/properties', () => {
    propsHits++
    return ok(mockProps)
  }),
  http.put('*/api/v1/instances/inst1/properties', () => {
    putHits++
    return ok({ restartRequired: ['view-distance'] })
  }),
  // 错误传播专用（正常用例不可见，仅错误用例命中）
  http.get('*/api/v1/instances/inst-err/world', () => err(50300, 'server offline', 503)),
  http.put('*/api/v1/instances/inst-err/properties', () => err(40024, 'invalid property key', 400)),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    qc,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  }
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  worldHits = propsHits = putHits = 0
})

describe('useWorldInfo', () => {
  it('连接就绪：拉取世界信息并解包嵌套字段', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useWorldInfo('inst1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({
      name: 'world',
      difficulty: 'easy',
      gameMode: 'survival',
    })
    expect(result.current.data?.dimensions).toHaveLength(1)
    expect(worldHits).toBe(1)
  })

  it('enabled 门控：instanceId=null 不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useWorldInfo(null), { wrapper })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.fetchStatus).toBe('idle')
    expect(worldHits).toBe(0)
  })

  it('查询失败：error state 携带 ApiError（错误码真实传播）', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useWorldInfo('inst-err'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).code).toBe(50300)
  })
})

describe('useServerProperties', () => {
  it('连接就绪：拉取 properties（敏感键 ******** 占位原样透传）', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useServerProperties('inst1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({ motd: 'A Demo Server', 'view-distance': '10' })
    expect(result.current.data?.['rcon.password']).toBe('********')
    expect(propsHits).toBe(1)
  })
})

describe('useUpdateProperties', () => {
  it('保存成功：restartRequired 解包 + properties/world 双失效（同步刷新世界字段）', async () => {
    const { wrapper } = makeWrapper()
    const props = renderHook(() => useServerProperties('inst1'), { wrapper })
    const world = renderHook(() => useWorldInfo('inst1'), { wrapper })
    await waitFor(() => expect(props.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(world.result.current.isSuccess).toBe(true))
    expect(propsHits).toBe(1)
    expect(worldHits).toBe(1)

    const { result } = renderHook(() => useUpdateProperties('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate({ ...mockProps, 'view-distance': '12' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.restartRequired).toEqual(['view-distance'])
    expect(putHits).toBe(1)
    // onSuccess 双 invalidate → 两个活跃 observer 均 refetch
    await waitFor(() => {
      expect(propsHits).toBe(2)
      expect(worldHits).toBe(2)
    })
  })

  it('instanceId=null：mutate 前置拒绝「未选择实例」，不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUpdateProperties(null), { wrapper })
    await act(async () => {
      result.current.mutate({ ...mockProps })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).not.toBeInstanceOf(ApiError)
    expect((result.current.error as Error).message).toBe('未选择实例')
    expect(putHits).toBe(0)
  })

  it('请求失败：mutation error 携带 ApiError，不触发双失效', async () => {
    const { wrapper } = makeWrapper()
    const props = renderHook(() => useServerProperties('inst1'), { wrapper })
    await waitFor(() => expect(props.result.current.isSuccess).toBe(true))
    expect(propsHits).toBe(1)

    const { result } = renderHook(() => useUpdateProperties('inst-err'), { wrapper })
    await act(async () => {
      result.current.mutate({ ...mockProps })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).code).toBe(40024)
    await act(async () => {
      await Promise.resolve()
    })
    expect(propsHits).toBe(1)
    expect(worldHits).toBe(0)
  })
})
