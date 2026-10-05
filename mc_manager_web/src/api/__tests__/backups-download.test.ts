import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { apiDownloadBackup } from '../backups'
import type { ConnectionConfig } from '../client'
import { useAuthStore, SESSION_EXPIRED_EVENT } from '@/stores/auth'

const config: ConnectionConfig = { baseUrl: 'http://localhost:25566', apiKey: 'test-key' }

const server = setupServer(
  http.get('http://localhost:25566/api/v1/backups/1/download', () => {
    const gzipHex = '1f8b0800000000000003'
    const body = Buffer.from(gzipHex, 'hex')
    return new HttpResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="test.tar.gz"',
      },
    })
  }),
  http.get('http://localhost:25566/api/v1/backups/2/download', () => {
    return HttpResponse.json(
      { status: 'error', code: 40000, message: 'Validation failed', details: null },
      { status: 400 },
    )
  }),
  http.get('http://localhost:25566/api/v1/backups/999/download', () => {
    return HttpResponse.json(
      { status: 'error', code: 40402, message: 'Backup not found', details: null },
      { status: 404 },
    )
  }),
)

beforeEach(() => {
  server.listen({ onUnhandledFrame: 'bypass' })
  useAuthStore.getState().clearSession()
})
afterEach(() => server.close())

describe('apiDownloadBackup', () => {
  it('returns blob for successful download', async () => {
    const blob = await apiDownloadBackup(config, 1)
    // realm 无关断言：CI 的 Node undici res.blob() 与 jsdom 全局 Blob 构造器不同，
    // toBeInstanceOf(Blob) 会跨 realm 失败；改用 Object.prototype.toString 判定
    expect(Object.prototype.toString.call(blob)).toBe('[object Blob]')
    expect(blob.type).toContain('gzip')
    expect(blob.size).toBeGreaterThan(0)
  })

  it('throws error message from server for 400', async () => {
    await expect(apiDownloadBackup(config, 2)).rejects.toThrow('Validation failed')
  })

  it('throws error for 404', async () => {
    await expect(apiDownloadBackup(config, 999)).rejects.toThrow('Backup not found')
  })

  it('会话属于本面板：携带 Bearer 且不发 X-API-Key（纯密码登录用户无 Key 也能下载）', async () => {
    useAuthStore.setState({
      session: { token: 'tok-bk', sessionId: 'sess-bk', expiresAt: '2030-01-01T00:00:00.000Z' },
    })
    const captured: { auth: string | null; key: string | null } = { auth: null, key: null }
    server.use(
      http.get('http://localhost:25566/api/v1/backups/1/download', ({ request }) => {
        captured.auth = request.headers.get('Authorization')
        captured.key = request.headers.get('X-API-Key')
        return new HttpResponse(Buffer.from('1f8b0800000000000003', 'hex'), {
          status: 200,
          headers: { 'Content-Type': 'application/gzip' },
        })
      }),
    )
    await apiDownloadBackup({ baseUrl: 'http://localhost:25566', apiKey: '' }, 1)
    expect(captured.auth).toBe('Bearer tok-bk')
    expect(captured.key).toBeNull()
  })

  it('会话属于别的面板：不发 Bearer，回落该面板的 X-API-Key', async () => {
    useAuthStore.setState({
      session: {
        token: 'tok-bk',
        sessionId: 'sess-bk',
        expiresAt: '2030-01-01T00:00:00.000Z',
        issuedFor: 'https://panel-a.example.com',
      },
    })
    const captured: { auth: string | null; key: string | null } = { auth: null, key: null }
    server.use(
      http.get('http://localhost:25566/api/v1/backups/1/download', ({ request }) => {
        captured.auth = request.headers.get('Authorization')
        captured.key = request.headers.get('X-API-Key')
        return new HttpResponse(Buffer.from('1f8b0800000000000003', 'hex'), {
          status: 200,
          headers: { 'Content-Type': 'application/gzip' },
        })
      }),
    )
    await apiDownloadBackup({ baseUrl: 'http://localhost:25566', apiKey: 'key-b' }, 1)
    expect(captured.auth).toBeNull()
    expect(captured.key).toBe('key-b')
  })

  it('下载遇 40103 且会话属于本面板：按会话过期处置（清会话 + 派发事件）', async () => {
    useAuthStore.setState({
      session: { token: 'tok-bk', sessionId: 'sess-bk', expiresAt: '2030-01-01T00:00:00.000Z' },
    })
    server.use(
      http.get('http://localhost:25566/api/v1/backups/1/download', () =>
        HttpResponse.json(
          { status: 'error', code: 40103, message: 'session expired', details: null },
          { status: 401 },
        ),
      ),
    )
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(apiDownloadBackup(config, 1)).rejects.toMatchObject({ code: 40103 })
      expect(useAuthStore.getState().session).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
    }
  })
})
