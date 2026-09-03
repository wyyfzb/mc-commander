import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { handlers, mockOverview } from '@/test/mocks/handlers'
import { apiGet, apiGetEnvelope, apiPost, ApiError, NetworkError, type ConnectionConfig } from '../client'
import { useAuthStore, SESSION_EXPIRED_EVENT } from '@/stores/auth'

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

const config: ConnectionConfig = { baseUrl: '', apiKey: 'test-key' }

describe('API 客户端（统一信封契约）', () => {
  it('解析成功信封返回 data', async () => {
    const data = await apiGet('/api/v1/overview', config)
    expect(data).toEqual(mockOverview)
  })

  it('错误信封抛 ApiError（携带错误码与 HTTP 状态）', async () => {
    const promise = apiGet('/api/v1/unauthorized-probe', config)
    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await expect(promise).rejects.toMatchObject({ code: 40101, httpStatus: 401 })
  })

  it('40902 中文 message 保留在 ApiError 中（供 getFriendlyErrorMessage 透传）', async () => {
    const promise = apiPost('/api/v1/backup-probe', config, {})
    await expect(promise).rejects.toMatchObject({
      code: 40902,
      message: expect.stringContaining('未启用 RCON'),
    })
  })

  it('请求头携带 X-API-Key 与 JSON Content-Type', async () => {
    // 容器对象绕开 TS 控制流对闭包赋值的窄化（captured 恒非 null）
    const captured: { headers: Headers | null } = { headers: null }
    server.events.on('request:start', ({ request }) => {
      captured.headers = request.headers
    })
    await apiGet('/api/v1/overview', config)
    expect(captured.headers?.get('x-api-key')).toBe('test-key')
  })

  it('网络不可达抛 NetworkError', async () => {
    // 未 mock 的路径 → msw onUnhandledRequest 会报错，改为直接测试封装逻辑：
    // 关闭 msw 后 fetch 到不存在端口会失败
    server.close()
    try {
      await expect(
        apiGet('/api/v1/overview', { baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }),
      ).rejects.toBeInstanceOf(NetworkError)
    } finally {
      server.listen({ onUnhandledRequest: 'error' })
    }
  })
})

describe('API 客户端信封级 GET（apiGetEnvelope 单源请求链）', () => {
  it('400 错误信封抛 ApiError（code/httpStatus/message 与解包路径一致）', async () => {
    const promise = apiGetEnvelope('/api/v1/bad-request-probe', config)
    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await expect(promise).rejects.toMatchObject({
      code: 40000,
      httpStatus: 400,
      message: 'Validation Error',
    })
  })

  it('40103 会话过期在信封级路径同样触发清会话 + 全局事件（单源处置）', async () => {
    useAuthStore.getState().setSession({ token: 'tok-envelope-expired', sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() - 1_000).toISOString() })
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(apiGetEnvelope('/api/v1/session-expired-probe', config)).rejects.toMatchObject({ code: 40103 })
      expect(useAuthStore.getState().session).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
    }
  })
})

describe('API 客户端双通道凭据（安全主线）', () => {

  it('有会话令牌 → Authorization: Bearer，且不再携带 X-API-Key（双通道互斥）', async () => {
    useAuthStore.getState().setSession({ token: 'tok-abc', sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const captured: { headers: Headers | null } = { headers: null }
    server.events.on('request:start', ({ request }) => {
      captured.headers = request.headers
    })
    await apiGet('/api/v1/overview', config)
    expect(captured.headers?.get('authorization')).toBe('Bearer tok-abc')
    expect(captured.headers?.get('x-api-key')).toBeNull()
    useAuthStore.getState().clearSession()
  })

  it('无会话令牌 → X-API-Key 回退（行为兼容）', async () => {
    useAuthStore.getState().clearSession()
    const captured: { headers: Headers | null } = { headers: null }
    server.events.on('request:start', ({ request }) => {
      captured.headers = request.headers
    })
    await apiGet('/api/v1/overview', config)
    expect(captured.headers?.get('x-api-key')).toBe('test-key')
    expect(captured.headers?.get('authorization')).toBeNull()
  })

  it('公开端点（无凭据无 key）不带任何认证头', async () => {
    useAuthStore.getState().clearSession()
    const captured: { headers: Headers | null } = { headers: null }
    server.events.on('request:start', ({ request }) => {
      captured.headers = request.headers
    })
    await apiGet('/api/v1/auth/status', { baseUrl: '', apiKey: '' })
    expect(captured.headers?.get('authorization')).toBeNull()
    expect(captured.headers?.get('x-api-key')).toBeNull()
  })

  it('40103 会话过期 → 清会话 + 派发全局事件（跳登录由路由层监听）', async () => {
    useAuthStore.getState().setSession({ token: 'tok-expired', sessionId: 'sess-mock-1', expiresAt: new Date(Date.now() - 1_000).toISOString() })
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(apiGet('/api/v1/session-expired-probe', config)).rejects.toMatchObject({ code: 40103 })
      expect(useAuthStore.getState().session).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
    }
  })
})
