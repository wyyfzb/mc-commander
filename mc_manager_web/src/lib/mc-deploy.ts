/**
 * 部署/实例静态数据
 * - SERVER_TYPES：5 种服务端类型 + 中文标签
 * - recommendedJavaVersion：版本 → Java 版本推荐
 * - 任务类型标签与状态色
 */

/** 服务端类型（deploy 端点 validTypes） */
export const SERVER_TYPES = ['vanilla', 'paper', 'fabric', 'forge', 'purpur'] as const
export type ServerType = (typeof SERVER_TYPES)[number]

/** 服务端类型中文标签 */
export const SERVER_TYPE_LABELS: Record<ServerType, string> = {
  vanilla: '原版 (Vanilla)',
  paper: 'Paper',
  fabric: 'Fabric',
  forge: 'Forge',
  purpur: 'Purpur',
}

/**
 * MC 版本 → 推荐 Java 版本
 * 26.x（major≥20，新版版本号体系）→ 25；1.21+/1.20.5+ → 21；1.17+ → 17；1.7+ → 8；其余 → 17
 */
export function recommendedJavaVersion(mcVersion: string | null | undefined): string {
  if (mcVersion == null || mcVersion.length === 0) return '未知'
  const parts = mcVersion
    .split('.')
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => !Number.isNaN(n))
  if (parts.length === 0) return '17'
  const major = parts[0] ?? 0
  const minor = parts.length > 1 ? (parts[1] ?? 0) : 0
  const patch = parts.length > 2 ? (parts[2] ?? 0) : 0

  if (major >= 20) return '25'
  if (major === 1 && minor >= 21) return '21'
  if (major === 1 && minor === 20 && patch >= 5) return '21'
  if (major === 1 && minor >= 17) return '17'
  if (major === 1 && minor >= 7) return '8'
  return '17'
}

/**
 * 版本列表本地缓存 fallback（硬编码）
 * 远程版本服务不可用时仍可部署；默认首个 1.21.4
 */
export const FALLBACK_VERSIONS = [
  '1.21.4',
  '1.21.3',
  '1.21.1',
  '1.20.6',
  '1.20.4',
  '1.20.1',
  '1.19.4',
  '1.18.2',
] as const

// ── 定时任务类型 ──

/** 任务类型（服务端 validTypes） */
export const TASK_TYPES = ['restart', 'backup', 'command', 'stop', 'start'] as const
export type TaskType = (typeof TASK_TYPES)[number]

/** 任务类型中文标签 */
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  restart: '重启',
  backup: '备份',
  command: '命令',
  stop: '停止',
  start: '启动',
}

/** 任务类型下拉完整标签 */
export const TASK_TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: 'restart', label: '重启服务器' },
  { value: 'backup', label: '创建备份（世界+配置+插件）' },
  { value: 'command', label: '执行命令' },
  { value: 'stop', label: '停止服务器' },
  { value: 'start', label: '启动服务器' },
]

/** 任务类型 → 状态色 tone（restart→warning/backup→info/command→purple/stop→error/start→success） */
export type TaskTypeTone = 'warning' | 'info' | 'purple' | 'error' | 'success'

export const TASK_TYPE_TONES: Record<TaskType, TaskTypeTone> = {
  restart: 'warning',
  backup: 'info',
  command: 'purple',
  stop: 'error',
  start: 'success',
}

/** 任务时间格式化：MM-DD HH:mm 本地时区；null/非法 → '从未' */
export function formatTaskDate(iso: string | null | undefined): string {
  if (iso == null || iso.length === 0) return '从未'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '从未'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 下次执行倒计时文案（分钟级粒度，配合 useNow 每分钟刷新）：
 * 不足 1 分钟按 1m 计（向上取整，避免展示 0m）；≥24h 进到天级；已过期为「已过期」；
 * null/非法返回 null（调用方保持「从未」兜底）
 */
export function formatNextRunCountdown(iso: string | null | undefined, now: number): string | null {
  if (iso == null || iso.length === 0) return null
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return null
  const diff = target - now
  if (diff <= 0) return '已过期'
  const totalMinutes = Math.ceil(diff / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m 后`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) return `${hours}h ${minutes}m 后`
  return `${Math.floor(hours / 24)}d ${hours % 24}h 后`
}
