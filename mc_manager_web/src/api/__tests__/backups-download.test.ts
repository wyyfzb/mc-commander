import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { apiDownloadBackup } from '../backups'
import type { ConnectionConfig } from '../client'

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
      { status: 'error', code: 40904, message: '旧格式备份不支持恢复', details: null },
      { status: 409 },
    )
  }),
  http.get('http://localhost:25566/api/v1/backups/999/download', () => {
    return HttpResponse.json(
      { status: 'error', code: 40402, message: 'Backup not found', details: null },
      { status: 404 },
    )
  }),
)

beforeEach(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.close())

describe('apiDownloadBackup', () => {
  it('returns blob for successful download', async () => {
    const blob = await apiDownloadBackup(config, 1)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toContain('gzip')
  })

  it('throws error message from server for 409', async () => {
    await expect(apiDownloadBackup(config, 2)).rejects.toThrow('旧格式备份不支持恢复')
  })

  it('throws error for 404', async () => {
    await expect(apiDownloadBackup(config, 999)).rejects.toThrow('Backup not found')
  })
})
