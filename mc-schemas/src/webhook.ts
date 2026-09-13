import { z } from 'zod'

/** 渠道预设：generic=项目通用格式；其余为国内平台特化格式（签名协议/消息体互不兼容） */
export const WEBHOOK_PLATFORMS = ['generic', 'feishu', 'dingtalk', 'wecom', 'serverchan', 'pushplus'] as const
export const webhookPlatformSchema = z.enum(WEBHOOK_PLATFORMS)
export type WebhookPlatform = z.infer<typeof webhookPlatformSchema>

export const webhookSchema = z.object({
  id: z.number(),
  name: z.string(),
  url: z.string(),
  secret: z.string().nullable(),
  // 响应 default 兜底：存量 mock/旧版服务端不带 platform 时按 generic 解析
  platform: webhookPlatformSchema.default('generic'),
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
  platform: webhookPlatformSchema.optional(),
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
