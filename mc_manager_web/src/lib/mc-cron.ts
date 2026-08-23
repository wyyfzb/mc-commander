/**
 * Cron 表达式业务逻辑
 * - cronDescription：5 字段 cron → 中文可读描述（describeTime/describeDay 组合）
 * - CRON_PRESETS：7 项快捷预置
 * - CRON_FIELD_OPTIONS：可视化编辑器五字段常用选项
 * 仅覆盖常见模式（星号步进、星号、具体数值、范围 1-5、列表 0,6），无法识别返回空串。
 */

/** 字段选项（label 显示名 + value cron 字段值） */
export interface CronFieldOption {
  label: string
  value: string
}

/** 7 项 cron 快捷预置 */
export const CRON_PRESETS: CronFieldOption[] = [
  { label: '每小时', value: '0 * * * *' },
  { label: '每天 4:00', value: '0 4 * * *' },
  { label: '每天 0:00', value: '0 0 * * *' },
  { label: '每周一 4:00', value: '0 4 * * 1' },
  { label: '每月1日 4:00', value: '0 4 1 * *' },
  { label: '每12小时', value: '0 */12 * * *' },
  { label: '每30分钟', value: '*/30 * * * *' },
]

/** 可视化编辑器五字段选项 */
export const CRON_FIELD_OPTIONS: Record<'minute' | 'hour' | 'day' | 'month' | 'weekday', CronFieldOption[]> = {
  minute: [
    { label: '每分钟', value: '*' },
    { label: '每5分', value: '*/5' },
    { label: '每10分', value: '*/10' },
    { label: '每15分', value: '*/15' },
    { label: '每30分', value: '*/30' },
    { label: '0分', value: '0' },
    { label: '30分', value: '30' },
  ],
  hour: [
    { label: '每小时', value: '*' },
    { label: '每2时', value: '*/2' },
    { label: '每6时', value: '*/6' },
    { label: '每12时', value: '*/12' },
    { label: '0点', value: '0' },
    { label: '4点', value: '4' },
    { label: '12点', value: '12' },
    { label: '18点', value: '18' },
  ],
  day: [
    { label: '每天', value: '*' },
    { label: '1日', value: '1' },
    { label: '15日', value: '15' },
  ],
  month: [
    { label: '每月', value: '*' },
    { label: '每季', value: '*/3' },
    { label: '每半年', value: '*/6' },
    { label: '1月', value: '1' },
    { label: '7月', value: '7' },
  ],
  weekday: [
    { label: '每天', value: '*' },
    { label: '周一', value: '1' },
    { label: '周二', value: '2' },
    { label: '周三', value: '3' },
    { label: '周四', value: '4' },
    { label: '周五', value: '5' },
    { label: '周六', value: '6' },
    { label: '周日', value: '0' },
    { label: '工作日', value: '1-5' },
    { label: '周末', value: '0,6' },
  ],
}

/** 解析 5 字段 cron（不足 5 字段返回 null；多余字段忽略） */
export function parseCronFields(cron: string): string[] | null {
  const parts = cron.trim().split(/\s+/)
  return parts.length >= 5 ? parts.slice(0, 5) : null
}

/** 将 5 字段 cron 表达式转换为中文可读描述；无法识别返回空串 */
export function cronDescription(cron: string): string {
  const parts = parseCronFields(cron)
  if (!parts) return ''
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]

  const timeDesc = describeTime(m, h)
  const dayDesc = describeDay(dom, mon, dow)
  if (timeDesc.length === 0 || dayDesc.length === 0) return ''
  return `${timeDesc}${dayDesc}`
}

/** 时间部分描述 */
export function describeTime(m: string, h: string): string {
  if (m === '*' && h === '*') return '每分钟'
  if (m.startsWith('*/') && h === '*') return `每${m.substring(2)}分钟`
  if (m === '0' && h === '*') return '每小时整点'
  if (m === '*' && h.startsWith('*/')) return `每${h.substring(2)}小时`
  if (m === '0' && h.startsWith('*/')) return `每${h.substring(2)}小时整点`
  if (m === '*' && h !== '*') return `${hourLabel(h)}每分钟`
  if (m !== '*' && h === '*') return `每小时${minuteLabel(m)}`
  if (m !== '*' && h !== '*') {
    const hh = strictParseInt(h)
    const mm = strictParseInt(m)
    if (hh !== null && mm !== null) {
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    }
    return `${h}:${m}`
  }
  return ''
}

/** 日期部分描述（周字段在日期为 * 时优先） */
export function describeDay(dom: string, mon: string, dow: string): string {
  if (dow !== '*' && dom === '*') {
    if (dow === '1-5') return '的每个工作日执行'
    if (dow === '0,6' || dow === '6,0') return '的每个周末执行'
    return `每${weekdayName(dow)}执行`
  }
  if (dom !== '*' && dow === '*') {
    if (mon === '*') return `每月${dom}日执行`
    return `${monthName(mon)}${dom}日执行`
  }
  if (dom === '*' && mon.startsWith('*/')) {
    return `每${mon.substring(2)}个月执行`
  }
  if (dom === '*' && mon !== '*') {
    return `${monthName(mon)}每天执行`
  }
  if (dom === '*' && mon === '*' && dow === '*') return '每天执行'
  return ''
}

/**
 * 严格整数字符串解析（'1-5'/'4x' 等非纯数字形式返回 null）。
 * JS parseInt 会宽容解析（'1-5'→1），必须严格匹配纯整数。
 */
function strictParseInt(s: string): number | null {
  if (!/^-?\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isNaN(n) ? null : n
}

/** 小时中文标签 */
export function hourLabel(h: string): string {
  const n = strictParseInt(h)
  return n === null ? `${h}点` : `${n}点`
}

/** 分钟中文标签 */
export function minuteLabel(m: string): string {
  const n = strictParseInt(m)
  return n === null ? `${m}分` : `${n}分`
}

/** 周字段中文名（未知值原样返回） */
export function weekdayName(dow: string): string {
  const names: Record<number, string> = {
    0: '周日',
    1: '周一',
    2: '周二',
    3: '周三',
    4: '周四',
    5: '周五',
    6: '周六',
  }
  const n = strictParseInt(dow)
  return n === null ? dow : (names[n] ?? dow)
}

/** 月字段中文名（未知值原样返回） */
export function monthName(mon: string): string {
  const n = strictParseInt(mon)
  return n === null ? mon : `${n}月`
}
