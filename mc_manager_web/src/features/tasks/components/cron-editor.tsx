/**
 * CronEditor —— Cron 表达式可视化编辑器
 * - 五字段（分/时/日/月/周）Select，选项来自 CRON_FIELD_OPTIONS
 * - 当前字段值不在预设时下拉顶部追加「自定义: xxx」项保持显示
 * - 选择后回写完整表达式（parseCronFields 不足 5 字段按全 * 处理），与文本输入双向联动
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CRON_FIELD_OPTIONS, parseCronFields, type CronFieldOption } from '@/lib/mc-cron'

/** 五字段顺序与中文标签（分/时/日/月/周） */
const FIELD_LABELS: Array<{ key: keyof typeof CRON_FIELD_OPTIONS; label: string }> = [
  { key: 'minute', label: '分' },
  { key: 'hour', label: '时' },
  { key: 'day', label: '日' },
  { key: 'month', label: '月' },
  { key: 'weekday', label: '周' },
]

export function CronEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  /** 不足 5 字段按全 * 处理 */
  const parts = parseCronFields(value) ?? ['*', '*', '*', '*', '*']

  /** 单字段改动 → 重组完整表达式回写 */
  const updateField = (idx: number, fieldValue: string) => {
    const next = [...parts]
    next[idx] = fieldValue
    onChange(next.join(' '))
  }

  return (
    <div className="rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-2">
      <p className="text-mcs-xs font-medium text-mcs-text-subtle">可视化编辑</p>
      <div className="mt-1.5 grid grid-cols-5 gap-1.5">
        {FIELD_LABELS.map((field, idx) => {
          const options = CRON_FIELD_OPTIONS[field.key]
          const current = parts[idx] ?? '*'
          // 当前值不在预设 → 顶部追加「自定义: xxx」项
          const matched = options.some((o) => o.value === current)
          const items: CronFieldOption[] = matched
            ? options
            : [{ label: `自定义: ${current}`, value: current }, ...options]
          return (
            <div key={field.key} className="min-w-0">
              <p className="mb-1 text-mcs-2xs text-mcs-text-subtle">{field.label}</p>
              <Select value={current} onValueChange={(v) => updateField(idx, v)}>
                <SelectTrigger size="sm" aria-label={field.label} className="w-full px-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </div>
    </div>
  )
}
