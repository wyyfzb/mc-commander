import { apiRequest, apiGetEnvelope, apiDelete } from './client'
import type { ConnectionConfig } from './client'
import type { Webhook, WebhookCreatePayload, WebhookDelivery, WebhookTestResult } from './types'

export async function apiGetWebhooks(config: ConnectionConfig, page = 1, pageSize = 20, signal?: AbortSignal) {
  return apiGetEnvelope<Webhook[]>(
    `/api/v1/webhooks?page=${page}&pageSize=${pageSize}`,
    config,
    signal,
  )
}

export async function apiGetWebhookEventTypes(config: ConnectionConfig, signal?: AbortSignal) {
  return apiRequest<string[]>(
    `/api/v1/webhooks/event-types`,
    config,
    { method: 'GET', signal },
  )
}

export async function apiGetWebhook(config: ConnectionConfig, id: number, signal?: AbortSignal) {
  return apiRequest<Webhook>(
    `/api/v1/webhooks/${id}`,
    config,
    { method: 'GET', signal },
  )
}

export async function apiCreateWebhook(config: ConnectionConfig, data: WebhookCreatePayload, signal?: AbortSignal) {
  return apiRequest<Webhook>(
    '/api/v1/webhooks',
    config,
    { method: 'POST', body: data, signal },
  )
}

export async function apiUpdateWebhook(config: ConnectionConfig, id: number, data: Partial<WebhookCreatePayload>, signal?: AbortSignal) {
  return apiRequest<Webhook>(
    `/api/v1/webhooks/${id}`,
    config,
    { method: 'PUT', body: data, signal },
  )
}

export async function apiDeleteWebhook(config: ConnectionConfig, id: number) {
  return apiDelete<null>(`/api/v1/webhooks/${id}`, config)
}

export async function apiTestWebhook(config: ConnectionConfig, id: number, signal?: AbortSignal) {
  return apiRequest<WebhookTestResult>(
    `/api/v1/webhooks/${id}/test`,
    config,
    { method: 'POST', signal },
  )
}

export async function apiGetWebhookDeliveries(config: ConnectionConfig, webhookId: number, page = 1, pageSize = 20, signal?: AbortSignal) {
  return apiGetEnvelope<WebhookDelivery[]>(
    `/api/v1/webhooks/${webhookId}/deliveries?page=${page}&pageSize=${pageSize}`,
    config,
    signal,
  )
}
