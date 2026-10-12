/**
 * Cron 表达式业务逻辑
 * - cronDescription：5 字段 cron → 中文可读描述（describeTime/describeDay 组合）
 * - CRON_PRESETS：7 项快捷预置
 * - CRON_FIELD_OPTIONS：可视化编辑器五字段常用选项
 * 仅覆盖常见模式（星号步进、星号、具体数值、范围 1-5、列表 0,6），无法识别返回空串。
 */

import { Cron } from 'croner'

/** 字段选项（label 显示名 + value cron 字段值） */
export interface CronFieldOption {
  label: string
  value: string
}

/**
 * 周字段 chip 选项（cron: 0=周日 ... 6=周六）
 */
export const WEEKDAY_CHIPS: Array<{ label: string; value: number }> = [
  { label: '日', value: 0 },
  { label: '一', value: 1 },
  { label: '二', value: 2 },
  { label: '三', value: 3 },
  { label: '四', value: 4 },
  { label: '五', value: 5 },
  { label: '六', value: 6 },
]

/**
 * 周字段快捷组合
 */
export const WEEKDAY_COMBOS: Array<{ label: string; value: string }> = [
  { label: '工作日', value: '1-5' },
  { label: '周末', value: '0,6' },
]

/**
 * 将周字段值解析为已选中的星期数字集合
 * `*` 或空 → 空集（全选=任意天）
 * `1-5` → {1,2,3,4,5}
 * `0,6` → {0,6}
 * 单数字 → 对应集合
 */
export function parseWeekdayField(dow: string): Set<number> {
  if (dow === '*' || dow === '') return new Set()
  const result = new Set<number>()
  for (const part of dow.split(',')) {
    const trimmed = part.trim()
    if (trimmed.includes('-')) {
      const range = trimmed.split('-').map((s) => strictParseInt(s))
      const a = range[0]
      const b = range[1]
      if (a !== null && a !== undefined && b !== null && b !== undefined) {
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        for (let i = lo; i <= hi; i++) result.add(i)
      }
    } else {
      const n = strictParseInt(trimmed)
      if (n !== null) result.add(n)
    }
  }
  return result
}

/**
 * 将已选中的星期数字集合序列化为 cron 周字段值
 * 空集 → `*`；单项 → 数字字符串；多项 → 逗号分隔
 */
export function serializeWeekdayField(selected: Set<number>): string {
  if (selected.size === 0) return '*'
  if (selected.size === 7) return '*'
  const sorted = [...selected].sort((a, b) => a - b)
  return sorted.join(',')
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
export const CRON_FIELD_OPTIONS: Record<
  'minute' | 'hour' | 'day' | 'month' | 'weekday',
  CronFieldOption[]
> = {
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

/**
 * cron 表达式是否会被调度器接受。
 *
 * **必须用服务端同一个解析器**（`croner`，服务端 `routes/tasks.js` 的 `assertValidCron`
 * 亦然）：客户端另写一套「看起来合法」的判断只会与服务端判据漂移，把非法表达式放过去，
 * 而非法表达式入库后任务**静默永不触发**（只在运行期记日志）。
 *
 * ⚠️ 两侧是**各自独立安装**的 `croner`（本仓无 workspace 根），故判据一致靠的是
 * 同一个 caret 范围 + 同一调用形态，而非共享锁文件——升级一侧时须同步另一侧。
 */
export function isValidCron(cron: string): boolean {
  if (!cron.trim()) return false
  try {
    new Cron(cron, { paused: true })
    return true
  } catch {
    return false
  }
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

/**
 * 计算标准 5 字段 cron 表达式的下一次运行时间
 * 与后端 task_scheduler.js getNextRun 同源语义（croner 库、本地时区）
 * @returns 下次运行 Date，无效表达式返回 null
 */
export function getNextCronRun(cronExpr: string): Date | null {
  if (!parseCronFields(cronExpr)) return null
  try {
    const job = new Cron(cronExpr, { paused: true })
    return job.nextRun() ?? null
  } catch {
    return null
  }
}

/**
 * 格式化下次运行时间为简短中文提示
 * @returns "MM-dd HH:mm" 格式（与 lib/format.ts 收口风格一致），null 时返回空串
 */
export function formatNextRun(cronExpr: string): string {
  const next = getNextCronRun(cronExpr)
  if (!next) return ''
  const M = String(next.getMonth() + 1).padStart(2, '0')
  const D = String(next.getDate()).padStart(2, '0')
  const h = String(next.getHours()).padStart(2, '0')
  const m = String(next.getMinutes()).padStart(2, '0')
  return `${M}-${D} ${h}:${m}`
}
