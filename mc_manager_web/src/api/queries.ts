/**
 * TanStack Query 集成（设计文档 §5.1 queries.ts）
 * Query key 分层：['instance'] / ['players', {q, mode}] / ['logs', id] …
 * 提供 key 工厂 + 基础 hook（overview/system-stats/logs 等）；
 * 各领域 queries.ts 见 features/<domain>/queries.ts
 */
import { useQuery } from '@tanstack/react-query'
import { apiGet } from './client'
import { useConnectionStore } from '@/stores/connection'
import type { InstanceStatus, InstanceSummary, LogEntry, OverviewData, SystemStats, UpdateCheckResult } from './types'
import { apiGetAuditLogsPage, apiGetCommandHistoryPage, type AuditQueryParams } from './audit'

/**
 * WS 断开时的保底轮询间隔（毫秒）。单一事实源：degradation-banners 的
 * 「每 N 秒」文案由此拼接——两处各自写死曾导致横幅长期谎报 5s（实际 30s）
 */
export const FALLBACK_POLL_INTERVAL_MS = 30_000

// ── Query key 工厂（分层规范，防冲突）───────────────────────────
export const queryKeys = {
  all: ['mcs'] as const,
  overview: () => [...queryKeys.all, 'overview'] as const,
  systemStats: () => [...queryKeys.all, 'system-stats'] as const,
  instances: () => [...queryKeys.all, 'instances'] as const,
  instance: (id: string) => [...queryKeys.all, 'instances', id] as const,
  /** 部署进度兜底快照（单例查询：全局至多一条在途部署；置于 'deploy' 段下避免与
   *  per-instance 的 ['mcs','instances',id] 前缀冲突——同名实例 id 会撞缓存条目） */
  deployStatus: () => [...queryKeys.all, 'deploy', 'status'] as const,
  logs: (id: string) => [...queryKeys.all, 'logs', id] as const,
  players: (id: string, filters?: { q?: string; mode?: string }) =>
    [...queryKeys.all, 'players', id, filters ?? {}] as const,
  backups: (id: string) => [...queryKeys.all, 'backups', id] as const,
  tasks: (id: string) => [...queryKeys.all, 'tasks', id] as const,
  /** 任务执行历史（编辑对话框内展示） */
  taskHistory: (taskId: number) => [...queryKeys.all, 'tasks', 'history', taskId] as const,
  plugins: (id: string) => [...queryKeys.all, 'plugins', id] as const,
  files: (id: string, dir: string) => [...queryKeys.all, 'files', id, dir] as const,
  /** 文件内容（按完整文件路径细分） */
  fileContent: (id: string, filePath: string) =>
    [...queryKeys.all, 'files', id, 'content', filePath] as const,
  world: (id: string) => [...queryKeys.all, 'world', id] as const,
  properties: (id: string) => [...queryKeys.all, 'properties', id] as const,
  auditLogs: (params?: AuditQueryParams) => [...queryKeys.all, 'audit-logs', params ?? {}] as const,
  commandHistory: (params?: AuditQueryParams) => [...queryKeys.all, 'command-history', params ?? {}] as const,
  webhooks: () => [...queryKeys.all, 'webhooks'] as const,
  webhookDeliveries: (id: number) => [...queryKeys.all, 'webhooks', id, 'deliveries'] as const,
  checkUpdate: () => [...queryKeys.all, 'check-update'] as const,
  /** 管理员活跃会话列表（账号与安全面板，30s 轮询） */
  authSessions: () => [...queryKeys.all, 'auth-sessions'] as const,
  /** 两步验证状态（账号与安全面板；挂靠/关闭成功后失效重取） */
  totpStatus: () => [...queryKeys.all, 'totp-status'] as const,
}

/** 面板概览（含云服务器系统级资源；未配置连接时禁用） */
export function useOverview() {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.overview(),
    queryFn: ({ signal }) => apiGet<OverviewData>('/api/v1/overview', config, signal),
    enabled: config.status === 'ready',
    refetchInterval: FALLBACK_POLL_INTERVAL_MS, // 轮询保底（与 WS 事件互补，设计文档 §5.2）
  })
}

/** 系统资源统计（云服务器资源，WS 推送 + 30s 保底轮询） */
export function useSystemStats() {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.systemStats(),
    queryFn: ({ signal }) => apiGet<SystemStats>('/api/v1/system-stats', config, signal),
    enabled: config.status === 'ready',
    refetchInterval: FALLBACK_POLL_INTERVAL_MS,
    staleTime: 30_000,
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
    refetchInterval: FALLBACK_POLL_INTERVAL_MS,
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
    refetchInterval: FALLBACK_POLL_INTERVAL_MS,
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

/** 审计日志（信封级分页；keepPreviousData 翻页不闪烁） */
export function useAuditLogs(params: AuditQueryParams = {}) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.auditLogs(params),
    queryFn: ({ signal }) => apiGetAuditLogsPage(config, params, signal),
    enabled: config.status === 'ready',
    placeholderData: (prev) => prev,
  })
}

/** 命令历史（信封级分页；keepPreviousData 翻页不闪烁） */
export function useCommandHistory(params: AuditQueryParams = {}) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.commandHistory(params),
    queryFn: ({ signal }) => apiGetCommandHistoryPage(config, params, signal),
    enabled: config.status === 'ready',
    placeholderData: (prev) => prev,
  })
}

/** 面板更新检查（1h staleTime，不轮询） */
export function useCheckUpdate() {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.checkUpdate(),
    queryFn: ({ signal }) => apiGet<UpdateCheckResult>('/api/v1/check-update', config, signal),
    enabled: config.status === 'ready',
    staleTime: 3_600_000,
  })
}
