import { describe, it, expect } from 'vitest'
import {
  formatClock,
  formatDateTime,
  formatDurationMs,
  formatDurationSec,
  formatDurationSecFull,
  formatFullDateMinute,
  formatFullDateTime,
  formatLogFileName,
  formatNotificationTime,
  formatRelativeTime,
  formatStartTime,
  formatUptime,
  formatWorldSize,
  worldSizeParts,
  worldTimePhase,
} from '../format'

describe('formatUptime', () => {
  it('>1天「Xd Xh」', () => {
    expect(formatUptime(2 * 86400 + 3 * 3600)).toBe('2d 3h')
  })
  it('1 天整「1d 0h」（边界：否则 0h 余显示 0m）', () => {
    expect(formatUptime(86400)).toBe('1d 0h')
  })
  it('>1小时「Xh Ym」', () => {
    expect(formatUptime(2 * 3600 + 30 * 60)).toBe('2h 30m')
  })
  it('否则「Xm」', () => {
    expect(formatUptime(5 * 60)).toBe('5m')
  })
  it('未运行', () => {
    expect(formatUptime(0)).toBe('未运行')
    expect(formatUptime(null)).toBe('未运行')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-08-14T12:00:00').getTime()
  it('刚刚 / N分钟前 / N小时前 / N天前 / 未知', () => {
    expect(formatRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe('刚刚')
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5分钟前')
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3小时前')
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2天前')
    expect(formatRelativeTime(null, now)).toBe('未知')
  })
  it('自定义空值文案（空串 / 非法输入同兜底）', () => {
    expect(formatRelativeTime(null, now, '从未')).toBe('从未')
    expect(formatRelativeTime('', now, '从未')).toBe('从未')
    expect(formatRelativeTime('not-a-date', now, '从未')).toBe('从未')
  })
})

describe('formatNotificationTime', () => {
  const now = new Date('2026-08-14T12:00:00').getTime()
  it('今天 HH:mm', () => {
    expect(formatNotificationTime(new Date('2026-08-14T09:05:00').getTime(), now)).toBe('09:05')
  })
  it('昨天 HH:mm', () => {
    expect(formatNotificationTime(new Date('2026-08-13T23:30:00').getTime(), now)).toBe('昨天 23:30')
  })
  it('更早 MM-dd HH:mm', () => {
    expect(formatNotificationTime(new Date('2026-08-01T08:00:00').getTime(), now)).toBe('08-01 08:00')
  })
})

describe('formatDateTime（MM-dd HH:mm:ss）', () => {
  it('本地时区含秒；秒位补零边界', () => {
    const d = new Date(2026, 7, 14, 9, 5, 3) // 本地时区构造（个位分/秒补零）
    expect(formatDateTime(d.toISOString())).toBe('08-14 09:05:03')
  })
  it('空值 / 非法输入 → 默认 -- 与自定义兜底', () => {
    expect(formatDateTime(null)).toBe('--')
    expect(formatDateTime('')).toBe('--')
    expect(formatDateTime('not-a-date')).toBe('--')
    expect(formatDateTime(undefined, '无记录')).toBe('无记录')
    expect(formatDateTime('not-a-date', '原始值兜底')).toBe('原始值兜底')
  })
})

describe('formatFullDateTime（YYYY-MM-DD HH:mm:ss）', () => {
  it('本地时区含年与秒', () => {
    const d = new Date(2026, 7, 14, 23, 5, 3)
    expect(formatFullDateTime(d.toISOString())).toBe('2026-08-14 23:05:03')
  })
  it('空值 / 非法输入 → 默认 -- 与自定义兜底', () => {
    expect(formatFullDateTime(null)).toBe('--')
    expect(formatFullDateTime('not-a-date')).toBe('--')
    expect(formatFullDateTime(undefined, '未知')).toBe('未知')
  })
})

describe('formatFullDateMinute（YYYY-MM-DD HH:mm）', () => {
  it('本地时区到分', () => {
    const d = new Date(2026, 7, 14, 9, 5)
    expect(formatFullDateMinute(d.toISOString())).toBe('2026-08-14 09:05')
  })
  it('空值 / 非法输入 → 默认 -- 与自定义兜底', () => {
    expect(formatFullDateMinute(null)).toBe('--')
    expect(formatFullDateMinute('not-a-date')).toBe('--')
    expect(formatFullDateMinute(undefined, '')).toBe('')
  })
})

describe('formatClock（HH:mm）', () => {
  it('本地时区时刻；分位补零边界', () => {
    const d = new Date(2026, 7, 14, 9, 5)
    expect(formatClock(d.toISOString())).toBe('09:05')
  })
  it('空值 / 非法输入 → 默认 -- 与自定义兜底', () => {
    expect(formatClock(null)).toBe('--')
    expect(formatClock('not-a-date')).toBe('--')
    expect(formatClock(undefined, '现在')).toBe('现在')
  })
})

describe('formatStartTime / formatLogFileName / worldTimePhase', () => {
  it('startTime 本地时区 MM-dd HH:mm；缺失 --；自定义兜底', () => {
    const d = new Date(2026, 7, 14, 9, 30) // 本地时区构造
    expect(formatStartTime(d.toISOString())).toBe('08-14 09:30')
    expect(formatStartTime(null)).toBe('--')
    expect(formatStartTime('not-a-date', '-')).toBe('-')
    expect(formatStartTime(undefined, '从未')).toBe('从未')
  })

  it('日志文件名格式', () => {
    expect(formatLogFileName(new Date(2026, 7, 14, 9, 30, 5))).toBe('mc_server_log_20260814_093005.txt')
  })

  it('世界时段映射', () => {
    expect(worldTimePhase(1000)).toBe('白天')
    expect(worldTimePhase(6000)).toBe('正午')
    expect(worldTimePhase(11000)).toBe('黄昏')
    expect(worldTimePhase(15000)).toBe('夜晚')
    expect(worldTimePhase(22000)).toBe('午夜')
    expect(worldTimePhase(null)).toBe('--')
  })

  it('worldSizeParts：<1GB 换 MB，≥1GB 保留一位 GB，异常值回退 0 GB', () => {
    // 实测场景：643MB 存档（0.6279296875 GB）旧实现渲染「0.6」易误读为 0
    expect(worldSizeParts(0.6279296875)).toEqual({ value: '643', unit: 'MB' })
    expect(worldSizeParts(3.2)).toEqual({ value: '3.2', unit: 'GB' })
    expect(worldSizeParts(1)).toEqual({ value: '1.0', unit: 'GB' })
    expect(worldSizeParts(0)).toEqual({ value: '0', unit: 'GB' })
    expect(worldSizeParts(null)).toEqual({ value: '0', unit: 'GB' })
    expect(worldSizeParts(Number.NaN)).toEqual({ value: '0', unit: 'GB' })
  })

  it('formatWorldSize：GB 数值档位换算，null/非有限数回退 —（契约对齐后入参恒为 number）', () => {
    expect(formatWorldSize(0.6279296875)).toBe('643 MB')
    expect(formatWorldSize(3.2)).toBe('3.2 GB')
    expect(formatWorldSize(null)).toBe('—')
    expect(formatWorldSize(undefined)).toBe('—')
  })
})

describe('formatDurationMs', () => {
  it('<1s 展示毫秒「Nms」', () => {
    expect(formatDurationMs(0)).toBe('0ms')
    expect(formatDurationMs(500)).toBe('500ms')
    expect(formatDurationMs(999)).toBe('999ms')
  })
  it('≥1s 秒保留一位「X.Xs」', () => {
    expect(formatDurationMs(1000)).toBe('1.0s')
    expect(formatDurationMs(1234)).toBe('1.2s')
    expect(formatDurationMs(59500)).toBe('59.5s')
  })
  it('空值返回 emptyText（默认 -，可自定义）', () => {
    expect(formatDurationMs(null)).toBe('-')
    expect(formatDurationMs(undefined)).toBe('-')
    expect(formatDurationMs(null, '—')).toBe('—')
  })
})

describe('formatDurationSec', () => {
  it('<1m「Xs」', () => {
    expect(formatDurationSec(0)).toBe('0s')
    expect(formatDurationSec(5)).toBe('5s')
    expect(formatDurationSec(59)).toBe('59s')
  })
  it('<1h「Xm Ys」（秒两位补零）', () => {
    expect(formatDurationSec(60)).toBe('1m00s')
    expect(formatDurationSec(65)).toBe('1m05s')
  })
  it('≥1h「Xh Ym」（分两位补零）', () => {
    expect(formatDurationSec(3600)).toBe('1h00m')
    expect(formatDurationSec(3661)).toBe('1h01m')
  })
  it('负值按 0 处理', () => {
    expect(formatDurationSec(-3)).toBe('0s')
  })
})

describe('formatDurationSecFull', () => {
  it('<1m「X 秒」', () => {
    expect(formatDurationSecFull(5)).toBe('5 秒')
    expect(formatDurationSecFull(59)).toBe('59 秒')
  })
  it('<1h「X 分 Y 秒」', () => {
    expect(formatDurationSecFull(65)).toBe('1 分 5 秒')
  })
  it('≥1h「X 时 Y 分」', () => {
    expect(formatDurationSecFull(3600)).toBe('1 时 0 分')
    expect(formatDurationSecFull(3661)).toBe('1 时 1 分')
  })
  it('负值按 0 处理', () => {
    expect(formatDurationSecFull(-3)).toBe('0 秒')
  })
})
