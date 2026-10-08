/**
 * TanStack Query 集成（设计文档 §5.1 queries.ts）
 * Query key 分层：['instance'] / ['players', {q, mode}] / ['logs', id] …
 * 提供 key 工厂 + 基础 hook（overview/system-stats/logs 等）；
 * 各领域 queries.ts 见 features/<domain>/queries.ts
 */
import { useQuery } from '@tanstack/react-query'
import { apiGet } from './client'
import { fetchAuthCapabilities } from './auth'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore } from '@/stores/auth'
import type {
  CrashArtifact,
  InstanceStatus,
  InstanceSummary,
  LogEntry,
  OverviewData,
  SystemStats,
  UpdateCheckResult,
} from './types'
import { apiGetAuditLogsPage, apiGetCommandHistoryPage, type AuditQueryParams } from './audit'

/**
 * WS 断开时的保底轮询间隔（毫秒）。单一事实源：degradation-banners 的
 * 「每 N 秒」文案由此拼接——两处各自写死曾导致横幅长期谎报 5s（实际 30s）
 */
export const FALLBACK_POLL_INTERVAL_MS = 30_000

/**
 * 推送面（MSMP）在线时名单类查询的保底轮询间隔。
 *
 * 名单由推送即时驱动（加入/离开 + 官方名单变化都会失效重取），30s 一轮纯属空转；
 * 但不关掉轮询：推送半开、服务端卡住这类情况下它就是唯一能自愈的路径。
 * 判据取自 `capabilities.msmpPush`（服务端按常驻连接是否建立上报），掉线后
 * 这条查询会回到 30s。
 */
export const PUSHED_POLL_INTERVAL_MS = 300_000

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
  crashArtifact: (id: string) => [...queryKeys.all, 'crash-artifact', id] as const,
  datapacks: (id: string) => [...queryKeys.all, 'datapacks', id] as const,
  pushChannel: (id: string) => [...queryKeys.all, 'push-channel', id] as const,
  auditLogs: (params?: AuditQueryParams) => [...queryKeys.all, 'audit-logs', params ?? {}] as const,
  commandHistory: (params?: AuditQueryParams) =>
    [...queryKeys.all, 'command-history', params ?? {}] as const,
  webhooks: () => [...queryKeys.all, 'webhooks'] as const,
  webhookDeliveries: (id: number) => [...queryKeys.all, 'webhooks', id, 'deliveries'] as const,
  checkUpdate: () => [...queryKeys.all, 'check-update'] as const,
  /** 管理员活跃会话列表（账号与安全面板，30s 轮询） */
  authSessions: () => [...queryKeys.all, 'auth-sessions'] as const,
  /** 两步验证状态（账号与安全面板；挂靠/关闭成功后失效重取） */
  totpStatus: () => [...queryKeys.all, 'totp-status'] as const,
  /**
   * 部署能力探测（当前仅 apiKeyEnabled）。按**面板身份**细分：能力属于面板而非本机，
   * 换地址必须重取。凭据刻意不进 key——key 会进 devtools 与持久化缓存。
   */
  authCapabilities: (baseUrl: string, credential: string) =>
    [...queryKeys.all, 'auth-capabilities', baseUrl, credential] as const,
  /** 归档快照清点（全局面：不属于某个实例，卸载实例后遗留的快照都在这里） */
  archivedSnapshots: () => [...queryKeys.all, 'archived-snapshots'] as const,
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
/**
 * 最新一份崩溃诊断产物（MC 崩溃报告或 JVM 崩溃日志）。
 *
 * **不轮询**：崩溃产物是事后产物，只在崩溃后新增——按需拉取即可，轮询等于每次都给
 * 磁盘做一次目录枚举 + 解析。崩溃事件发生时由调用方 invalidate（见 dashboard-page）。
 * 从未崩溃过时服务端返回 null，这是正常空态（不是 loading、也不是错误）。
 */
export function useCrashArtifact(instanceId: string | null) {
  const config = useConnectionStore()
  return useQuery({
    queryKey: queryKeys.crashArtifact(instanceId ?? ''),
    queryFn: ({ signal }) =>
      apiGet<CrashArtifact | null>(`/api/v1/instances/${instanceId}/crash-report`, config, signal),
    enabled: config.status === 'ready' && Boolean(instanceId),
    retry: false,
  })
}

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
    queryFn: ({ signal }) => apiGet<InstanceSummary[]>(`/api/v1/instances`, config, signal),
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

/**
 * 部署能力探测：服务端 API Key 通道是否开放（`GET /auth/capabilities`）。
 *
 * 为什么不吃 store 而由调用方传面板地址与 API Key：连接表单在**保存前**就要判定能力，
 * 而这一刻 store 里还是旧地址/旧凭据——用表单草稿值才能让用户填完 Key 后立刻看到真结果。
 * 地址应由调用方给**停止输入后落定**的值（连接表单用 useDebouncedValue）：每个中间态都是新的
 * query key，落定是让请求数从「按键数」回到 1 的必要条件。请求数上限即按键数——27 字符的地址
 * 最坏 27 发；门槛又挡掉 scheme 之前的中间态（`h`…`https://` 共 8 个）→ 实发 19 发。
 * 门槛另担一项独占职责：空地址不发请求（见 isFetchableBaseUrl）。
 *
 * `credential` 只参与 query key（用于换凭据后重取），不进请求配置——请求凭据由 apiRequest
 * 按双通道规则注入（会话优先）。
 *
 * `retry: false`：探测失败最多两类——地址不对（网络错误）或凭据还不对（401），
 * 两者都不会因重试变好，每次落定最多打一发，不在用户输入过程中放大失败流量。
 */
export function useApiKeyCapabilities(baseUrl: string, credential: string, signal?: AbortSignal) {
  const session = useAuthStore((s) => s.session)
  return useQuery({
    queryKey: queryKeys.authCapabilities(baseUrl, credential || session?.token || ''),
    queryFn: () => fetchAuthCapabilities({ baseUrl, apiKey: credential }, signal),
    enabled: (Boolean(credential) || Boolean(session?.token)) && isFetchableBaseUrl(baseUrl),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** 面板地址是否已落定到可请求形态（空串与输入中间态都不发探测请求） */
function isFetchableBaseUrl(baseUrl: string): boolean {
  // 空串 = 同源（onboarding 与 dev 的默认形态）。刻意不探测：那是「还没指明面板」的状态，
  // 请求会打到本机 origin 并让 client 把「令牌被该地址接受」回填成会话的签发面板
  // （backfillSessionPanel），把一个尚未选定的默认值钉成面板身份。
  if (baseUrl === '') return false
  if (!/^https?:\/\//.test(baseUrl)) return false
  try {
    // 无主机或主机里还夹着非法字符（`192.168.1.100:` 这类中间态）即判为草稿
    return new URL(baseUrl).hostname !== ''
  } catch {
    return false
  }
}
