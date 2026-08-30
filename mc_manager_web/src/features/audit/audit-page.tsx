/**
 * AuditPage —— 审计日志 & 命令历史
 * 双 Tab：审计日志（操作记录）/ 命令历史（命令执行记录）
 * TanStack Query 数据获取（轮次 chore-30 方向）：isLoading/isFetching/isError 内建，
 * keepPreviousData 翻页不闪烁，过滤器变化经 query key 自动重获取
 */
import { useState } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuditLogs, useCommandHistory } from '@/api/queries'
import { getFriendlyErrorText } from '@/api/errors'
import type { Pagination } from '@/api/types'

const ACTION_LABELS: Record<string, string> = {
  INSTANCE_START: '启动实例',
  INSTANCE_STOP: '停止实例',
  INSTANCE_RESTART: '重启实例',
  INSTANCE_DELETE: '删除实例',
  CONFIG_CHANGE: '配置修改',
  BACKUP_CREATE: '创建备份',
  BACKUP_RESTORE: '恢复备份',
  BACKUP_DELETE: '删除备份',
  PLAYER_OP: '授权管理员',
  PLAYER_DEOP: '撤销管理员',
  PLAYER_KICK: '踢出玩家',
  PLAYER_BAN: '封禁玩家',
  PLAYER_PARDON: '解封玩家',
  PLAYER_WHITELIST: '白名单操作',
  TASK_CREATE: '创建任务',
  TASK_UPDATE: '更新任务',
  TASK_DELETE: '删除任务',
  TASK_EXECUTE: '执行任务',
  KEY_ROTATE: '密钥轮换',
}

function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return iso
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 表格内错误行（getFriendlyErrorText 转译） */
function ErrorRow({ colSpan, error }: { colSpan: number; error: unknown }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center">
        <div className="flex flex-col items-center gap-2">
          <AlertTriangle aria-hidden className="h-5 w-5 text-mcs-error-fg" />
          <span className="text-mcs-sm text-mcs-error-fg">加载失败：{getFriendlyErrorText(error)}</span>
        </div>
      </td>
    </tr>
  )
}

/** 分页条（两 Tab 共用；isFetching 期间禁用翻页避免竞态） */
function PaginationBar({
  page,
  pagination,
  isFetching,
  onPage,
}: {
  page: number
  pagination: Pagination | undefined
  isFetching: boolean
  onPage: (page: number) => void
}) {
  const totalPages = pagination?.totalPages ?? null
  const total = pagination?.total ?? null
  return (
    <div className="flex items-center justify-between">
      <span className="text-mcs-xs text-mcs-text-subtle">
        {total != null && totalPages != null
          ? <>第 {page} / {totalPages} 页 · 共 {total} 条</>
          : <>第 {page} 页</>}
      </span>
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching || (totalPages != null && page >= totalPages)}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  )
}

