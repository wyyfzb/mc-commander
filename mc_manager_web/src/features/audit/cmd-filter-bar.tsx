/**
 * 命令历史 tab 筛选栏 —— 快捷时间范围/起止日期/导出入口
 * 纯受控组件：筛选状态与其 URL 持久化由 AuditPage 统一持有，本组件只回调
 */
import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DateTextInput } from '@/components/mcs/date-text-input'
import { useRadioGroup } from '@/hooks/use-radio-group'
import { QUICK_RANGES, type QuickRange } from './time-range'
import { AUDIT_EXPORT_MAX_ROWS } from './audit-export'

interface CmdFilterBarProps {
  activeQuickCmd: QuickRange | undefined
  applyQuickCmd: (q: QuickRange) => void
  cmdStart: string
  cmdEnd: string
  changeCmdDate: (which: 'start' | 'end', v: string) => void
  cmdHasTimeRange: boolean
  clearCmdTimeRange: () => void
  cmdExporting: boolean
  handleCmdExport: () => Promise<void>
}

export function CmdFilterBar({
  activeQuickCmd,
  applyQuickCmd,
  cmdStart,
  cmdEnd,
  changeCmdDate,
  cmdHasTimeRange,
  clearCmdTimeRange,
  cmdExporting,
  handleCmdExport,
}: CmdFilterBarProps) {
  // 快捷时间范围是单选组（可清空 → 无选中是合法态），语义与方向键由 hook 统一提供
  const quickGroup = useRadioGroup<string>({
    label: '快捷时间范围',
    value: activeQuickCmd?.key ?? null,
    values: QUICK_RANGES.map((q) => q.key),
    onChange: (key) => {
      const q = QUICK_RANGES.find((r) => r.key === key)
      if (q) applyQuickCmd(q)
    },
  })

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 时间筛选栏（issue 385）：样式与交互对齐审计日志 tab，倒置防护复用同一逻辑 */}
      <div className="flex items-center gap-1" {...quickGroup.groupProps}>
        {QUICK_RANGES.map((q, index) => {
          const active = activeQuickCmd?.key === q.key
          return (
            <Button
              key={q.key}
              size="sm"
              className="h-8"
              variant={active ? 'selected' : 'outline'}
              {...quickGroup.itemProps(index)}
              onClick={() => applyQuickCmd(q)}
            >
              {q.label}
            </Button>
          )
        })}
      </div>

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      {/* 极窄视口（320px）：两个 144px 日期输入 + 间隔共 312px 会超出行宽，故允许折行 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <DateTextInput
          value={cmdStart}
          onChange={(v) => changeCmdDate('start', v)}
          // 起止互禁：开始日期不得晚于已选的结束日期（对侧为空则该项不设界）
          max={cmdEnd}
          placeholder="开始日期 如 2026-09-01"
          ariaLabel="开始日期"
        />
        <span className="text-mcs-xs text-mcs-text-muted">至</span>
        <DateTextInput
          value={cmdEnd}
          onChange={(v) => changeCmdDate('end', v)}
          min={cmdStart}
          placeholder="结束日期"
          ariaLabel="结束日期"
        />
      </div>

      {cmdHasTimeRange && (
        <Button size="sm" variant="ghost" onClick={clearCmdTimeRange}>
          <X aria-hidden />
          清空时间
        </Button>
      )}

      <span className="h-5 w-px shrink-0 bg-mcs-border-muted" aria-hidden />

      <Button
        size="sm"
        variant="outline"
        className="h-8"
        onClick={() => void handleCmdExport()}
        disabled={cmdExporting}
        data-testid="cmd-export"
      >
        <Download aria-hidden />
        导出
      </Button>
      <span className="text-mcs-2xs text-mcs-text-muted">
        最多导出 {AUDIT_EXPORT_MAX_ROWS} 条（时间最新优先）
      </span>
    </div>
  )
}
