/**
 * 审计日志 tab 筛选栏 —— 操作类型/快捷时间范围/起止日期/排序/导出入口
 * 纯受控组件：筛选状态与其 URL 持久化由 AuditPage 统一持有，本组件只回调
 */
import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DateTextInput } from '@/components/mcs/date-text-input'
import { FilterSelect } from '@/components/mcs/filter-select'
import { QUICK_RANGES, type QuickRange } from './time-range'
import { actionFilterOptions } from './action-labels'
import { AUDIT_EXPORT_MAX_ROWS } from './audit-export'

interface AuditFilterBarProps {
  auditAction: string
  setAuditAction: (v: string) => void
  setAuditPage: (n: number) => void
  activeQuick: QuickRange | undefined
  applyQuick: (q: QuickRange) => void
  auditStart: string
  auditEnd: string
  changeDate: (which: 'start' | 'end', v: string) => void
  hasTimeRange: boolean
  clearTimeRange: () => void
  auditOrder: 'asc' | 'desc'
  setAuditOrder: (v: 'asc' | 'desc') => void
  exporting: boolean
  handleExport: () => Promise<void>
}

export function AuditFilterBar({
  auditAction,
  setAuditAction,
  setAuditPage,
  activeQuick,
  applyQuick,
  auditStart,
  auditEnd,
  changeDate,
  hasTimeRange,
  clearTimeRange,
  auditOrder,
  setAuditOrder,
  exporting,
  handleExport,
}: AuditFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect
        label="操作类型"
        value={auditAction}
        options={actionFilterOptions()}
        onChange={(v) => {
          setAuditAction(v)
          setAuditPage(1)
        }}
        className="w-44"
      />

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      <div className="flex items-center gap-1" role="group" aria-label="快捷时间范围">
        {QUICK_RANGES.map((q) => {
          const active = activeQuick?.key === q.key
          return (
            <Button
              key={q.key}
              size="sm"
              className="h-8"
              variant={active ? 'default' : 'outline'}
              aria-pressed={active}
              onClick={() => applyQuick(q)}
            >
              {q.label}
            </Button>
          )
        })}
      </div>

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      <div className="flex items-center gap-1.5">
        <DateTextInput
          value={auditStart}
          onChange={(v) => changeDate('start', v)}
          placeholder="开始日期 如 2026-09-01"
          ariaLabel="开始日期"
        />
        <span className="text-mcs-xs text-mcs-text-subtle">至</span>
        <DateTextInput
          value={auditEnd}
          onChange={(v) => changeDate('end', v)}
          placeholder="结束日期"
          ariaLabel="结束日期"
        />
      </div>

      {hasTimeRange && (
        <Button size="sm" variant="ghost" onClick={clearTimeRange}>
          <X aria-hidden />
          清空时间
        </Button>
      )}

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      <div className="flex items-center gap-1" role="group" aria-label="时间排序">
        <Button
          size="sm"
          className="h-8"
          variant={auditOrder === 'desc' ? 'default' : 'outline'}
          aria-pressed={auditOrder === 'desc'}
          onClick={() => setAuditOrder('desc')}
        >
          最新优先
        </Button>
        <Button
          size="sm"
          className="h-8"
          variant={auditOrder === 'asc' ? 'default' : 'outline'}
          aria-pressed={auditOrder === 'asc'}
          onClick={() => setAuditOrder('asc')}
        >
          最早优先
        </Button>
      </div>

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      <Button
        size="sm"
        variant="outline"
        className="h-8"
        onClick={() => void handleExport()}
        disabled={exporting}
        data-testid="audit-export"
      >
        <Download aria-hidden />
        导出
      </Button>
      <span className="text-mcs-2xs text-mcs-text-subtle">
        最多导出 {AUDIT_EXPORT_MAX_ROWS} 条（时间最新优先）
      </span>
    </div>
  )
}
