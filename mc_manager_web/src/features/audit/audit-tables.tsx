/**
 * 审计日志与命令历史两 tab 的表头/表体渲染
 * （时间/详情列格式化经 audit-format 收口，操作列标签经 action-labels 收口）
 */
import { StatusPill } from '@/components/mcs/status-pill'
import { InfoHint } from '@/components/mcs/info-hint'
import { formatDurationMs } from '@/lib/format'
import type { AuditLogItem, CommandHistoryItem } from '@/api/types'
import { getActionLabel } from './action-labels'
import { formatTime, formatAuditDetail } from './audit-format'

export const AUDIT_COLUMNS = 4
export const CMD_COLUMNS = 5

/** 审计日志表头 */
export function AuditHeader() {
  return (
    <thead className="sticky top-0 bg-mcs-bg-muted">
      <tr className="border-b border-mcs-border-muted text-left">
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          时间
        </th>
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          操作
        </th>
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          目标
        </th>
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          详情
        </th>
      </tr>
    </thead>
  )
}

/** 审计日志表体 */
export function AuditBody({ logs }: { logs: AuditLogItem[] }) {
  return (
    <tbody>
      {logs.map((log) => (
        <tr key={log.id} className="border-b border-mcs-border-muted last:border-b-0">
          <td className="whitespace-nowrap px-3 py-2 text-mcs-text-default font-mono text-mcs-xs">
            {formatTime(log.createdAt)}
          </td>
          <td className="px-3 py-2 text-mcs-text-default">{getActionLabel(log.action)}</td>
          <td className="px-3 py-2 text-mcs-text-default">
            {log.targetType ? `${log.targetType}${log.targetId ? `: ${log.targetId}` : ''}` : '-'}
          </td>
          <td
            className="max-w-xs truncate px-3 py-2 text-mcs-text-muted"
            title={typeof log.detail === 'object' ? JSON.stringify(log.detail) : undefined}
          >
            {formatAuditDetail(log.detail)}
          </td>
        </tr>
      ))}
    </tbody>
  )
}

/** 命令历史表头 */
export function CmdHeader() {
  return (
    <thead className="sticky top-0 bg-mcs-bg-muted">
      <tr className="border-b border-mcs-border-muted text-left">
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          时间
        </th>
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          命令
        </th>
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          结果
        </th>
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          来源
        </th>
        <th scope="col" className="px-3 py-2 font-medium text-mcs-text-muted">
          耗时
        </th>
      </tr>
    </thead>
  )
}

/** 命令历史表体 */
export function CmdBody({ cmds }: { cmds: CommandHistoryItem[] }) {
  return (
    <tbody>
      {cmds.map((cmd) => (
        <tr key={cmd.id} className="border-b border-mcs-border-muted last:border-b-0">
          <td className="whitespace-nowrap px-3 py-2 text-mcs-text-default font-mono text-mcs-xs">
            {formatTime(cmd.createdAt)}
          </td>
          <td className="px-3 py-2 font-mono text-mcs-text-default">{cmd.command}</td>
          <td className="px-3 py-2">
            {cmd.success || !cmd.response ? (
              <StatusPill tone={cmd.success ? 'success' : 'error'}>
                {cmd.success ? '成功' : '失败'}
              </StatusPill>
            ) : (
              /* 失败行：response 携带原因时给出解释（与任务列表失败行同模式）。
                 走 InfoHint inline 而非 Tooltip：解释必须键盘与触屏都拿得到 */
              <InfoHint
                variant="inline"
                label="失败原因"
                term={<StatusPill tone="error">失败</StatusPill>}
              >
                <p className="text-mcs-xs font-medium text-mcs-error-fg">失败原因</p>
                {/* 失败原因可能为无空格长串（压缩 JSON/路径），break-all 防溢出浮层框 */}
                <p className="mt-1 text-xs break-all text-mcs-text-default">{cmd.response}</p>
              </InfoHint>
            )}
          </td>
          <td className="px-3 py-2 text-mcs-text-muted">{cmd.source}</td>
          <td className="px-3 py-2 text-mcs-text-muted font-mono text-mcs-xs">
            {formatDurationMs(cmd.durationMs)}
          </td>
        </tr>
      ))}
    </tbody>
  )
}
