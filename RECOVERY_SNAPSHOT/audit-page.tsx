/**
 * AuditPage -- 操作审计 & 命令历史页
 * 双 Tab：审计日志（高危操作记录）/ 命令历史（RCON 命令持久化）
 * 分页加载，支持实例/动作/时间范围过滤，过滤条件联动 CSV 导出
 * 数据获取统一使用 React Query（chore-30）
 */
import { useState, useCallback } from 'react'
import { Download, RefreshCw, ScrollText, Terminal, ChevronLeft, ChevronRight, Loader2, X, History } from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { apiDownloadAuditLogsCsv, apiDownloadCommandHistoryCsv, apiReplayCommand, type AuditLogQuery, type CommandHistoryQuery } from '@/api/audit'
import { saveBlobAsFile } from '@/api/csv-download'
import type { CommandHistoryItem } from '@/api/types'
import { useInstances, useAuditLogs, useCommandHistory } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { cn } from '@/lib/utils'

/** 审计动作中文映射 */
const ACTION_LABELS: Record<string, string> = {
  'instance.start': '启动实例',
  'instance.stop': '停止实例',
  'instance.restart': '重启实例',
  'instance.delete': '删除实例',
  'instance.soft_delete': '移到回收站',
  'instance.restore': '恢复实例',
  'instance.hard_delete': '永久删除实例',
  'instance.update': '更新实例',
  'instance.deploy': '部署实例',
  'instance.upgrade': '升级实例',
  'instance.upgrade_rollback': '升级回滚',
  'backup.create': '创建备份',
  'backup.restore': '恢复备份',
  'backup.delete': '删除备份',
  'player.op': '授权 OP',
  'player.deop': '取消 OP',
  'player.kick': '踢出玩家',
  'player.ban': '封禁玩家',
  'player.pardon': '解封玩家',
  'player.whitelist_add': '加入白名单',
  'player.whitelist_remove': '移出白名单',
  'player.inventory_edit': '编辑背包',
  'file.write': '写入文件',
  'file.delete': '删除文件',
  'file.upload': '上传文件',
  'file.mkdir': '创建目录',
  'file.rename': '重命名',
  'file.compress': '压缩',
  'file.decompress': '解压',
  'properties.update': '修改配置',
  'eula.accept': '同意 EULA',
  'task.create': '创建任务',
  'task.update': '更新任务',
  'task.delete': '删除任务',
  'task.run': '执行任务',
  'api_key.rotate': '轮换密钥',
  'auth.setup': '首次设置密码',
  'auth.login': '管理员登录',
  'auth.login_failed': '登录失败',
  'auth.logout': '退出登录',
  'auth.session_revoke': '踢出会话',
  'auth.password_change': '修改密码',
  'auth.totp_setup': '生成两步验证密钥',
  'auth.totp_enable': '启用两步验证',
  'auth.totp_disable': '关闭两步验证',
  'webhook.create': '创建 Webhook',
  'webhook.update': '更新 Webhook',
  'webhook.delete': '删除 Webhook',
  'webhook.test': '测试 Webhook',
  'plugin.upload': '上传插件',
  'plugin.delete': '删除插件',
  'command.replay': '命令回放',
}

/** 动作按类别分组（用于过滤器下拉） */
const ACTION_GROUPS: { label: string; actions: string[] }[] = [
  { label: '实例', actions: ['instance.start', 'instance.stop', 'instance.restart', 'instance.delete', 'instance.soft_delete', 'instance.restore', 'instance.hard_delete', 'instance.update', 'instance.deploy', 'instance.upgrade', 'instance.upgrade_rollback'] },
  { label: '备份', actions: ['backup.create', 'backup.restore', 'backup.delete'] },
  { label: '玩家', actions: ['player.op', 'player.deop', 'player.kick', 'player.ban', 'player.pardon', 'player.whitelist_add', 'player.whitelist_remove', 'player.inventory_edit'] },
  { label: '文件', actions: ['file.write', 'file.delete', 'file.upload', 'file.mkdir', 'file.rename', 'file.compress', 'file.decompress'] },
  { label: '配置', actions: ['properties.update', 'eula.accept'] },
  { label: '任务', actions: ['task.create', 'task.update', 'task.delete', 'task.run'] },
  { label: '安全', actions: ['api_key.rotate', 'auth.setup', 'auth.login', 'auth.login_failed', 'auth.logout', 'auth.session_revoke', 'auth.password_change', 'auth.totp_setup', 'auth.totp_enable', 'auth.totp_disable'] },
  { label: 'Webhook', actions: ['webhook.create', 'webhook.update', 'webhook.delete', 'webhook.test'] },
  { label: '插件', actions: ['plugin.upload', 'plugin.delete'] },
  { label: '命令', actions: ['command.replay'] },
]

