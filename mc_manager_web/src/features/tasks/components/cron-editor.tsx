/**
 * CronEditor —— Cron 表达式可视化编辑器
 * - 四字段（分/时/日/月）Select，选项来自 CRON_FIELD_OPTIONS
 * - 周字段 chip 多选（周一~周日），与文本输入双向联动
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
import { Chip } from '@/components/mcs/chip'
import {
  CRON_FIELD_OPTIONS,
  WEEKDAY_CHIPS,
  WEEKDAY_COMBOS,
  parseWeekdayField,
  serializeWeekdayField,
  parseCronFields,
  type CronFieldOption,
} from '@/lib/mc-cron'

/** 四字段顺序与中文标签（分/时/日/月）—— 周字段用 chip 替代 */
const SELECT_FIELDS: Array<{ key: 'minute' | 'hour' | 'day' | 'month'; label: string }> = [
  { key: 'minute', label: '分' },
  { key: 'hour', label: '时' },
  { key: 'day', label: '日' },
  { key: 'month', label: '月' },
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

  /** 周字段当前选中集合（解析轻量，无需 memo） */
  const selectedWeekdays = parseWeekdayField(parts[4] ?? '*')

  /** 切换单个周 chip */
  const toggleWeekday = (day: number) => {
    const next = new Set(selectedWeekdays)
    if (next.has(day)) {
      next.delete(day)
    } else {
      next.add(day)
    }
    updateField(4, serializeWeekdayField(next))
  }

  /** 应用快捷组合（工作日/周末） */
  const applyWeekdayCombo = (comboValue: string) => {
    updateField(4, comboValue)
  }

  return (
    <div className="rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-2">
      <p className="text-mcs-xs font-medium text-mcs-text-subtle">可视化编辑</p>
      {/* 四字段 Select（分/时/日/月） */}
      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {SELECT_FIELDS.map((field, idx) => {
          const options = CRON_FIELD_OPTIONS[field.key]
          const current = parts[idx] ?? '*'
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
      {/* 周字段 chip 多选 */}
      <div className="mt-2">
        <p className="mb-1.5 text-mcs-2xs text-mcs-text-subtle">周</p>
        <div className="flex flex-wrap gap-1">
          {WEEKDAY_CHIPS.map((chip) => (
            <Chip
              key={chip.value}
              onClick={() => toggleWeekday(chip.value)}
              selected={selectedWeekdays.has(chip.value)}
              ariaLabel={`周${chip.label}`}
            >
              {chip.label}
            </Chip>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {WEEKDAY_COMBOS.map((combo) => {
            const comboSet = parseWeekdayField(combo.value)
            const active = comboSet.size > 0 &&
              comboSet.size === selectedWeekdays.size &&
              [...comboSet].every((v) => selectedWeekdays.has(v))
            return (
              <Chip
                key={combo.value}
                tone="muted"
                onClick={() => applyWeekdayCombo(combo.value)}
                selected={active}
                ariaLabel={combo.label}
              >
                {combo.label}
              </Chip>
            )
          })}
        </div>
      </div>
    </div>
  )
}
