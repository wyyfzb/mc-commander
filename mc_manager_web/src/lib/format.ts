/**
 * 格式化工具（纯函数可单测）
 */

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

/** 启动时间：MM-dd HH:mm 本地时区；缺失返回 '--' */
export function formatStartTime(iso: string | null | undefined): string {
  if (!iso) return '--'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--'
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

/** 相对时间：刚刚 / N分钟前 / N小时前 / N天前；无数据「未知」 */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '未知'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '未知'
  const diffMs = now - t
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
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
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mi}`
  if (isYesterday) return `昨天 ${hh}:${mi}`
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

/** 日志导出文件名：mc_server_log_YYYYMMDD_HHMMSS.txt */
export function formatLogFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `mc_server_log_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`
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
