import { useCallback, useRef, type KeyboardEvent, type RefCallback } from 'react'
import { nextRadioIndex } from '@/lib/radio-group'

/**
 * 自定义单选组（`role="radiogroup"` + `role="radio"`）的接线层。
 * 键盘模型本体在 lib/radio-group.ts（纯函数、可单测），这里只负责接到 DOM：
 * - roving tabindex：组内只有选中项可 Tab 进入；无选中（或值不在清单内）时落首项——
 *   停靠点不能没有，但也不谎报选中
 * - 方向键/Home/End：移动即选中、焦点跟随（ARIA APG radio group 语义）
 * - 与单选组无关的键一律放行（Tab 不能被吞，否则键盘用户被困在组里）
 *
 * 用法：`<div {...groupProps}>` 内每个可选项 `<button {...itemProps(i)} />`；
 * Chip 也支持（其 props 已含这三项 radio 语义）。
 */
export interface RadioGroupItemProps {
  role: 'radio'
  'aria-checked': boolean
  tabIndex: number
  ref: RefCallback<HTMLButtonElement>
}

interface UseRadioGroupOptions<T> {
  /** 组的可访问名（读屏播报「<名>，单选组」） */
  label: string
  /** 当前选中值；null 表示无选中（合法状态，如可清空的快捷筛选） */
  value: T | null
  values: readonly T[]
  onChange: (value: T) => void
}

export function useRadioGroup<T>({ label, value, values, onChange }: UseRadioGroupOptions<T>) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const selectedIndex = values.findIndex((v) => v === value)
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const next = nextRadioIndex(e.key, activeIndex, values.length)
      if (next === null) return
      e.preventDefault()
      // nextRadioIndex 已保证落点在 [0, values.length)（空组返回 null，上面已拦）
      onChange(values[next] as T)
      itemRefs.current[next]?.focus()
    },
    [activeIndex, values, onChange],
  )

  return {
    groupProps: { role: 'radiogroup' as const, 'aria-label': label, onKeyDown },
    itemProps: (index: number): RadioGroupItemProps => ({
      role: 'radio',
      'aria-checked': values[index] === value,
      tabIndex: index === activeIndex ? 0 : -1,
      ref: (el) => {
        itemRefs.current[index] = el
      },
    }),
  }
}
