/**
 * mc-calendar 行为级测试：网格构造 / 平移边界 / 非法入参 / 无障碍文案
 * 全部用固定日期断言，不依赖运行时刻
 */
import { describe, it, expect } from 'vitest'
import {
  CALENDAR_CELLS,
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
  toIsoDate,
  todayIso,
} from '../mc-calendar'

describe('toIsoDate / parseIsoDate', () => {
  it('本地日历日零填充格式化', () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(toIsoDate(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('合法日期往返一致；非法格式/回卷日期返回 null', () => {
    expect(toIsoDate(parseIsoDate('2026-09-07')!)).toBe('2026-09-07')
    expect(parseIsoDate('2026-2-7')).toBeNull()
    expect(parseIsoDate('2026/09/07')).toBeNull()
    expect(parseIsoDate('')).toBeNull()
    // 2026-02-31 会被 Date 回卷到 3/3，必须拒绝
    expect(parseIsoDate('2026-02-31')).toBeNull()
    expect(parseIsoDate('2026-13-01')).toBeNull()
    // 闰年 2/29 合法
    expect(parseIsoDate('2024-02-29')).not.toBeNull()
  })

  it('todayIso 取传入时刻的本地日历日', () => {
    expect(todayIso(new Date(2026, 8, 7, 23, 30))).toBe('2026-09-07')
  })
})

describe('addDays / addMonths', () => {
  it('跨月跨年平移', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('月份平移在目标月缺日时收敛到月末', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-03-15', -1)).toBe('2026-02-15')
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15')
  })

  it('非法入参按今天兜底（不抛异常）', () => {
    const today = todayIso()
    expect(addDays('', 0)).toBe(today)
    expect(addMonths('oops', 0)).toBe(today)
  })
})

describe('startOfWeek / endOfWeek', () => {
  it('周一为首、周日为末', () => {
    // 2026-09-07 是周一
    expect(startOfWeek('2026-09-07')).toBe('2026-09-07')
    expect(endOfWeek('2026-09-07')).toBe('2026-09-13')
    // 2026-09-13 是周日，仍属 9/7 那一周
    expect(startOfWeek('2026-09-13')).toBe('2026-09-07')
    expect(endOfWeek('2026-09-13')).toBe('2026-09-13')
  })
})

describe('monthGrid', () => {
  it('固定 42 格、首列为周一、包含当月 1 号与相邻月补位', () => {
    const grid = monthGrid('2026-09-15')
    expect(grid).toHaveLength(CALENDAR_CELLS)
    expect(grid[0]).toBe('2026-08-31') // 9/1 是周二 → 前置周一补位
    expect(grid).toContain('2026-09-01')
    expect(grid).toContain('2026-09-30')
    expect(grid[grid.length - 1]).toBe('2026-10-11')
    // 每格比前一格晚一天
    for (let i = 1; i < grid.length; i++) {
      expect(addDays(grid[i - 1]!, 1)).toBe(grid[i])
    }
  })

  it('1 号恰为周一时无前置补位；2 月跨年网格正确', () => {
    expect(monthGrid('2026-06-10')[0]).toBe('2026-06-01') // 2026-06-01 是周一
    const feb = monthGrid('2026-02-10')
    expect(feb[0]).toBe('2026-01-26')
    expect(feb).toContain('2026-02-28')
  })
})

describe('标签与判定', () => {
  it('monthLabel / dayLabel / dayOfMonth', () => {
    expect(monthLabel('2026-09-07')).toBe('2026 年 9 月')
    expect(dayLabel('2026-09-07')).toBe('2026年9月7日 星期一')
    expect(dayLabel('2026-09-13')).toBe('2026年9月13日 星期日')
    expect(dayLabel('bad')).toBe('bad')
    expect(dayOfMonth('2026-09-07')).toBe(7)
  })

  it('isSameMonth 区分相邻月补位', () => {
    expect(isSameMonth('2026-09-01', '2026-09-15')).toBe(true)
    expect(isSameMonth('2026-08-31', '2026-09-15')).toBe(false)
  })

  it('周标签为周一 → 周日', () => {
    expect(WEEKDAY_LABELS).toEqual(['一', '二', '三', '四', '五', '六', '日'])
  })
})
