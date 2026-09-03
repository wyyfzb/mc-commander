/**
 * 格式化工具（纯函数可单测）
 */

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 运行时长：>1天「Xd Xh」/>1小时「Xh Ym」/否则「Xm」；null 表示未运行 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return '未运行'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days >= 1) return `${days}d ${hours}h`
  if (hours >= 1) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** 启动时间：MM-dd HH:mm 本地时区；缺失/非法返回 emptyText（默认 '--'） */
export function formatStartTime(
  iso: string | null | undefined,
  emptyText = '--',
): string {
  if (!iso) return emptyText
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return emptyText
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / N天前；空值/非法返回 emptyText（默认「未知」） */
export function formatRelativeTime(
  iso: string | null | undefined,
  now = Date.now(),
  emptyText = '未知',
): string {
  if (!iso) return emptyText
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return emptyText
  const diffMs = now - t
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

/** 含秒时刻：MM-dd HH:mm:ss 本地时区；缺失/非法返回 emptyText */
export function formatDateTime(
  iso: string | null | undefined,
  emptyText = '--',
): string {
  if (!iso) return emptyText
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return emptyText
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 完整时刻：YYYY-MM-DD HH:mm:ss 本地时区；缺失/非法返回 emptyText */
export function formatFullDateTime(
  iso: string | null | undefined,
  emptyText = '--',
): string {
  if (!iso) return emptyText
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return emptyText
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

/** 完整日期到分：YYYY-MM-DD HH:mm 本地时区；缺失/非法返回 emptyText */
export function formatFullDateMinute(
  iso: string | null | undefined,
  emptyText = '--',
): string {
  if (!iso) return emptyText
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return emptyText
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  )
}

/** 时刻 HH:mm 本地时区；缺失/非法返回 emptyText */
export function formatClock(
  iso: string | null | undefined,
  emptyText = '--',
): string {
  if (!iso) return emptyText
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return emptyText
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * SQLite CURRENT_TIMESTAMP（UTC 无时区标记，如 "2026-08-15 01:05:00"）→ 本地 MM-dd HH:mm。
 * 兼容已带 T（含时区标记）的 ISO 输入；解析失败原样返回输入（展示服务端原始值兜底）。
 */
export function formatUtcNaive(utcNaive: string): string {
  const d = new Date(
    utcNaive.includes('T') ? utcNaive : `${utcNaive.replace(' ', 'T')}Z`,
  )
  if (Number.isNaN(d.getTime())) return utcNaive
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 通知时间：今天 HH:mm / 昨天 HH:mm / 更早 MM-dd HH:mm */
export function formatNotificationTime(timestamp: number, now = Date.now()): string {
  const d = new Date(timestamp)
  const n = new Date(now)
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  const yesterday = new Date(now - 86400_000)
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  const hh = pad2(d.getHours())
  const mi = pad2(d.getMinutes())
  if (sameDay) return `${hh}:${mi}`
  if (isYesterday) return `昨天 ${hh}:${mi}`
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  return `${mm}-${dd} ${hh}:${mi}`
}

/** 日志导出文件名：mc_server_log_YYYYMMDD_HHMMSS.txt */
export function formatLogFileName(d = new Date()): string {
  return (
    `mc_server_log_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.txt`
  )
}

/** 世界时间 tick（0-24000）→ 时段中文名 */
export function worldTimePhase(worldTime: number | null | undefined): string {
  if (worldTime == null) return '--'
  const t = ((worldTime % 24000) + 24000) % 24000
  if (t < 3000) return '白天'
  if (t < 9000) return '正午'
  if (t < 13000) return '黄昏'
  if (t < 18000) return '夜晚'
  return '午夜'
}

/** 秒基聚合分解共享核心（负值按 0 处理）：formatDurationSec/Full 两套输出语义共用 */
function decomposeSeconds(sec: number): { h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(sec))
  return {
    h: Math.floor(total / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  }
}

/** 短时长（毫秒基）：<1s 「Nms」/ 否则秒保留一位「X.Xs」；null/undefined → emptyText（默认 '-'） */
export function formatDurationMs(
  ms: number | null | undefined,
  emptyText = '-',
): string {
  if (ms == null) return emptyText
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 短时长（秒基聚合）：Xh Ym / Xm Ys / Xs */
export function formatDurationSec(sec: number): string {
  const { h, m, s } = decomposeSeconds(sec)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** 完整时长（秒基中文聚合）：X 时 Y 分 / X 分 Y 秒 / X 秒 */
export function formatDurationSecFull(sec: number): string {
  const { h, m, s } = decomposeSeconds(sec)
  if (h > 0) return `${h} 时 ${m} 分`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}
