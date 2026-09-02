import { z } from 'zod'

/** 统一分页结构 */
export const paginationSchema = z.object({
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
})

/** 成功响应信封 */
export const apiEnvelopeSchema = z.object({
  status: z.literal('ok'),
  code: z.literal(0),
  message: z.string(),
  data: z.unknown(),
  pagination: paginationSchema.optional(),
  timestamp: z.string(),
})

/** 泛型成功信封（类型推导用，运行时用 apiEnvelopeSchema） */
export function makeApiEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    status: z.literal('ok'),
    code: z.literal(0),
    message: z.string(),
    data: dataSchema,
    pagination: paginationSchema.optional(),
    timestamp: z.string(),
  })
}

/** 错误响应信封 */
export const apiErrorEnvelopeSchema = z.object({
  status: z.literal('error'),
  code: z.number(),
  message: z.string(),
  details: z.unknown(),
  timestamp: z.string(),
})

export type Pagination = z.infer<typeof paginationSchema>
export type ApiEnvelope<T = unknown> = z.infer<typeof apiEnvelopeSchema> & { data: T }
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>
