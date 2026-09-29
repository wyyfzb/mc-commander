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
  formatNextRun,
  getNextCronRun,
  hourLabel,
  minuteLabel,
  monthName,
  parseCronFields,
  parseWeekdayField,
  serializeWeekdayField,
  isValidCron,
  WEEKDAY_CHIPS,
  WEEKDAY_COMBOS,
  weekdayName,
} from '../mc-cron'

describe('isValidCron（与服务端 assertValidCron 同一解析器）', () => {
  it('合法表达式通过', () => {
    expect(isValidCron('0 4 * * *')).toBe(true)
    expect(isValidCron('*/5 * * * *')).toBe(true)
    expect(isValidCron('0 0 1 1 *')).toBe(true)
  })

  it('字段不足 / 文本 / 越界值一律拒绝（这些入库后任务会静默永不触发）', () => {
    expect(isValidCron('0 4 * *')).toBe(false) // 只有 4 字段
    expect(isValidCron('not a cron')).toBe(false)
    expect(isValidCron('99 99 * * *')).toBe(false) // 分钟/小时越界
  })

  it('空串与纯空白拒绝', () => {
    expect(isValidCron('')).toBe(false)
    expect(isValidCron('   ')).toBe(false)
  })
})

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

describe('周字段 chip 辅助', () => {
  it('WEEKDAY_CHIPS 7 项（周日0~周六6）', () => {
    expect(WEEKDAY_CHIPS).toHaveLength(7)
    expect(WEEKDAY_CHIPS.map((c) => c.value)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('WEEKDAY_COMBOS 工作日/周末', () => {
    expect(WEEKDAY_COMBOS).toHaveLength(2)
    expect(WEEKDAY_COMBOS[0]).toEqual({ label: '工作日', value: '1-5' })
    expect(WEEKDAY_COMBOS[1]).toEqual({ label: '周末', value: '0,6' })
  })

  it('parseWeekdayField: * / 空返回空集', () => {
    expect(parseWeekdayField('*')).toEqual(new Set())
    expect(parseWeekdayField('')).toEqual(new Set())
  })

  it('parseWeekdayField: 单数字', () => {
    expect(parseWeekdayField('1')).toEqual(new Set([1]))
    expect(parseWeekdayField('0')).toEqual(new Set([0]))
  })

  it('parseWeekdayField: 逗号列表', () => {
    expect(parseWeekdayField('0,6')).toEqual(new Set([0, 6]))
    expect(parseWeekdayField('1,3,5')).toEqual(new Set([1, 3, 5]))
  })

  it('parseWeekdayField: 范围展开', () => {
    expect(parseWeekdayField('1-5')).toEqual(new Set([1, 2, 3, 4, 5]))
    expect(parseWeekdayField('0-6')).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]))
  })

  it('parseWeekdayField: 混合列表', () => {
    expect(parseWeekdayField('1-3,5')).toEqual(new Set([1, 2, 3, 5]))
  })

  it('parseWeekdayField: 非法值静默跳过', () => {
    expect(parseWeekdayField('abc')).toEqual(new Set())
    expect(parseWeekdayField('1,abc,3')).toEqual(new Set([1, 3]))
  })

  it('serializeWeekdayField: 空集/全7天→*，其余逗号分隔排序', () => {
    expect(serializeWeekdayField(new Set())).toBe('*')
    expect(serializeWeekdayField(new Set([0, 1, 2, 3, 4, 5, 6]))).toBe('*')
    expect(serializeWeekdayField(new Set([1]))).toBe('1')
    expect(serializeWeekdayField(new Set([0, 6]))).toBe('0,6')
    expect(serializeWeekdayField(new Set([3, 1, 5]))).toBe('1,3,5')
  })
})

describe('getNextCronRun / formatNextRun', () => {
  it('*/5 * * * *：返回未来 5 分钟整的 Date', () => {
    const next = getNextCronRun('*/5 * * * *')
    expect(next).toBeInstanceOf(Date)
    expect(next!.getTime()).toBeGreaterThan(Date.now())
    // 分钟应为 5 的倍数
    expect(next!.getMinutes() % 5).toBe(0)
  })

  it('* * * * 0,6：返回周末的下一分钟', () => {
    const next = getNextCronRun('* * * * 0,6')
    expect(next).toBeInstanceOf(Date)
    const dow = next!.getDay()
    // 0=Sunday, 6=Saturday
    expect([0, 6]).toContain(dow)
  })

  it('0 0 30 2 *：2 月 30 日不存在，croner 返回 null（越界无匹配）', () => {
    // croner 对不存在日期返回 null（2月30日永不存在）
    expect(getNextCronRun('0 0 30 2 *')).toBeNull()
    expect(formatNextRun('0 0 30 2 *')).toBe('')
  })

  it('无效表达式返回 null', () => {
    expect(getNextCronRun('')).toBeNull()
    expect(getNextCronRun('0 4 *')).toBeNull()
    expect(getNextCronRun('a b c d e')).toBeNull()
  })

  it('formatNextRun 返回 MM-dd HH:mm 格式', () => {
    const formatted = formatNextRun('0 4 * * *')
    // 格式应为 MM-dd HH:mm（与 lib/format.ts 收口风格一致，MM-dd 短横线分隔）
    expect(formatted).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('formatNextRun 无效表达式返回空串', () => {
    expect(formatNextRun('')).toBe('')
    expect(formatNextRun('bad')).toBe('')
  })
})
