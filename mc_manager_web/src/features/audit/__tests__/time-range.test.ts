/**
 * time-range 工具单测（#303）
 * 锁定服务端口径：SQLite CURRENT_TIMESTAMP 为 UTC「YYYY-MM-DD HH:MM:SS」，
 * 字符串比较语义下起止换算必须与该格式逐字符对齐。
 * 用固定时刻构造（不依赖运行时区），断言全部基于同一时区下换算的自洽性。
 */
import { describe, expect, it } from 'vitest'
import { QUICK_RANGES, isRangeInverted, localDateStr, quickRangeDates, toServerEnd, toServerStart, toServerUtc } from '../time-range'

describe('localDateStr / toServerUtc 格式锁定', () => {
  it('localDateStr 输出零填充 yyyy-MM-dd（本地日历日）', () => {
    const d = new Date(2026, 0, 5, 9, 3, 7) // 本地 2026-01-05
    expect(localDateStr(d)).toBe('2026-01-05')
  })

  it('toServerUtc 输出零填充 UTC「YYYY-MM-DD HH:MM:SS」（空格分隔，非 ISO T）', () => {
    // 2026-01-05T23:30:05Z → UTC 串保持同刻
    expect(toServerUtc(new Date('2026-01-05T23:30:05.000Z'))).toBe('2026-01-05 23:30:05')
  })

  it('单位数月/日/时/分/秒均零填充（字符串比较要求定宽）', () => {
    expect(toServerUtc(new Date('2026-03-04T01:02:03.000Z'))).toBe('2026-03-04 01:02:03')
  })
})

describe('toServerStart / toServerEnd 日界换算', () => {
  it('起点为本地 00:00:00.000 对应的 UTC 串', () => {
    const start = toServerStart('2026-01-10')
    // 与手工构造本地零点后换算完全一致（跨时区自洽）
    const expected = toServerUtc(new Date(2026, 0, 10, 0, 0, 0, 0))
    expect(start).toBe(expected)
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('终点秒级截断但落在本地当日 23:59:59（含当日最后记录）', () => {
    const end = toServerEnd('2026-01-10')
    const expected = toServerUtc(new Date(2026, 0, 10, 23, 59, 59, 999))
    expect(end).toBe(expected)
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('同日起止满足 start <= end（服务器字符串比较语义）', () => {
    expect(toServerStart('2026-06-15') <= toServerEnd('2026-06-15')).toBe(true)
  })
})

describe('quickRangeDates 快捷区间', () => {
  it('今天：单日区间', () => {
    const r = quickRangeDates(0, new Date(2026, 8, 2, 21, 50))
    expect(r).toEqual({ start: '2026-09-02', end: '2026-09-02' })
  })

  it('近 7 天：含今天共 7 个日历日（daysBack=6）', () => {
    const r = quickRangeDates(6, new Date(2026, 8, 2, 21, 50))
    expect(r).toEqual({ start: '2026-08-27', end: '2026-09-02' })
  })

  it('近 30 天：含今天共 30 个日历日（daysBack=29）', () => {
    const r = quickRangeDates(29, new Date(2026, 8, 2, 21, 50))
    expect(r).toEqual({ start: '2026-08-04', end: '2026-09-02' })
  })

  it('跨月/跨年回卷正确', () => {
    expect(quickRangeDates(6, new Date(2026, 2, 3)).start).toBe('2026-02-25')
    expect(quickRangeDates(6, new Date(2026, 0, 3)).start).toBe('2025-12-28')
  })

  it('三枚快捷键定义完整（key/label/daysBack 契约）', () => {
    expect(QUICK_RANGES.map((q) => q.key)).toEqual(['today', '7d', '30d'])
    expect(QUICK_RANGES.map((q) => q.daysBack)).toEqual([0, 6, 29])
  })
})

describe('isRangeInverted 倒置校验', () => {
  it('两端齐且 start > end → true', () => {
    expect(isRangeInverted('2026-02-10', '2026-02-01')).toBe(true)
  })
  it('正常区间 / 仅一端 / 全空 → false', () => {
    expect(isRangeInverted('2026-02-01', '2026-02-10')).toBe(false)
    expect(isRangeInverted('2026-02-01', '')).toBe(false)
    expect(isRangeInverted('', '2026-02-10')).toBe(false)
    expect(isRangeInverted('', '')).toBe(false)
  })
})
