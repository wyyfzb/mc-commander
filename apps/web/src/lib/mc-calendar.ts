/**
 * 日历面板日期运算（本地日历日口径 yyyy-MM-dd，周一为首日）
 *
 * 与服务端筛选口径解耦：本模块只产出本地日历日字符串，转 UTC 由
 * features/audit/time-range 负责（SQLite CURRENT_TIMESTAMP 为 UTC 字符串）
 */

/** 周一 → 周日（与 ISO 8601 周序一致，中文语境同习惯） */
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

const WEEKDAY_FULL = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'] as const

/** 固定 6 周 × 7 天：切月时面板高度不跳动 */
export const CALENDAR_CELLS = 42

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → 本地日历日 yyyy-MM-dd */
export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** yyyy-MM-dd → 本地 Date；格式不符或日历日非法（如 2026-02-31）返回 null */
export function parseIsoDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return toIsoDate(date) === iso ? date : null
}

export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now)
}

/** 非法入参按今天兜底：面板不会因外部脏值崩掉 */
function baseDate(iso: string): Date {
  return parseIsoDate(iso) ?? new Date()
}

export function addDays(iso: string, days: number): string {
  const d = baseDate(iso)
  return toIsoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}

/** 月份平移：目标月无此日时收敛到月末（1/31 加一月 → 2/28） */
export function addMonths(iso: string, months: number): string {
  const d = baseDate(iso)
  const year = d.getFullYear()
  const month = d.getMonth() + months
  const lastDay = new Date(year, month + 1, 0).getDate()
  return toIsoDate(new Date(year, month, Math.min(d.getDate(), lastDay)))
}

/** 所在周的周一 */
export function startOfWeek(iso: string): string {
  const d = baseDate(iso)
  return toIsoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)))
}

/** 所在周的周日 */
export function endOfWeek(iso: string): string {
  return addDays(startOfWeek(iso), 6)
}

/** 42 格月历网格（周一为首列，含相邻月补位日） */
export function monthGrid(iso: string): string[] {
  const d = baseDate(iso)
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  return Array.from({ length: CALENDAR_CELLS }, (_, i) =>
    toIsoDate(new Date(first.getFullYear(), first.getMonth(), 1 - offset + i)),
  )
}

/** '2026 年 9 月' */
export function monthLabel(iso: string): string {
  const d = baseDate(iso)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
}

/** 无障碍名：'2026年9月7日 星期一' */
export function dayLabel(iso: string): string {
  const d = parseIsoDate(iso)
  if (!d) return iso
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_FULL[(d.getDay() + 6) % 7] ?? ''}`
}

export function dayOfMonth(iso: string): number {
  return baseDate(iso).getDate()
}

/** 同月判定（相邻月补位日淡化用） */
export function isSameMonth(iso: string, ref: string): boolean {
  const a = baseDate(iso)
  const b = baseDate(ref)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

/**
 * 是否落在可选区间内（含端点；两侧均可缺省，'' 亦视为不设界）。
 * ISO 定长零填充串的字典序即时间序，故直接比串。
 */
export function isIsoInRange(iso: string, min?: string, max?: string): boolean {
  if (min && iso < min) return false
  if (max && iso > max) return false
  return true
}

/**
 * 把日期夹进可选区间（含端点）。
 * 带上下界的日历在键盘导航时必须先夹再落焦：直接移到禁选日会让 roving tabindex 指向一个
 * disabled 按钮（.focus() 无效），焦点环停在旧格而状态已前进，网格随后不可达。
 */
export function clampIsoDate(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min
  if (max && iso > max) return max
  return iso
}
