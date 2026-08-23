/**
 * mc-cron 单测
 */
import { describe, it, expect } from 'vitest'
import {
  CRON_FIELD_OPTIONS,
  CRON_PRESETS,
  cronDescription,
  describeDay,
  describeTime,
  hourLabel,
  minuteLabel,
  monthName,
  parseCronFields,
  weekdayName,
} from '../mc-cron'

describe('parseCronFields', () => {
  it('5 字段正常解析；不足 5 字段返回 null', () => {
    expect(parseCronFields('0 4 * * *')).toEqual(['0', '4', '*', '*', '*'])
    expect(parseCronFields(' 0  4  * * 1 ')).toEqual(['0', '4', '*', '*', '1'])
    expect(parseCronFields('0 4 *')).toBeNull()
    expect(parseCronFields('')).toBeNull()
  })
})

describe('cronDescription', () => {
  it('预置 7 项全部可识别', () => {
    expect(cronDescription('0 * * * *')).toBe('每小时整点每天执行')
    expect(cronDescription('0 4 * * *')).toBe('04:00每天执行')
    expect(cronDescription('0 0 * * *')).toBe('00:00每天执行')
    expect(cronDescription('0 4 * * 1')).toBe('04:00每周一执行')
    expect(cronDescription('0 4 1 * *')).toBe('04:00每月1日执行')
    expect(cronDescription('0 */12 * * *')).toBe('每12小时整点每天执行')
    expect(cronDescription('*/30 * * * *')).toBe('每30分钟每天执行')
  })

  it('常见模式组合', () => {
    expect(cronDescription('* * * * *')).toBe('每分钟每天执行')
    expect(cronDescription('* * * * 1-5')).toBe('每分钟的每个工作日执行')
    expect(cronDescription('* * * * 0,6')).toBe('每分钟的每个周末执行')
    expect(cronDescription('* * * * 6,0')).toBe('每分钟的每个周末执行')
    expect(cronDescription('0 8 * * 6')).toBe('08:00每周六执行')
    expect(cronDescription('30 18 * * *')).toBe('18:30每天执行')
    // describeDay 判定顺序：dom 非 * 先命中「每月$dom日执行」，mon 的 */N 分支仅 dom=* 时可达
    expect(cronDescription('0 8 */3 * *')).toBe('08:00每月*/3日执行')
    expect(cronDescription('0 8 * */3 *')).toBe('08:00每3个月执行')
    expect(cronDescription('0 8 * 7 *')).toBe('08:007月每天执行')
    expect(cronDescription('0 8 15 7 *')).toBe('08:007月15日执行')
  })

  it('无法识别返回空串', () => {
    expect(cronDescription('0 4 *')).toBe('')
    expect(cronDescription('a b c d e')).toBe('')
    expect(cronDescription('')).toBe('')
  })
})

describe('describeTime / describeDay', () => {
  it('时间模式', () => {
    expect(describeTime('*', '*')).toBe('每分钟')
    expect(describeTime('*/5', '*')).toBe('每5分钟')
    expect(describeTime('0', '*')).toBe('每小时整点')
    expect(describeTime('*', '*/6')).toBe('每6小时')
    expect(describeTime('0', '*/12')).toBe('每12小时整点')
    expect(describeTime('*', '4')).toBe('4点每分钟')
    expect(describeTime('30', '*')).toBe('每小时30分')
  })

  it('日期模式（周优先/月份/范围）', () => {
    expect(describeDay('*', '*', '*')).toBe('每天执行')
    expect(describeDay('*', '*', '1-5')).toBe('的每个工作日执行')
    expect(describeDay('1', '*', '*')).toBe('每月1日执行')
    expect(describeDay('*', '*/3', '*')).toBe('每3个月执行')
    expect(describeDay('*', '7', '*')).toBe('7月每天执行')
    expect(describeDay('15', '7', '*')).toBe('7月15日执行')
  })
})

describe('标签函数', () => {
  it('hourLabel/minuteLabel/weekdayName/monthName', () => {
    expect(hourLabel('4')).toBe('4点')
    expect(hourLabel('x')).toBe('x点')
    expect(minuteLabel('30')).toBe('30分')
    expect(minuteLabel('y')).toBe('y分')
    expect(weekdayName('1')).toBe('周一')
    expect(weekdayName('0')).toBe('周日')
    expect(weekdayName('1-5')).toBe('1-5')
    expect(monthName('7')).toBe('7月')
    expect(monthName('*/3')).toBe('*/3')
  })
})

describe('预置与字段选项', () => {
  it('CRON_PRESETS 7 项', () => {
    expect(CRON_PRESETS.map((p) => p.value)).toEqual([
      '0 * * * *',
      '0 4 * * *',
      '0 0 * * *',
      '0 4 * * 1',
      '0 4 1 * *',
      '0 */12 * * *',
      '*/30 * * * *',
    ])
  })

  it('五字段选项数量（分7/时8/日3/月5/周10）', () => {
    expect(CRON_FIELD_OPTIONS.minute).toHaveLength(7)
    expect(CRON_FIELD_OPTIONS.hour).toHaveLength(8)
    expect(CRON_FIELD_OPTIONS.day).toHaveLength(3)
    expect(CRON_FIELD_OPTIONS.month).toHaveLength(5)
    expect(CRON_FIELD_OPTIONS.weekday).toHaveLength(10)
  })
})