export function AuditPage() {
  const [tab, setTab] = useState('audit')

  // 审计日志查询（action 变化自动回第 1 页由过滤器 onChange 保证）
  const [auditPage, setAuditPage] = useState(1)
  const [auditAction, setAuditAction] = useState('')
  const auditQuery = useAuditLogs({ page: auditPage, pageSize: 20, action: auditAction || undefined })

  // 命令历史查询
  const [cmdPage, setCmdPage] = useState(1)
  const cmdQuery = useCommandHistory({ page: cmdPage, pageSize: 20 })

  const refreshing = auditQuery.isFetching || cmdQuery.isFetching

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      {/* 页面头 */}
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-mcs-xl font-semibold text-mcs-text-default">审计</h2>
          <p className="text-mcs-xs text-mcs-text-subtle">操作日志与命令执行记录</p>
        </div>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (tab === 'audit') auditQuery.refetch()
              else cmdQuery.refetch()
            }}
            disabled={refreshing}
          >
            <RefreshCw aria-hidden className={refreshing ? 'animate-spin' : undefined} />
            刷新
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 flex flex-col">
        <TabsList className="w-fit">
          <TabsTrigger value="audit">审计日志</TabsTrigger>
          <TabsTrigger value="commands">命令历史</TabsTrigger>
        </TabsList>

        {/* ── 审计日志 Tab ── */}
        <TabsContent value="audit" className="min-h-0 flex-1 flex flex-col gap-3 mt-3">
          {/* 过滤栏 */}
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-muted px-2 text-mcs-sm text-mcs-text-default"
              value={auditAction}
              onChange={(e) => { setAuditAction(e.target.value); setAuditPage(1) }}
              aria-label="按操作类型过滤"
            >
              <option value="">全部操作</option>
              {Object.entries(ACTION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>

          {/* 表格 */}
          <div className="min-h-0 flex-1 overflow-auto rounded-mcs-md border border-mcs-border-muted">
            <table className="w-full text-mcs-sm">
              <thead className="sticky top-0 bg-mcs-bg-muted">
                <tr className="border-b border-mcs-border-muted text-left">
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">时间</th>
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">操作</th>
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">目标</th>
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">详情</th>
                </tr>
              </thead>
              <tbody>
                {auditQuery.isError && <ErrorRow colSpan={4} error={auditQuery.error} />}
                {!auditQuery.isError && auditQuery.isLoading &&
                  Array.from({ length: 5 }, (_, i) => (
                    <tr key={`audit-skeleton-${i}`} className="border-b border-mcs-border-muted last:border-b-0" aria-hidden>
                      <td className="px-3 py-2"><Skeleton className="h-3.5 w-20" /></td>
                      <td className="px-3 py-2"><Skeleton className="h-5 w-14" /></td>
                      <td className="px-3 py-2"><Skeleton className="h-3.5 w-24" /></td>
                      <td className="px-3 py-2"><Skeleton className="h-3.5 w-36" /></td>
                    </tr>
                  ))
                }
                {!auditQuery.isError && !auditQuery.isLoading && auditQuery.data?.data.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-8 text-center text-mcs-text-subtle">暂无记录</td></tr>
                )}
                {auditQuery.data?.data.map((log: import('@/api/types').AuditLogItem) => (
                  <tr key={log.id} className="border-b border-mcs-border-muted last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-2 text-mcs-text-default font-mono text-mcs-xs">{formatTime(log.createdAt)}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className="border-mcs-border-muted text-mcs-text-default">
                        {getActionLabel(log.action)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-mcs-text-default">{log.targetType ? `${log.targetType}${log.targetId ? `: ${log.targetId}` : ''}` : '-'}</td>
                    <td className="max-w-xs truncate px-3 py-2 text-mcs-text-subtle">
                      {log.detail ? (typeof log.detail === 'object' ? JSON.stringify(log.detail) : String(log.detail)) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <PaginationBar
            page={auditPage}
            pagination={auditQuery.data?.pagination}
            isFetching={auditQuery.isFetching}
            onPage={setAuditPage}
          />
        </TabsContent>

        {/* ── 命令历史 Tab ── */}
        <TabsContent value="commands" className="min-h-0 flex-1 flex flex-col gap-3 mt-3">
          <div className="min-h-0 flex-1 overflow-auto rounded-mcs-md border border-mcs-border-muted">
            <table className="w-full text-mcs-sm">
              <thead className="sticky top-0 bg-mcs-bg-muted">
                <tr className="border-b border-mcs-border-muted text-left">
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">时间</th>
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">命令</th>
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">结果</th>
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">来源</th>
                  <th className="px-3 py-2 font-medium text-mcs-text-subtle">耗时</th>
                </tr>
              </thead>
              <tbody>
                {cmdQuery.isError && <ErrorRow colSpan={5} error={cmdQuery.error} />}
                {!cmdQuery.isError && cmdQuery.isLoading &&
                  Array.from({ length: 5 }, (_, i) => (
                    <tr key={`cmd-skeleton-${i}`} className="border-b border-mcs-border-muted last:border-b-0" aria-hidden>
                      <td className="px-3 py-2"><Skeleton className="h-3.5 w-20" /></td>
                      <td className="px-3 py-2"><Skeleton className="h-3.5 w-40" /></td>
                      <td className="px-3 py-2"><Skeleton className="h-5 w-10" /></td>
                      <td className="px-3 py-2"><Skeleton className="h-3.5 w-14" /></td>
                      <td className="px-3 py-2"><Skeleton className="h-3.5 w-12" /></td>
                    </tr>
                  ))
                }
                {!cmdQuery.isError && !cmdQuery.isLoading && cmdQuery.data?.data.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-mcs-text-subtle">暂无记录</td></tr>
                )}
                {cmdQuery.data?.data.map((cmd: import('@/api/types').CommandHistoryItem) => (
                  <tr key={cmd.id} className="border-b border-mcs-border-muted last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-2 text-mcs-text-default font-mono text-mcs-xs">{formatTime(cmd.createdAt)}</td>
                    <td className="px-3 py-2 font-mono text-mcs-text-default">{cmd.command}</td>
                    <td className="px-3 py-2">
                      <Badge variant={cmd.success ? 'outline' : 'destructive'} className={cmd.success ? 'border-mcs-border-muted text-mcs-text-default' : ''}>
                        {cmd.success ? '成功' : '失败'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-mcs-text-subtle">{cmd.source}</td>
                    <td className="px-3 py-2 text-mcs-text-subtle font-mono text-mcs-xs">{formatDuration(cmd.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <PaginationBar
            page={cmdPage}
            pagination={cmdQuery.data?.pagination}
            isFetching={cmdQuery.isFetching}
            onPage={setCmdPage}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
