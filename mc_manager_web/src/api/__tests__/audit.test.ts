import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { apiGetAuditLogsPage, apiGetCommandHistoryPage } from '../audit'
import type { AuditLogItem, CommandHistoryItem } from '../types'
import type { ConnectionConfig } from '../client'

const mockAuditLogs: AuditLogItem[] = [
  { id: 1, instanceId: 'demo', action: 'INSTANCE_START', targetType: 'instance', targetId: 'demo', detail: null, source: 'api', createdAt: '2025-08-15T12:00:00Z' },
  { id: 2, instanceId: 'other', action: 'PLAYER_BAN', targetType: 'player', targetId: 'Steve', detail: { reason: 'cheat' }, source: 'api', createdAt: '2025-08-15T12:01:00Z' },
]

const mockCmdHistory: CommandHistoryItem[] = [
  { id: 1, instanceId: 'demo', command: 'say hello', source: 'api', success: true, response: '[Server] hello', durationMs: 42, createdAt: '2025-08-15T12:00:00Z' },
  { id: 2, instanceId: 'demo', command: 'invalid_cmd', source: 'api', success: false, response: 'Unknown command', durationMs: 15, createdAt: '2025-08-15T12:01:00Z' },
]

function ok<T>(data: T, pagination?: { total: number; page: number; pageSize: number; totalPages: number }) {
  return HttpResponse.json({
    status: 'ok', code: 0, message: 'Success', data,
    ...(pagination ? { pagination } : {}),
    timestamp: new Date().toISOString(),
  })
}

const server = setupServer(
  http.get('*/api/v1/audit-logs', ({ request }) => {
    const url = new URL(request.url)
    const action = url.searchParams.get('action')
    const filtered = action ? mockAuditLogs.filter(l => l.action === action) : mockAuditLogs
    return ok(filtered, { total: filtered.length, page: 1, pageSize: 20, totalPages: 1 })
  }),
  http.get('*/api/v1/command-history', () =>
    ok(mockCmdHistory, { total: mockCmdHistory.length, page: 1, pageSize: 20, totalPages: 1 })
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

const config: ConnectionConfig = { baseUrl: '', apiKey: 'test-key' }

describe('审计 API', () => {
  it('apiGetAuditLogsPage 传递 instanceId 过滤参数（buildAuditQuery 编码）', async () => {
    let capturedUrl = ''
    server.use(
      http.get('*/api/v1/audit-logs', ({ request }) => {
        capturedUrl = request.url
        const url = new URL(request.url)
        const instanceId = url.searchParams.get('instanceId')
        const filtered = instanceId ? mockAuditLogs.filter(l => l.instanceId === instanceId) : mockAuditLogs
        return ok(filtered, { total: filtered.length, page: 1, pageSize: 20, totalPages: 1 })
      }),
    )
    const { data } = await apiGetAuditLogsPage(config, { instanceId: 'demo' })
    expect(capturedUrl).toContain('instanceId=demo')
    expect(data.length).toBe(1)
    expect(data[0]!.instanceId).toBe('demo')
    server.resetHandlers()
  })

  it('apiGetAuditLogsPage 返回列表与分页信息', async () => {
    const { data, pagination } = await apiGetAuditLogsPage(config, { page: 1, pageSize: 20 })
    expect(data.length).toBe(2)
    expect(pagination).toEqual({ total: 2, page: 1, pageSize: 20, totalPages: 1 })
  })

  it('apiGetCommandHistoryPage 返回列表与分页信息', async () => {
    const { data, pagination } = await apiGetCommandHistoryPage(config)
    expect(data.length).toBe(2)
    expect(pagination?.total).toBe(2)
    expect(pagination?.totalPages).toBe(1)
  })
})
