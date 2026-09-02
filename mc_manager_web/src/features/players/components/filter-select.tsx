import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/**
 * FilterSelect —— 列表筛选下拉（可复用）
 * 统一三态呈现：未筛选显示字段名占位；筛选生效显示值 + accent 边框激活态；
 * 「全部」项由组件按 allValue 统一注入（消除各处空值语义漂移——Radix 不允许空串
 * item value，故内部用哨兵转换，对外契约仍是调用方的 allValue）
 */
export interface FilterOption {
  value: string
  label: string
}

interface FilterSelectProps {
  /** 无障碍名（trigger aria-label） */
  label: string
  /** 未筛选时框内显示的字段名 */
  placeholder: string
  /** 当前值；等于 allValue 视为未筛选 */
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
  placeholder,
  value,
  options,
  allValue = '',
  onChange,
  className,
}: FilterSelectProps) {
  const active = value !== allValue
  const mergedOptions = options.filter((option) => option.value !== allValue)
  return (
    <Select
      value={value === allValue ? ALL_ITEM_VALUE : value}
      onValueChange={(v) => onChange(v === ALL_ITEM_VALUE ? allValue : v)}
    >
      <SelectTrigger
        aria-label={label}
        className={cn('w-28', active && 'border-mcs-accent-border text-mcs-text-default', className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
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
