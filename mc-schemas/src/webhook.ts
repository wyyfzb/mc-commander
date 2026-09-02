import { z } from 'zod'

export const webhookSchema = z.object({
  id: z.number(),
  name: z.string(),
  url: z.string(),
  secret: z.string().nullable(),
  events: z.array(z.string()),
  instanceId: z.string().nullable(),
  isEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const webhookCreatePayloadSchema = z.object({
  name: z.string(),
  url: z.string(),
  secret: z.string().nullable().optional(),
  events: z.array(z.string()).optional(),
  instanceId: z.string().nullable().optional(),
  isEnabled: z.boolean().optional(),
})

export const webhookDeliverySchema = z.object({
  id: z.number(),
  webhookId: z.number(),
  eventType: z.string(),
  instanceId: z.string().nullable(),
  payload: z.unknown(),
  status: z.enum(['pending', 'success', 'failed']),
  responseStatus: z.number().nullable(),
  responseBody: z.string().nullable(),
  durationMs: z.number().nullable(),
  attempts: z.number(),
  createdAt: z.string(),
})

export const webhookTestResultSchema = z.object({
  statusCode: z.number(),
  body: z.string().nullable(),
})

export type Webhook = z.infer<typeof webhookSchema>
export type WebhookCreatePayload = z.infer<typeof webhookCreatePayloadSchema>
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>
export type WebhookTestResult = z.infer<typeof webhookTestResultSchema>
