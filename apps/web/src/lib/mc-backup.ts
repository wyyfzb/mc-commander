/**
 * 备份静态数据
 * - formatBackupSize：字节 → 可读大小（B/KB/MB/GB；null/<=0 → 空串；GB 2 位小数，其余 1 位）
 * - formatBackupDate：ISO → YYYY-MM-DD HH:mm 本地时区（解析失败原样返回）
 * - backupStatusLabel：completed 已就绪/failed 失败/creating 备份中/restoring 恢复中/未知原样
 * - backupStatusTone：completed success/failed error/restoring warning/其余 info
 */
import { formatFullDateMinute } from './format'

/** 字节 → 可读大小 */
export function formatBackupSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** ISO 时间 → YYYY-MM-DD HH:mm 本地时区（空值返回空串、解析失败原样返回，收口复用 lib/format） */
export function formatBackupDate(iso: string | null | undefined): string {
  if (iso == null || iso === '') return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return iso
  return formatFullDateMinute(iso)
}

/**
 * 备份状态 → 中文标签。
 * completed 用「已就绪」而非「已完成」：列表行只显示备份状态，
 * 「已完成」会让用户从其他页面切过来时困惑于「完成了什么」——
 * 「已就绪」表达该快照可用于恢复/浏览
 */
export function backupStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'completed':
      return '已就绪'
    case 'failed':
      return '失败'
    case 'creating':
      return '备份中'
    case 'restoring':
      return '恢复中'
    default:
      return status ?? ''
  }
}

/** 备份状态 → 语义 tone（success/error/warning/info） */
export function backupStatusTone(
  status: string | null | undefined,
): 'success' | 'error' | 'warning' | 'info' {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'restoring':
      return 'warning'
    default:
      return 'info'
  }
}