function formatAction(action: string): string {
  return ACTION_LABELS[action] ?? action
}

/** 命令历史来源中文映射（api=控制台/API 通道；replay=回放产生，feat-20） */
function formatCommandSource(source: string): string {
  if (source === 'api') return 'API'
  if (source === 'replay') return '回放'
  return source
}

function formatTime(iso: string): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return iso
  }
}

/** 将 date input 的 YYYY-MM-DD 转为 ISO 起始/结束时间 */
function toIsoRange(startDate: string, endDate: string): { startTime?: string; endTime?: string } {
  if (!startDate && !endDate) return {}
  return {
    startTime: startDate ? `${startDate}T00:00:00` : undefined,
    endTime: endDate ? `${endDate}T23:59:59` : undefined,
  }
}

/** 分页大小可选项（双 Tab 共享） */
const PAGE_SIZE_OPTIONS = [20, 30, 50, 100] as const

export function AuditPage() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-mcs-xl font-semibold text-mcs-text-default">操作审计</h2>
          <p className="text-mcs-xs text-mcs-text-subtle">全部实例的高危操作记录、命令执行历史与安全事件</p>
        </div>
      </div>
      <Tabs defaultValue="audit" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="audit"><ScrollText aria-hidden className="size-3.5" />审计日志</TabsTrigger>
          <TabsTrigger value="commands"><Terminal aria-hidden className="size-3.5" />命令历史</TabsTrigger>
        </TabsList>
        <TabsContent value="audit" className="mt-3 min-h-0 flex-1">
          <AuditLogTab />
        </TabsContent>
        <TabsContent value="commands" className="mt-3 min-h-0 flex-1">
          <CommandHistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ============================================================
 * 审计日志 Tab（React Query 驱动，含过滤器 + 分页 + CSV 导出）
 * ============================================================ */
interface AuditFilters {
  instanceId: string
  action: string
  source: string
  startDate: string
  endDate: string
}

const DEFAULT_FILTERS: AuditFilters = { instanceId: '', action: '', source: '', startDate: '', endDate: '' }

function hasActiveFilters(f: AuditFilters): boolean {
  return Boolean(f.instanceId || f.action || f.source || f.startDate || f.endDate)
}

/** 从 filters 构建干净的查询参数（排除空值） */
function buildAuditQuery(page: number, pageSize: number, f: AuditFilters): AuditLogQuery {
  const query: AuditLogQuery = { page, pageSize }
  if (f.instanceId) query.instanceId = f.instanceId
  if (f.action) query.action = f.action
  if (f.source) query.source = f.source
  const { startTime, endTime } = toIsoRange(f.startDate, f.endDate)
  if (startTime) query.startTime = startTime
  if (endTime) query.endTime = endTime
  return query
}

