/**
 * DatePickerCalendar —— 月历面板（DateTextInput 的日历弹层内容）
 *
 * 无障碍按 W3C ARIA APG date picker 模式落地：grid/row/columnheader/gridcell 结构、
 * 方向键逐日、PageUp/PageDown 逐月、Home/End 到周首末、roving tabindex 单点可达；
 * 打开时焦点落到当前值（无值落到今天），关闭由 Radix Popover 交还触发器。
 * 日期运算全部下沉 lib/mc-calendar，本组件只管渲染与键盘。
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
  dayLabel,
  dayOfMonth,
  endOfWeek,
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
  onSelect: (iso: string) => void
  onClear: () => void
}

export function DatePickerCalendar({ value, onSelect, onClear }: DatePickerCalendarProps) {
  const monthLabelId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const [focusDate, setFocusDate] = useState(() =>
    parseIsoDate(value) ? value : todayIso(),
  )
  const days = monthGrid(focusDate)
  const today = todayIso()

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
        next = addMonths(focusDate, -1)
        break
      case 'PageDown':
        next = addMonths(focusDate, 1)
        break
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
    setFocusDate(next)
  }

  return (
    <div className="w-56">
      <div className="flex items-center justify-between gap-1">
        <IconButton size="icon-xs" aria-label="上个月" onClick={() => setFocusDate(addMonths(focusDate, -1))}>
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
        <IconButton size="icon-xs" aria-label="下个月" onClick={() => setFocusDate(addMonths(focusDate, 1))}>
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
              className="flex h-6 items-center justify-center text-mcs-xs text-mcs-text-subtle"
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
              return (
                <div key={iso} role="gridcell" aria-selected={selected} className="flex justify-center">
                  <button
                    type="button"
                    data-date={iso}
                    tabIndex={iso === focusDate ? 0 : -1}
                    aria-label={dayLabel(iso)}
                    aria-current={isToday ? 'date' : undefined}
                    onClick={() => onSelect(iso)}
                    className={cn(
                      'flex size-7 items-center justify-center rounded-mcs-xs text-mcs-xs tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-mcs-focus-ring focus-visible:outline-offset-1',
                      selected
                        // 亮色下实心 accent 对弹层底仅 1.33:1，靠强档描边补足选中态的 ≥3:1 可辨识性
                        ? 'bg-mcs-accent font-medium text-mcs-on-accent ring-1 ring-mcs-accent-border-strong'
                        : cn(
                            'hover:bg-mcs-bg-hover',
                            outside ? 'text-mcs-text-subtle' : 'text-mcs-text-default',
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
        <Button type="button" variant="ghost" size="xs" onClick={() => onSelect(today)}>
          今天
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onClear} disabled={value === ''}>
          清除
        </Button>
      </div>
    </div>
  )
}
