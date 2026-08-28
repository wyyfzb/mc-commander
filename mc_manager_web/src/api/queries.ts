/**
 * TanStack Query 集成（设计文档 §5.1 queries.ts）
 * Query key 分层：['instance'] / ['players', {q, mode}] / ['logs', id] …
 * 提供 key 工厂 + 基础 hook（overview/system-stats/logs 等）；
 * 各领域 queries.ts 见 features/<domain>/queries.ts
 */
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { apiGet, apiGetEnvelope } from './client'
import { useConnectionStore } from '@/stores/connection'
import type {
  AuditLogItem,
  CommandHistoryItem,
  InstanceStatus,
  InstanceSummary,
  LogEntry,
  OverviewData,
  SystemStats,
} from './types'
import type { AuditQueryParams } from './audit'
import { buildAuditQuery } from './audit'

// ── Query key 工厂（分层规范，防冲突）───────────────────────────
export const queryKeys = {
  all: ['mcs'] as const,
  overview: () => [...queryKeys.all, 'overview'] as const,
  systemStats: () => [...queryKeys.all, 'system-stats'] as const,
  instances: () => [...queryKeys.all, 'instances'] as const,
  instance: (id: string) => [...queryKeys.all, 'instances', id] as const,
  logs: (id: string) => [...queryKeys.all, 'logs', id] as const,
  players: (id: string, filters?: { q?: string; mode?: string }) =>
    [...queryKeys.all, 'players', id, filters ?? {}] as const,
  backups: (id: string) => [...queryKeys.all, 'backups', id] as const,
  tasks: (id: string) => [...queryKeys.all, 'tasks', id] as const,
  files: (id: string, dir: string) => [...queryKeys.all, 'files', id, dir] as const,
  /** 文件内容（按完整文件路径细分） */
  fileContent: (id: string, filePath: string) =>
    [...queryKeys.all, 'files', id, 'content', filePath] as const,
  world: (id: string) => [...queryKeys.all, 'world', id] as const,
  properties: (id: string) => [...queryKeys.all, 'properties', id] as const,
  auditLogs: (params: AuditQueryParams) =>
    [...queryKeys.all, 'audit-logs', params] as const,
  commandHistory: (params: AuditQueryParams) =>
    [...queryKeys.all, 'command-history', params] as const,
}

/** 面板概览（含云服务器系统级资源；未配置连接时禁用） */
export function useOverview() {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.overview(),
    queryFn: ({ signal }) => apiGet<OverviewData>('/api/v1/overview', config, signal),
    enabled: config.status === 'ready',
    refetchInterval: 30_000, // 轮询保底（与 WS 事件互补，设计文档 §5.2）
  })
}

/** 系统资源统计（云服务器资源，5s 轮询） */
export function useSystemStats() {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.systemStats(),
    queryFn: ({ signal }) => apiGet<SystemStats>('/api/v1/system-stats', config, signal),
    enabled: config.status === 'ready',
    refetchInterval: 5_000,
  })
}

/** 实例全量状态（WS 优先模式 30s 保底轮询；WS 事件即时更新走 server store） */
export function useInstanceStatus(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.instance(instanceId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<InstanceStatus>(`/api/v1/instances/${instanceId}`, config, signal),
    enabled: config.status === 'ready' && Boolean(instanceId),
    refetchInterval: 30_000,
  })
}

/** 实例列表（顶栏实例选择器数据源） */
export function useInstances() {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.instances(),
    queryFn: ({ signal }) =>
      apiGet<InstanceSummary[]>(`/api/v1/instances`, config, signal),
    enabled: config.status === 'ready',
    refetchInterval: 30_000,
  })
}

/** 实例历史日志（终端初始化源；条目 {text,type}） */
export function useInstanceLogs(instanceId: string, lines = 200) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: [...queryKeys.logs(instanceId), lines],
    queryFn: ({ signal }) =>
      apiGet<LogEntry[]>(`/api/v1/instances/${instanceId}/logs?lines=${lines}`, config, signal),
    enabled: config.status === 'ready' && Boolean(instanceId),
    staleTime: 5_000,
  })
}

/** 审计日志（信封级：items + pagination；翻页用 keepPreviousData 避免闪烁） */
export function useAuditLogs(params: AuditQueryParams = {}) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.auditLogs(params),
    queryFn: ({ signal }) =>
      apiGetEnvelope<AuditLogItem[]>(`/api/v1/audit-logs${buildAuditQuery(params)}`, config, signal),
    enabled: config.status === 'ready',
    placeholderData: keepPreviousData,
  })
}

/** 命令历史（信封级：items + pagination；翻页用 keepPreviousData 避免闪烁） */
export function useCommandHistory(params: AuditQueryParams = {}) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.commandHistory(params),
    queryFn: ({ signal }) =>
      apiGetEnvelope<CommandHistoryItem[]>(`/api/v1/command-history${buildAuditQuery(params)}`, config, signal),
    enabled: config.status === 'ready',
    placeholderData: keepPreviousData,
  })
}
