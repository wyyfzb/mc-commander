/**
 * WS 载荷的运行时校验表。
 *
 * 只对「有明确结构、且消费方会逐字段读取」的事件登记 schema；没有登记的事件
 * 直接跳过——这不是遗漏，是这批载荷尚未定契约（40 个事件里目前只有 9 个有
 * payload schema）。
 *
 * 校验失败**不丢消息**：消费方的兜底读取（`?? 0`、`?? 'stdout'`）本来就是为
 * 「字段缺失」设计的，丢掉整条会把「服务端改了字段」表现成「功能偶发消失」，
 * 比带着旧数据渲染更难排查。故只告警并计数，由调用方决定是否上报。
 */
import {
  wsStatusSnapshotSchema,
  wsPerformancePayloadSchema,
  wsLogPayloadSchema,
  wsStatusEventPayloadSchema,
  wsNameListChangedPayloadSchema,
  wsPlayerEventPayloadSchema,
  wsWeatherPayloadSchema,
  wsWorldUpgradePayloadSchema,
  wsBackupPayloadSchema,
  wsBackupProgressPayloadSchema,
} from '@mc-commander/schemas'
import type { z } from 'zod'

/** 事件类型 → 载荷 schema。多个事件共用一份结构时在此重复列出，便于按类型直接查表 */
const PAYLOAD_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  statusSnapshot: wsStatusSnapshotSchema,
  performanceUpdate: wsPerformancePayloadSchema,
  log: wsLogPayloadSchema,
  statusEvent: wsStatusEventPayloadSchema,
  nameListChanged: wsNameListChangedPayloadSchema,
  weatherUpdate: wsWeatherPayloadSchema,
  worldUpgrade: wsWorldUpgradePayloadSchema,
  backupStart: wsBackupPayloadSchema,
  backupComplete: wsBackupPayloadSchema,
  backupFailed: wsBackupPayloadSchema,
  backupSkipped: wsBackupPayloadSchema,
  backupCancelled: wsBackupPayloadSchema,
  backupProgress: wsBackupProgressPayloadSchema,
  playerJoin: wsPlayerEventPayloadSchema,
  playerLeave: wsPlayerEventPayloadSchema,
  playerDeath: wsPlayerEventPayloadSchema,
  playerRespawn: wsPlayerEventPayloadSchema,
  playerChat: wsPlayerEventPayloadSchema,
  playerSleep: wsPlayerEventPayloadSchema,
  achievement: wsPlayerEventPayloadSchema,
}

/**
 * 校验一条 WS 消息的载荷。返回遇到的问题路径列表（空数组＝通过或无契约）。
 * 没登记 schema 的事件直接返回——那批载荷尚未定契约，不是这里漏了。
 */
export function validateWsPayload(type: string, data: unknown): string[] {
  const schema = PAYLOAD_SCHEMAS[type]
  if (!schema) return []
  const parsed = schema.safeParse(data)
  if (parsed.success) return []
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  console.warn(`[ws] ${type} 载荷不符合契约，按宽松读取处置：`, issues)
  return issues
}
