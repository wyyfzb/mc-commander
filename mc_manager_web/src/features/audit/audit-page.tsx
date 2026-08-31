/**
 * AuditPage —— 审计日志 & 命令历史
 * 双 Tab：审计日志（操作记录）/ 命令历史（命令执行记录）
 * TanStack Query 数据获取：isLoading/isFetching/isError 内建，
 * keepPreviousData 翻页不闪烁，过滤器变化经 query key 自动重获取
 */
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/mcs/status-pill'
import { DataTableShell } from '@/components/mcs/data-table-shell'
import { useAuditLogs, useCommandHistory } from '@/api/queries'
import type { AuditLogItem, CommandHistoryItem } from '@/api/types'

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

const AUDIT_COLUMNS = 4
const CMD_COLUMNS = 5

/** 审计日志表头 */
function AuditHeader() {
  return (
    <thead className="sticky top-0 bg-mcs-bg-muted">
      <tr className="border-b border-mcs-border-muted text-left">
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">时间</th>
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">操作</th>
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">目标</th>
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">详情</th>
      </tr>
    </thead>
  )
}

/** 审计日志表体 */
function AuditBody({ logs }: { logs: AuditLogItem[] }) {
  return (
    <tbody>
      {logs.map((log) => (
        <tr key={log.id} className="border-b border-mcs-border-muted last:border-b-0">
          <td className="whitespace-nowrap px-3 py-2 text-mcs-text-default font-mono text-mcs-xs">{formatTime(log.createdAt)}</td>
          <td className="px-3 py-2">
            <StatusPill variant="outline">
              {getActionLabel(log.action)}
            </StatusPill>
          </td>
          <td className="px-3 py-2 text-mcs-text-default">{log.targetType ? `${log.targetType}${log.targetId ? `: ${log.targetId}` : ''}` : '-'}</td>
          <td className="max-w-xs truncate px-3 py-2 text-mcs-text-subtle">
            {log.detail ? (typeof log.detail === 'object' ? JSON.stringify(log.detail) : String(log.detail)) : '-'}
          </td>
        </tr>
      ))}
    </tbody>
  )
}

/** 命令历史表头 */
function CmdHeader() {
  return (
    <thead className="sticky top-0 bg-mcs-bg-muted">
      <tr className="border-b border-mcs-border-muted text-left">
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">时间</th>
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">命令</th>
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">结果</th>
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">来源</th>
        <th className="px-3 py-2 font-medium text-mcs-text-subtle">耗时</th>
      </tr>
    </thead>
  )
}

/** 命令历史表体 */
function CmdBody({ cmds }: { cmds: CommandHistoryItem[] }) {
  return (
    <tbody>
      {cmds.map((cmd) => (
        <tr key={cmd.id} className="border-b border-mcs-border-muted last:border-b-0">
          <td className="whitespace-nowrap px-3 py-2 text-mcs-text-default font-mono text-mcs-xs">{formatTime(cmd.createdAt)}</td>
          <td className="px-3 py-2 font-mono text-mcs-text-default">{cmd.command}</td>
          <td className="px-3 py-2">
            <StatusPill tone={cmd.success ? 'success' : 'error'}>
              {cmd.success ? '成功' : '失败'}
            </StatusPill>
          </td>
          <td className="px-3 py-2 text-mcs-text-subtle">{cmd.source}</td>
          <td className="px-3 py-2 text-mcs-text-subtle font-mono text-mcs-xs">{formatDuration(cmd.durationMs)}</td>
        </tr>
      ))}
    </tbody>
  )
}

export function AuditPage() {
  const [tab, setTab] = useState('audit')

  const [auditPage, setAuditPage] = useState(1)
  const [auditAction, setAuditAction] = useState('')
  const auditQuery = useAuditLogs({ page: auditPage, pageSize: 20, action: auditAction || undefined })

  const [cmdPage, setCmdPage] = useState(1)
  const cmdQuery = useCommandHistory({ page: cmdPage, pageSize: 20 })

  const refreshing = auditQuery.isFetching || cmdQuery.isFetching

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
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

        <TabsContent value="audit" className="min-h-0 flex-1 flex flex-col gap-3 mt-3">
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

          <DataTableShell
            columns={AUDIT_COLUMNS}
            isLoading={auditQuery.isLoading}
            error={auditQuery.isError ? auditQuery.error : undefined}
            isEmpty={!auditQuery.isLoading && !auditQuery.isError && auditQuery.data?.data.length === 0}
            emptyText="暂无记录"
            skeletonWidths={['w-20', 'w-14', 'w-24', 'w-36']}
            header={<AuditHeader />}
            pagination={auditQuery.data?.pagination ? {
              page: auditPage,
              totalPages: auditQuery.data.pagination.totalPages,
              totalItems: auditQuery.data.pagination.total,
              onPageChange: setAuditPage,
              variant: 'prev-next',
              disabled: auditQuery.isFetching,
            } : undefined}
          >
            <AuditBody logs={auditQuery.data?.data ?? []} />
          </DataTableShell>
        </TabsContent>

        <TabsContent value="commands" className="min-h-0 flex-1 flex flex-col gap-3 mt-3">
          <DataTableShell
            columns={CMD_COLUMNS}
            isLoading={cmdQuery.isLoading}
            error={cmdQuery.isError ? cmdQuery.error : undefined}
            isEmpty={!cmdQuery.isLoading && !cmdQuery.isError && cmdQuery.data?.data.length === 0}
            emptyText="暂无记录"
            skeletonWidths={['w-20', 'w-40', 'w-10', 'w-14', 'w-12']}
            header={<CmdHeader />}
            pagination={cmdQuery.data?.pagination ? {
              page: cmdPage,
              totalPages: cmdQuery.data.pagination.totalPages,
              totalItems: cmdQuery.data.pagination.total,
              onPageChange: setCmdPage,
              variant: 'prev-next',
              disabled: cmdQuery.isFetching,
            } : undefined}
          >
            <CmdBody cmds={cmdQuery.data?.data ?? []} />
          </DataTableShell>
        </TabsContent>
      </Tabs>
    </div>
  )
}
