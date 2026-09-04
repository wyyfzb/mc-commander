import { apiGetEnvelope, type ConnectionConfig } from './client'
import type { AuditLogItem, CommandHistoryItem } from './types'

export interface AuditQueryParams {
  instanceId?: string
  action?: string
  targetType?: string
  startTime?: string
  endTime?: string
  source?: string
  page?: number
  pageSize?: number
  /** 时间排序（issue 383）：asc 正序 / desc 倒序；desc 为服务端默认，不传以保持请求最短 */
  order?: 'asc' | 'desc'
}

/** 统一查询串构造（两通道共用；空值不编码） */
export function buildAuditQuery(params: AuditQueryParams): string {
  const qs = new URLSearchParams()
  if (params.instanceId) qs.set('instanceId', params.instanceId)
  if (params.action) qs.set('action', params.action)
  if (params.targetType) qs.set('targetType', params.targetType)
  if (params.startTime) qs.set('startTime', params.startTime)
  if (params.endTime) qs.set('endTime', params.endTime)
  if (params.source) qs.set('source', params.source)
  if (params.page) qs.set('page', String(params.page))
  if (params.pageSize) qs.set('pageSize', String(params.pageSize))
  if (params.order) qs.set('order', params.order)
  const q = qs.toString()
  return q ? `?${q}` : ''
}

/** 信封级变体：额外返回分页信息（total / totalPages），供页面分页控件消费 */
export function apiGetAuditLogsPage(config: ConnectionConfig, params: AuditQueryParams = {}, signal?: AbortSignal) {
  return apiGetEnvelope<AuditLogItem[]>(`/api/v1/audit-logs${buildAuditQuery(params)}`, config, signal)
}

/** 信封级变体：额外返回分页信息（total / totalPages），供页面分页控件消费 */
export function apiGetCommandHistoryPage(config: ConnectionConfig, params: AuditQueryParams = {}, signal?: AbortSignal) {
  return apiGetEnvelope<CommandHistoryItem[]>(`/api/v1/command-history${buildAuditQuery(params)}`, config, signal)
}
