import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import {
  apiGetWebhooks,
  apiGetWebhookEventTypes,
  apiCreateWebhook,
  apiDeleteWebhook,
} from '@/api/webhooks'
import type { ConnectionConfig } from '@/api/client'

const config: ConnectionConfig = {
  baseUrl: 'http://localhost:25566',
  apiKey: 'mock',
}

const mockWebhooks = [
  {
    id: 1,
    name: 'Discord',
    url: 'https://discord.com/api/webhooks/x',
    secret: '********',
    events: ['player.join'],
    instanceId: null,
    isEnabled: true,
    createdAt: '2026-08-28T00:00:00Z',
    updatedAt: '2026-08-28T00:00:00Z',
  },
  {
    id: 2,
    name: 'Slack',
    url: 'https://hooks.slack.com/services/x',
    secret: null,
    events: [],
    instanceId: null,
    isEnabled: false,
    createdAt: '2026-08-28T00:00:00Z',
    updatedAt: '2026-08-28T00:00:00Z',
  },
]

const eventTypes = ['player.join', 'player.leave', 'instance.start', 'ping']

let capturedUrl = ''
const server = setupServer(
  http.get('http://localhost:25566/api/v1/webhooks', ({ request }) => {
    capturedUrl = request.url
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Success',
      data: mockWebhooks,
      pagination: { total: 2, page: 1, pageSize: 20, totalPages: 1 },
      timestamp: new Date().toISOString(),
    })
  }),
  http.get('http://localhost:25566/api/v1/webhooks/event-types', () => {
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Success',
      data: eventTypes,
      timestamp: new Date().toISOString(),
    })
  }),
  http.post('http://localhost:25566/api/v1/webhooks', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Success',
      data: { ...mockWebhooks[0], id: 3, name: (body as { name: string }).name },
      timestamp: new Date().toISOString(),
    })
  }),
  http.delete('http://localhost:25566/api/v1/webhooks/1', () => {
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Webhook 已删除',
      data: null,
      timestamp: new Date().toISOString(),
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())

describe('Webhook API', () => {
  it('apiGetWebhooks 返回列表（信封）', async () => {
    const result = await apiGetWebhooks(config)
    expect(result.data).toHaveLength(2)
    expect(result.pagination?.total).toBe(2)
    expect(result.data?.[0]?.name).toBe('Discord')
    expect(capturedUrl).toContain('page=1')
  })

  it('apiGetWebhookEventTypes 返回事件类型列表', async () => {
    const types = await apiGetWebhookEventTypes(config)
    expect(Array.isArray(types)).toBe(true)
    expect(types).toContain('player.join')
    expect(types).toContain('ping')
  })

  it('apiCreateWebhook 发送 POST', async () => {
    const result = await apiCreateWebhook(config, {
      name: 'New Hook',
      url: 'https://example.com/hook',
    })
    expect(result.id).toBe(3)
    expect(result.name).toBe('New Hook')
  })

  it('apiDeleteWebhook 发送 DELETE', async () => {
    const result = await apiDeleteWebhook(config, 1)
    expect(result).toBeNull()
  })
})
