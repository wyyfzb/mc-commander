/**
 * DatePickerCalendar —— 月历面板（DateTextInput 的日历弹层内容）
 *
 * 无障碍按 W3C ARIA APG date picker 模式落地：grid/row/columnheader/gridcell 结构、
 * 方向键逐日、PageUp/PageDown 逐月、Home/End 到周首末、roving tabindex 单点可达；
 * 打开时焦点落到当前值（无值落到今天），关闭由 Radix Popover 交还触发器。
 * 日期运算全部下沉 lib/mc-calendar，本组件只管渲染与键盘。
 *
 * 可选区间（min/max，含端点）：界外日禁选（disabled）、键盘落点先夹再走、整月无选中日时
 * 禁掉翻月、今天在界外则「今天」按钮禁用。上一级用它做「起止互禁」这类成对约束。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/mcs/icon-button'
import { cn } from '@/lib/utils'
import {
  WEEKDAY_LABELS,
  addDays,
  addMonths,
  clampIsoDate,
  dayLabel,
  dayOfMonth,
  endOfWeek,
  isIsoInRange,
  isSameMonth,
  monthGrid,
  monthLabel,
  parseIsoDate,
  startOfWeek,
  todayIso,
} from '@/lib/mc-calendar'

interface DatePickerCalendarProps {
  /** 已提交值（'' 或 yyyy-MM-dd） */
  value: string
  /** 可选下界（含）；'' 或省略表示不设界 */
  min?: string
  /** 可选上界（含）；'' 或省略表示不设界 */
  max?: string
  onSelect: (iso: string) => void
  onClear: () => void
}

export function DatePickerCalendar({ value, min, max, onSelect, onClear }: DatePickerCalendarProps) {
  const monthLabelId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  // 落点也必须夹在界内：当前值可能落在后来收窄的区间外（父级先选了值再改约束），
  // 那时 roving tabindex 会指向禁选格
  const [focusDate, setFocusDate] = useState(() =>
    clampIsoDate(parseIsoDate(value) ? value : todayIso(), min, max),
  )
  const days = monthGrid(focusDate)
  const today = todayIso()
  const inRange = (iso: string) => isIsoInRange(iso, min, max)
  /** 目标月**自己**的界内日（不含相邻月补位日：翻月看的是那个月，补位日属相邻月的事） */
  const ownSelectableDays = (month: string) =>
    monthGrid(month).filter((iso) => isSameMonth(iso, month) && inRange(iso))

  /**
   * 翻月：视图进目标月，落点取该月内离「同日」最近的界内日。
   * 不能直接 `setFocusDate(addMonths(...))` —— 落点可能越界，而 roving tabindex 指到
   * 禁选格时 .focus() 无效：焦点留在翻月按钮上（它在 grid 之外），网格随即失去 tab 停靠点
   * 与方向键处理，键盘用户只能关掉重开。目标月没有界内日时不动（与翻月按钮的禁用判定同一口径）。
   */
  function pageMonth(delta: number) {
    const shifted = addMonths(focusDate, delta)
    const own = ownSelectableDays(shifted)
    if (own.length === 0) return
    const anchor = dayOfMonth(shifted)
    setFocusDate(
      own.reduce((best, iso) =>
        Math.abs(dayOfMonth(iso) - anchor) < Math.abs(dayOfMonth(best) - anchor) ? iso : best,
      ),
    )
  }

  // roving tabindex 的落点：打开时落焦当前值/今天，键盘移动后跟随
  useEffect(() => {
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)
      ?.focus()
  }, [focusDate])

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    let next: string
    switch (event.key) {
      case 'ArrowLeft':
        next = addDays(focusDate, -1)
        break
      case 'ArrowRight':
        next = addDays(focusDate, 1)
        break
      case 'ArrowUp':
        next = addDays(focusDate, -7)
        break
      case 'ArrowDown':
        next = addDays(focusDate, 7)
        break
      case 'PageUp':
        event.preventDefault()
        pageMonth(-1)
        return
      case 'PageDown':
        event.preventDefault()
        pageMonth(1)
        return
      case 'Home':
        next = startOfWeek(focusDate)
        break
      case 'End':
        next = endOfWeek(focusDate)
        break
      default:
        return
    }
    event.preventDefault()
    setFocusDate(clampIsoDate(next, min, max))
  }

  return (
    <div className="w-56">
      <div className="flex items-center justify-between gap-1">
        <IconButton
          size="icon-xs"
          aria-label="上个月"
          disabled={ownSelectableDays(addMonths(focusDate, -1)).length === 0}
          onClick={() => pageMonth(-1)}
        >
          <ChevronLeft aria-hidden />
        </IconButton>
        <div
          id={monthLabelId}
          aria-live="polite"
          aria-atomic="true"
          className="text-mcs-xs font-medium text-mcs-text-default"
        >
          {monthLabel(focusDate)}
        </div>
        <IconButton
          size="icon-xs"
          aria-label="下个月"
          disabled={ownSelectableDays(addMonths(focusDate, 1)).length === 0}
          onClick={() => pageMonth(1)}
        >
          <ChevronRight aria-hidden />
        </IconButton>
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-labelledby={monthLabelId}
        onKeyDown={handleKeyDown}
        className="mt-1 flex flex-col gap-0.5"
      >
        <div role="row" className="grid grid-cols-7 gap-0.5">
          {WEEKDAY_LABELS.map((label) => (
            <div
              key={label}
              role="columnheader"
              aria-label={`星期${label}`}
              className="flex h-6 items-center justify-center text-mcs-xs text-mcs-text-muted"
            >
              {label}
            </div>
          ))}
        </div>

        {Array.from({ length: days.length / 7 }, (_, week) => (
          <div role="row" key={week} className="grid grid-cols-7 gap-0.5">
            {days.slice(week * 7, week * 7 + 7).map((iso) => {
              const selected = iso === value
              const isToday = iso === today
              const outside = !isSameMonth(iso, focusDate)
              const disabled = !inRange(iso)
              return (
                <div key={iso} role="gridcell" aria-selected={selected} className="flex justify-center">
                  <button
                    type="button"
                    data-date={iso}
                    tabIndex={iso === focusDate ? 0 : -1}
                    aria-label={dayLabel(iso)}
                    aria-current={isToday ? 'date' : undefined}
                    disabled={disabled}
                    onClick={() => onSelect(iso)}
                    className={cn(
                      'flex size-7 items-center justify-center rounded-mcs-xs text-mcs-xs tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-mcs-focus-ring focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-40',
                      selected
                        // 亮色下实心 accent 对弹层底仅 1.33:1，靠强档描边补足选中态的 ≥3:1 可辨识性
                        ? 'bg-mcs-accent font-medium text-mcs-on-accent ring-1 ring-mcs-accent-border-strong'
                        : cn(
                            'hover:bg-mcs-state-hover',
                            outside ? 'text-mcs-text-muted' : 'text-mcs-text-default',
                            // 今天标记：subtle 底 + accent 文字（accent-border 环实测对比度不足 3:1，弃用）
                            isToday && 'bg-mcs-accent-bg-subtle text-mcs-accent-fg',
                          ),
                    )}
                  >
                    {dayOfMonth(iso)}
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div className="mt-1 flex items-center justify-between border-t border-mcs-border-muted pt-1">
        <Button type="button" variant="ghost" size="xs" disabled={!inRange(today)} onClick={() => onSelect(today)}>
          今天
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onClear} disabled={value === ''}>
          清除
        </Button>
      </div>
    </div>
  )
}
