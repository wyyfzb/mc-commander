import { apiGet, apiGetEnvelope, type ConnectionConfig } from './client'
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
  const q = qs.toString()
  return q ? `?${q}` : ''
}

export function apiGetAuditLogs(config: ConnectionConfig, params: AuditQueryParams = {}) {
  return apiGet<AuditLogItem[]>(`/api/v1/audit-logs${buildAuditQuery(params)}`, config)
}

/** 信封级变体：额外返回分页信息（total / totalPages），供页面分页控件消费 */
export function apiGetAuditLogsPage(config: ConnectionConfig, params: AuditQueryParams = {}) {
  return apiGetEnvelope<AuditLogItem[]>(`/api/v1/audit-logs${buildAuditQuery(params)}`, config)
}

export function apiGetCommandHistory(config: ConnectionConfig, params: AuditQueryParams = {}) {
  return apiGet<CommandHistoryItem[]>(`/api/v1/command-history${buildAuditQuery(params)}`, config)
}

/** 信封级变体：额外返回分页信息（total / totalPages），供页面分页控件消费 */
export function apiGetCommandHistoryPage(config: ConnectionConfig, params: AuditQueryParams = {}) {
  return apiGetEnvelope<CommandHistoryItem[]>(`/api/v1/command-history${buildAuditQuery(params)}`, config)
}
