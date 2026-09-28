import type { ReactNode } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { TONE_SELECTED_CLASSES } from '@/components/mcs/tone'

/**
 * FilterSelect —— 列表筛选下拉（可复用）
 * 触发器文案恒为「筛选类别：值」（未筛选值为「全部」），字段名常驻可见；
 * 筛选生效（值 ≠ 全部）时切换 accent 激活态（subtle 底 + accent 前景 + accent 边框）；
 * 「全部」项由组件按 allValue 统一注入（Radix 不允许空串 item value，
 * 内部用哨兵转换，对外契约仍是调用方的 allValue）
 * 分组：option.group 非空时按 group 名聚簇渲染（SelectGroup/SelectLabel），
 * 组序按选项首次出现顺序；不传 group 保持平铺（兼容既有调用方）
 */
export interface FilterOption {
  value: string
  label: string
  /** 分组标题（可选）：同组选项聚簇渲染，组序按首次出现顺序 */
  group?: string
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

/** 选项渲染：带 group 时按组聚簇（SelectGroup+SelectLabel），否则平铺（兼容旧调用方） */
function renderGroupedOptions(options: ReadonlyArray<FilterOption>): ReactNode {
  const grouped = options.some((o) => o.group)
  if (!grouped) {
    return options.map((option) => (
      <SelectItem key={option.value} value={option.value}>
        {option.label}
      </SelectItem>
    ))
  }
  const nodes: ReactNode[] = []
  // 组序按选项首次出现顺序；无 group 的选项平铺在末尾
  const groupOrder = [...new Set(options.map((o) => o.group).filter(Boolean) as string[])]
  for (const group of groupOrder) {
    const items = options.filter((o) => o.group === group)
    nodes.push(
      <SelectGroup key={group}>
        <SelectLabel>{group}</SelectLabel>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectGroup>,
    )
  }
  for (const option of options) {
    if (!option.group) {
      nodes.push(
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>,
      )
    }
  }
  return nodes
}

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
          // 激活态边界用强档：控件边界须 ≥3:1，弱档 accent-border 亮色仅 1.10:1
          active && TONE_SELECTED_CLASSES,
          className,
        )}
      >
        <span className="truncate">
          {label}：{selectedLabel}
        </span>
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={4}>
        <SelectItem value={ALL_ITEM_VALUE}>全部</SelectItem>
        {renderGroupedOptions(mergedOptions)}
      </SelectContent>
    </Select>
  )
}
