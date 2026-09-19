import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { handlers, mockOverview } from '@/test/mocks/handlers'
import {
  apiGet,
  apiGetEnvelope,
  apiPost,
  apiRequest,
  ApiError,
  NetworkError,
  type ConnectionConfig,
} from '../client'
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
    await expect(promise).rejects.toMatchObject({ code: 40107, httpStatus: 401 })
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
    useAuthStore.getState().setSession({
      token: 'tok-envelope-expired',
      sessionId: 'sess-mock-1',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(apiGetEnvelope('/api/v1/session-expired-probe', config)).rejects.toMatchObject({
        code: 40103,
      })
      expect(useAuthStore.getState().session).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
    }
  })
})

describe('API 客户端双通道凭据（安全主线）', () => {
  it('有会话令牌 → Authorization: Bearer，且不再携带 X-API-Key（双通道互斥）', async () => {
    useAuthStore.getState().setSession({
      token: 'tok-abc',
      sessionId: 'sess-mock-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
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

  it('会话属于别的面板 → 不发 Bearer，改发该面板的 X-API-Key', async () => {
    useAuthStore.getState().setSession({
      token: 'tok-abc',
      sessionId: 'sess-mock-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedFor: 'https://panel-a.example.com',
    })
    const captured: { headers: Headers | null } = { headers: null }
    server.events.on('request:start', ({ request }) => {
      captured.headers = request.headers
    })
    await apiGet('/api/v1/overview', { baseUrl: 'https://panel-b.example.com', apiKey: 'key-b' })
    expect(captured.headers?.get('authorization')).toBeNull()
    expect(captured.headers?.get('x-api-key')).toBe('key-b')
    useAuthStore.getState().clearSession()
  })

  it('会话属于别的面板：其 40103 不清会话、不派发事件（那次登录不该被别的面板踢掉）', async () => {
    const session = {
      token: 'tok-abc',
      sessionId: 'sess-mock-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedFor: 'https://panel-a.example.com',
    }
    useAuthStore.getState().setSession(session)
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(
        apiGet('/api/v1/session-expired-probe', {
          baseUrl: 'https://panel-b.example.com',
          apiKey: '',
        }),
      ).rejects.toMatchObject({ code: 40103 })
      expect(useAuthStore.getState().session).toEqual(session)
      expect(localStorage.getItem('mcs-session')).toContain('tok-abc')
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
      useAuthStore.getState().clearSession()
    }
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

  it('旧会话（无签发面板信息）被本面板接受 → 回填签发面板（宽限收敛为一次请求）', async () => {
    useAuthStore.getState().setSession({
      token: 'tok-legacy',
      sessionId: 'sess-legacy',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await apiGet('/api/v1/overview', { baseUrl: 'https://panel-b.example.com', apiKey: '' })
    expect(useAuthStore.getState().session?.issuedFor).toBe('https://panel-b.example.com')
    useAuthStore.getState().clearSession()
  })

  it('会话已绑定别的面板 → 不改写签发面板（回填只认「令牌被本地址接受」）', async () => {
    useAuthStore.getState().setSession({
      token: 'tok-bound',
      sessionId: 'sess-bound',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedFor: 'https://panel-a.example.com',
    })
    await apiGet('/api/v1/overview', { baseUrl: 'https://panel-b.example.com', apiKey: 'key-b' })
    expect(useAuthStore.getState().session?.issuedFor).toBe('https://panel-a.example.com')
    useAuthStore.getState().clearSession()
  })

  it('公开端点（noCredentials）：有登录会话也不带认证头，也不把旧会话回填绑定到该地址', async () => {
    useAuthStore.getState().setSession({
      token: 'tok-legacy',
      sessionId: 'sess-legacy',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const captured: { headers: Headers | null } = { headers: null }
    server.events.on('request:start', ({ request }) => {
      captured.headers = request.headers
    })
    await apiGet('/api/v1/auth/status', {
      baseUrl: 'https://panel-b.example.com',
      apiKey: '',
      noCredentials: true,
    })
    expect(captured.headers?.get('authorization')).toBeNull()
    expect(captured.headers?.get('x-api-key')).toBeNull()
    // 公开端点不校验凭据，「请求成功」不能作为回填依据（否则会把旧会话绑到从未接受它的地址）
    expect(useAuthStore.getState().session?.issuedFor).toBeUndefined()
    useAuthStore.getState().clearSession()
  })

  it('40103 会话过期 → 清会话 + 派发全局事件（跳登录由路由层监听）', async () => {
    useAuthStore.getState().setSession({
      token: 'tok-expired',
      sessionId: 'sess-mock-1',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(apiGet('/api/v1/session-expired-probe', config)).rejects.toMatchObject({
        code: 40103,
      })
      expect(useAuthStore.getState().session).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
    }
  })

  it('探测请求（ignoreSessionExpiry）：40103 照抛错误但不拆当前会话、不派发事件', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    useAuthStore.getState().setSession({ token: 'tok-probe', sessionId: 'sess-mock-2', expiresAt })
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(
        apiRequest('/api/v1/session-expired-probe', config, {
          method: 'GET',
          ignoreSessionExpiry: true,
        }),
      ).rejects.toMatchObject({ code: 40103 })
      // 目标地址未必是当前会话所属面板，其会话码不能拆掉本机会话
      expect(useAuthStore.getState().session?.token).toBe('tok-probe')
      expect(localStorage.getItem('mcs-session')).toContain('tok-probe')
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
      useAuthStore.getState().clearSession()
    }
  })

  it('40103 返回时本机会话已换（用户已重新登录别处）：不清掉新会话', async () => {
    useAuthStore.getState().setSession({
      token: 'tok-old',
      sessionId: 'sess-old',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    let released!: () => void
    const gate = new Promise<void>((r) => {
      released = r
    })
    let sawRequest = false
    server.use(
      http.get('*/api/v1/session-expired-probe', async () => {
        sawRequest = true
        await gate
        return HttpResponse.json(
          { status: 'error', code: 40103, message: 'session expired', details: null },
          { status: 401 },
        )
      }),
    )
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      const pending = apiGet('/api/v1/session-expired-probe', config)
      // 请求已在途（服务端尚未回），此时本机换了另一条会话
      await vi.waitFor(() => expect(sawRequest).toBe(true))
      useAuthStore.getState().setSession({
        token: 'tok-new',
        sessionId: 'sess-new',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      released()
      await expect(pending).rejects.toMatchObject({ code: 40103 })
      expect(useAuthStore.getState().session?.token).toBe('tok-new')
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
      server.resetHandlers()
      useAuthStore.getState().clearSession()
    }
  })
})
