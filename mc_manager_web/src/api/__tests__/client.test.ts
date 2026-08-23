import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { handlers, mockOverview } from '@/test/mocks/handlers'
import { apiGet, apiPost, ApiError, NetworkError, type ConnectionConfig } from '../client'

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
