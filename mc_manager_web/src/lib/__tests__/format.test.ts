import { describe, it, expect } from 'vitest'
import {
  formatLogFileName,
  formatNotificationTime,
  formatRelativeTime,
  formatStartTime,
  formatUptime,
  worldTimePhase,
} from '../format'

describe('formatUptime', () => {
  it('>1天「X天 X小时」', () => {
    expect(formatUptime(2 * 86400 + 3 * 3600)).toBe('2天 3小时')
  })
  it('1 天整「1天 0小时」（边界：否则 0h 余显示 0m）', () => {
    expect(formatUptime(86400)).toBe('1天 0小时')
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

describe('formatStartTime / formatLogFileName / worldTimePhase', () => {
  it('startTime 本地时区 MM-dd HH:mm；缺失 --', () => {
    const d = new Date(2026, 7, 14, 9, 30) // 本地时区构造
    expect(formatStartTime(d.toISOString())).toBe('08-14 09:30')
    expect(formatStartTime(null)).toBe('--')
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
})
