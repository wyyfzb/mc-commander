/**
 * WS 载荷的运行时校验。
 *
 * 契约表取自 `@mc-commander/schemas` 的 `WS_PAYLOAD_SCHEMAS`——与服务端发送前
 * 用的是同一张表。两端各存一份时，登记漏项会表现成「一边查一边不查」，而那正是
 * 契约最该生效的地方。
 *
 * 校验失败**不丢消息**：消费方的兜底读取（`?? 0`、`?? 'stdout'`）本来就是为
 * 「字段缺失」设计的，丢掉整条会把「服务端改了字段」表现成「功能偶发消失」，
 * 比带着旧数据渲染更难排查。故只告警并返回问题列表，由调用方决定是否上报。
 */
import { WS_PAYLOAD_SCHEMAS } from '@mc-commander/schemas'
import type { WsEventType } from '@mc-commander/schemas'
import type { z } from 'zod'

/**
 * 事件类型 → 载荷 schema 的查表。
 *
 * 入参是服务端发来的 `type` 字符串，不保证是事件目录里的键（`pong`/`auth` 是
 * 客户端消息的应答），故这里显式窄化：不属于事件目录的键一律视为无契约。
 */
function lookupSchema(type: string): z.ZodTypeAny | null {
  if (!Object.hasOwn(WS_PAYLOAD_SCHEMAS, type)) return null
  return WS_PAYLOAD_SCHEMAS[type as WsEventType] ?? null
}

/**
 * 校验一条 WS 消息的载荷。返回遇到的问题路径列表（空数组＝通过或无载荷契约）。
 * 非事件类型（`pong`/`auth`）与显式标为无载荷的事件都直接放行。
 */
export function validateWsPayload(type: string, data: unknown): string[] {
  const schema = lookupSchema(type)
  if (!schema) return []
  const parsed = schema.safeParse(data)
  if (parsed.success) return []
  const issues: string[] = parsed.error.issues.map(
    (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
  )
  console.warn(`[ws] ${type} 载荷不符合契约，按宽松读取处置：`, issues)
  return issues
}
