/**
 * 审计页时间范围工具
 *
 * 服务端口径（约束，勿改）：
 * - audit_logs / command_history 的 created_at 由 SQLite CURRENT_TIMESTAMP 生成，
 *   格式为 UTC「YYYY-MM-DD HH:MM:SS」（空格分隔、无时区标记、零填充）
 * - audit.model.js 按字符串比较（created_at >= / <=）过滤时间范围
 * - ISO「T」分隔格式与该口径字符串比较会失配（'T' 0x54 > ' ' 0x20，
 *   导致当日记录被错误排除），因此前端必须先换算成同格式再传参
 */

/** 本地日历日区间（yyyy-MM-dd） */
export interface TimeRange {
  start: string
  end: string
}

/** Date → 本地日历日 yyyy-MM-dd */
export function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Date → 服务器口径 UTC「YYYY-MM-DD HH:MM:SS」 */
export function toServerUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  )
}

/** 本地日历日起点（00:00:00.000）→ 服务器口径（含该日全部时刻） */
export function toServerStart(dateStr: string): string {
  return toServerUtc(new Date(`${dateStr}T00:00:00.000`))
}

/** 本地日历日终点（23:59:59.999）→ 服务器口径（秒级截断，仍含 23:59:59） */
export function toServerEnd(dateStr: string): string {
  return toServerUtc(new Date(`${dateStr}T23:59:59.999`))
}

export interface QuickRange {
  key: 'today' | '7d' | '30d'
  label: string
  /** 含今天的回溯天数偏移：today=0（单日）；7d=6（近 7 个日历日）；30d=29 */
  daysBack: number
}

export const QUICK_RANGES: QuickRange[] = [
  { key: 'today', label: '今天', daysBack: 0 },
  { key: '7d', label: '近 7 天', daysBack: 6 },
  { key: '30d', label: '近 30 天', daysBack: 29 },
]

/** 以 now 为基准计算快捷区间的本地日历日起止（跨月由 Date 构造自动回卷） */
export function quickRangeDates(daysBack: number, now: Date = new Date()): TimeRange {
  const end = localDateStr(now)
  const start = localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack))
  return { start, end }
}

/** yyyy-MM-dd 倒置校验（字符串比较与日历日序一致） */
export function isRangeInverted(start: string, end: string): boolean {
  return Boolean(start && end && start > end)
}
