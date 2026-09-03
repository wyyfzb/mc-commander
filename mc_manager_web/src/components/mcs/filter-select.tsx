import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/**
 * FilterSelect —— 列表筛选下拉（可复用）
 * 触发器文案恒为「筛选类别：值」（未筛选值为「全部」），字段名常驻可见；
 * 筛选生效（值 ≠ 全部）时切换 accent 激活态（subtle 底 + accent 前景 + accent 边框）；
 * 「全部」项由组件按 allValue 统一注入（Radix 不允许空串 item value，
 * 内部用哨兵转换，对外契约仍是调用方的 allValue）
 */
export interface FilterOption {
  value: string
  label: string
}

interface FilterSelectProps {
  /** 筛选类别名（触发器文案前缀 + trigger aria-label） */
  label: string
  /** 当前值；等于 allValue 视为未筛选（显示「类别：全部」） */
  value: string
  /** 选项（可含「全部」项，组件会按 allValue 去重后统一注入） */
  options: ReadonlyArray<FilterOption>
  /** 「全部」选项对应的值（即未筛选值，默认 ''） */
  allValue?: string
  onChange: (value: string) => void
  className?: string
}

const ALL_ITEM_VALUE = '__filter_all__'

export function FilterSelect({
  label,
  value,
  options,
  allValue = '',
  onChange,
  className,
}: FilterSelectProps) {
  const active = value !== allValue
  const mergedOptions = options.filter((option) => option.value !== allValue)
  const selectedLabel = active
    ? (mergedOptions.find((option) => option.value === value)?.label ?? value)
    : '全部'
  return (
    <Select
      value={active ? value : ALL_ITEM_VALUE}
      onValueChange={(v) => onChange(v === ALL_ITEM_VALUE ? allValue : v)}
    >
      <SelectTrigger
        aria-label={label}
        className={cn(
          'w-40',
          active && 'border-mcs-accent-border bg-mcs-accent-bg-subtle text-mcs-accent-fg',
          className,
        )}
      >
        <span className="truncate">
          {label}：{selectedLabel}
        </span>
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={4}>
        <SelectItem value={ALL_ITEM_VALUE}>全部</SelectItem>
        {mergedOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