function AuditLogTab() {
  const config = useConnectionStore()
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(30)
  const [exporting, setExporting] = useState(false)

  const { data: instances } = useInstances()
  const query = buildAuditQuery(page, pageSize, filters)
  const { data, isLoading, isFetching, isError, error, refetch } = useAuditLogs(query)

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const active = hasActiveFilters(filters)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const handleFilterChange = useCallback((patch: Partial<AuditFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }))
    setPage(1) // 过滤条件变化时回到第一页
  }, [])

  const handleReset = () => setFilters(DEFAULT_FILTERS)

  const handlePageSizeChange = (v: string) => {
    setPageSize(Number(v))
    setPage(1)
  }

  const handleExportCsv = async () => {
    setExporting(true)
    try {
      const csvQuery: Omit<AuditLogQuery, 'page' | 'pageSize'> = {}
      if (filters.instanceId) csvQuery.instanceId = filters.instanceId
      if (filters.action) csvQuery.action = filters.action
      if (filters.source) csvQuery.source = filters.source
      const { startTime, endTime } = toIsoRange(filters.startDate, filters.endDate)
      if (startTime) csvQuery.startTime = startTime
      if (endTime) csvQuery.endTime = endTime
      const { blob, filename } = await apiDownloadAuditLogsCsv(config, csvQuery)
      saveBlobAsFile(blob, filename || `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`)
      toast.success('审计日志已导出')
    } catch (e) {
      toast.error(`导出失败：${getFriendlyErrorText(e)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* -- 过滤器栏 -- */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.instanceId} onValueChange={(v) => handleFilterChange({ instanceId: v === '__all__' ? '' : v })}>
          <SelectTrigger size="sm" className="w-[160px]">
            <SelectValue placeholder="全部实例" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部实例</SelectItem>
            {instances?.map((inst) => (
              <SelectItem key={inst.id} value={inst.id}>{inst.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.action} onValueChange={(v) => handleFilterChange({ action: v === '__all__' ? '' : v })}>
          <SelectTrigger size="sm" className="w-[160px]">
            <SelectValue placeholder="全部操作" />
          </SelectTrigger>
          <SelectContent className="max-h-[320px]">
            <SelectItem value="__all__">全部操作</SelectItem>
            {ACTION_GROUPS.map((group) => (
              <SelectGroup key={group.label}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.actions.map((action) => (
                  <SelectItem key={action} value={action}>{formatAction(action)}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.source} onValueChange={(v) => handleFilterChange({ source: v === '__all__' ? '' : v })}>
          <SelectTrigger size="sm" className="w-[120px]">
            <SelectValue placeholder="全部来源" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部来源</SelectItem>
            <SelectItem value="api">API</SelectItem>
            <SelectItem value="scheduled_task">定时任务</SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={filters.startDate}
          onChange={(e) => handleFilterChange({ startDate: e.target.value })}
          placeholder="开始日期"
          className="h-7 w-[140px] text-mcs-xs"
          aria-label="开始日期"
        />
        <span className="text-mcs-xs text-mcs-text-subtle">~</span>
        <Input
          type="date"
          value={filters.endDate}
          onChange={(e) => handleFilterChange({ endDate: e.target.value })}
          placeholder="结束日期"
          className="h-7 w-[140px] text-mcs-xs"
          aria-label="结束日期"
        />

        {active && (
          <Button variant="ghost" size="sm" onClick={handleReset} className="text-mcs-text-subtle hover:text-mcs-text-default">
            <X aria-hidden className="size-3.5" />
            重置
          </Button>
        )}

        <span className="ml-auto text-mcs-xs text-mcs-text-subtle">共 {total} 条{active ? '（已过滤）' : ''}</span>
      </div>

      {/* -- 操作按钮 -- */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw aria-hidden className={cn(isFetching && 'animate-spin')} />
          刷新
        </Button>
        <Button variant="outline" size="sm" onClick={() => void handleExportCsv()} disabled={exporting}>
          {exporting
            ? <Loader2 aria-hidden className="animate-spin" />
            : <Download aria-hidden />}
          导出 CSV
        </Button>
      </div>

      {/* -- 表格 -- */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-mcs-border-muted bg-mcs-bg-muted">
        <table className="w-full text-mcs-sm" style={{ tableLayout: 'auto' }}>
          <thead className="sticky top-0 bg-mcs-bg-hover">
            <tr className="text-left text-mcs-xs text-mcs-text-subtle">
              <th className="whitespace-nowrap px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">操作</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">目标</th>
              <th className="px-3 py-2 font-medium">详情</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-mcs-border-muted">
            {isLoading && items.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-2"><Skeleton className="h-5 w-full" /><Skeleton className="mt-2 h-5 w-full" /><Skeleton className="mt-2 h-5 w-3/4" /></td></tr>
            )}
            {isError && items.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-mcs-error-fg">加载失败：{getFriendlyErrorText(error)}</td></tr>
            )}
            {!isLoading && !isError && items.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-mcs-text-subtle">{active ? '无匹配的审计记录' : '暂无审计记录'}</td></tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-mcs-state-hover transition-colors">
                <td className="whitespace-nowrap px-3 py-2 text-mcs-xs text-mcs-text-muted font-mono">{formatTime(item.createdAt)}</td>
                <td className="px-3 py-2 font-medium text-mcs-text-default">{formatAction(item.action)}</td>
                <td className="px-3 py-2 text-mcs-text-default">
                  {item.targetId
                    ? <span className="font-mono text-mcs-xs">{item.targetType ?? ''}/{item.targetId}</span>
                    : <span className="text-mcs-text-subtle">--</span>}
                </td>
                <td className="max-w-[40vw] truncate px-3 py-2 text-mcs-xs text-mcs-text-subtle">
                  {item.detail ? JSON.stringify(item.detail) : '--'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* -- 分页 -- */}
      {total > 0 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            <ChevronLeft aria-hidden />
          </Button>
          <span className="text-mcs-xs text-mcs-text-muted">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
            <ChevronRight aria-hidden />
          </Button>
          <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
            <SelectTrigger size="sm" className="w-[80px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>{size} 条/页</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * 命令历史 Tab（React Query 驱动，含实例过滤 + 命令回放，feat-20）
 * ============================================================ */
function buildCommandQuery(page: number, pageSize: number, instanceId: string, source: string): CommandHistoryQuery {
  const query: CommandHistoryQuery = { page, pageSize }
  if (instanceId) query.instanceId = instanceId
  if (source) query.source = source
  return query
}

function CommandHistoryTab() {
  const config = useConnectionStore()
  const [page, setPage] = useState(1)
  const [instanceFilter, setInstanceFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [pageSize, setPageSize] = useState(30)
  const [replayTarget, setReplayTarget] = useState<CommandHistoryItem | null>(null)
  const [replaying, setReplaying] = useState(false)
  const [exporting, setExporting] = useState(false)

  const { data: instances } = useInstances()
  const query = buildCommandQuery(page, pageSize, instanceFilter, sourceFilter)
  const { data, isLoading, isFetching, isError, error, refetch } = useCommandHistory(query)

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const replayInstanceName = instances?.find((i) => i.id === replayTarget?.instanceId)?.name ?? replayTarget?.instanceId ?? ''

  const handleFilterChange = useCallback((patch: { instanceId?: string; source?: string }) => {
    if (patch.instanceId !== undefined) setInstanceFilter(patch.instanceId)
    if (patch.source !== undefined) setSourceFilter(patch.source)
    setPage(1)
  }, [])

  const handlePageSizeChange = (v: string) => {
    setPageSize(Number(v))
    setPage(1)
  }

  const handleReplay = async () => {
    if (!replayTarget) return
    setReplaying(true)
    try {
      const { response } = await apiReplayCommand(config, replayTarget.id)
      const preview = response ? `：${response.length > 80 ? response.slice(0, 80) + '…' : response}` : ''
      toast.success(`命令已回放${preview}`)
      setReplayTarget(null)
      void refetch()
    } catch (e) {
      toast.error(`回放失败：${getFriendlyErrorText(e)}`)
    } finally {
      setReplaying(false)
    }
  }

  const handleExportCsv = async () => {
    setExporting(true)
    try {
      const csvQuery: Omit<CommandHistoryQuery, 'page' | 'pageSize'> = {}
      if (instanceFilter) csvQuery.instanceId = instanceFilter
      if (sourceFilter) csvQuery.source = sourceFilter
      const { blob, filename } = await apiDownloadCommandHistoryCsv(config, csvQuery)
      saveBlobAsFile(blob, filename || `command-history-${new Date().toISOString().slice(0, 10)}.csv`)
      toast.success('命令历史已导出')
    } catch (e) {
      toast.error(`导出失败：${getFriendlyErrorText(e)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* -- 过滤器栏 -- */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={instanceFilter} onValueChange={(v) => handleFilterChange({ instanceId: v === '__all__' ? '' : v })}>
          <SelectTrigger size="sm" className="w-[160px]">
            <SelectValue placeholder="全部实例" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部实例</SelectItem>
            {instances?.map((inst) => (
              <SelectItem key={inst.id} value={inst.id}>{inst.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={(v) => handleFilterChange({ source: v === '__all__' ? '' : v })}>
          <SelectTrigger size="sm" className="w-[120px]">
            <SelectValue placeholder="全部来源" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部来源</SelectItem>
            <SelectItem value="api">API</SelectItem>
            <SelectItem value="replay">回放</SelectItem>
            <SelectItem value="scheduled_task">定时任务</SelectItem>
          </SelectContent>
        </Select>

        {(instanceFilter || sourceFilter) && (
          <Button variant="ghost" size="sm" onClick={() => handleFilterChange({ instanceId: '', source: '' })} className="text-mcs-text-subtle hover:text-mcs-text-default">
            <X aria-hidden className="size-3.5" />
            重置
          </Button>
        )}

        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw aria-hidden className={cn(isFetching && 'animate-spin')} />
          刷新
        </Button>
        <Button variant="outline" size="sm" onClick={() => void handleExportCsv()} disabled={exporting}>
          {exporting
            ? <Loader2 aria-hidden className="animate-spin" />
            : <Download aria-hidden />}
          导出 CSV
        </Button>
        <span className="ml-auto text-mcs-xs text-mcs-text-subtle">共 {total} 条{(instanceFilter || sourceFilter) ? '（已过滤）' : ''}</span>
      </div>

      {/* -- 表格 -- */}
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-mcs-border-muted bg-mcs-bg-muted">
        <table className="w-full text-mcs-sm" style={{ tableLayout: 'auto' }}>
          <thead className="sticky top-0 bg-mcs-bg-hover">
            <tr className="text-left text-mcs-xs text-mcs-text-subtle">
              <th className="whitespace-nowrap px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">命令</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">结果</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">来源</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">耗时</th>
              <th className="px-3 py-2 text-right font-medium">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-mcs-border-muted">
            {isLoading && items.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-2"><Skeleton className="h-5 w-full" /><Skeleton className="mt-2 h-5 w-full" /><Skeleton className="mt-2 h-5 w-3/4" /></td></tr>
            )}
            {isError && items.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-mcs-error-fg">加载失败：{getFriendlyErrorText(error)}</td></tr>
            )}
            {!isLoading && !isError && items.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-mcs-text-subtle">{instanceFilter ? '无匹配的命令记录' : '暂无命令记录'}</td></tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-mcs-state-hover transition-colors">
                <td className="whitespace-nowrap px-3 py-2 text-mcs-xs text-mcs-text-muted font-mono">{formatTime(item.createdAt)}</td>
                <td className="max-w-[360px] truncate px-3 py-2 font-mono text-mcs-text-default">/{item.command}</td>
                <td className="px-3 py-2">
                  {item.success
                    ? <span className="inline-flex items-center rounded bg-mcs-success-bg-subtle px-1.5 py-0.5 text-mcs-xs text-mcs-success-fg">成功</span>
                    : <span className="inline-flex items-center rounded bg-mcs-error-bg-subtle px-1.5 py-0.5 text-mcs-xs text-mcs-error-fg">失败</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={cn(
                    'inline-flex items-center rounded px-1.5 py-0.5 text-mcs-xs',
                    item.source === 'replay'
                      ? 'bg-mcs-warning-bg-subtle text-mcs-warning-fg'
                      : 'bg-mcs-state-hover text-mcs-text-muted',
                  )}>
                    {formatCommandSource(item.source)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-mcs-xs text-mcs-text-subtle">
                  {item.durationMs != null ? `${item.durationMs}ms` : '--'}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`回放命令 ${item.command}`}
                    title="回放此命令"
                    onClick={() => setReplayTarget(item)}
                  >
                    <History aria-hidden className="size-3.5 text-mcs-text-subtle" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* -- 分页 -- */}
      {total > 0 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            <ChevronLeft aria-hidden />
          </Button>
          <span className="text-mcs-xs text-mcs-text-muted">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
            <ChevronRight aria-hidden />
          </Button>
          <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
            <SelectTrigger size="sm" className="w-[80px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>{size} 条/页</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* -- 回放确认（Tasteful Friction：非幂等命令重复生效风险显式提示） -- */}
      <ConfirmDialog
        open={replayTarget !== null}
        onOpenChange={(open) => { if (!open) setReplayTarget(null) }}
        title="回放命令"
        description={`将把下列命令原样重新发送到实例「${replayInstanceName}」`}
        confirmText="确认回放"
        loading={replaying}
        onConfirm={() => void handleReplay()}
        warning="注意：give / ban 等非幂等命令重复执行会再次生效，请确认时机合适"
      >
        <div className="rounded-md border border-mcs-border-muted bg-mcs-bg-subtle px-3 py-2 font-mono text-mcs-sm text-mcs-text-default break-all">
          /{replayTarget?.command ?? ''}
        </div>
      </ConfirmDialog>
    </div>
  )
}
