/**
 * 文件域纯函数工具（与组件分离，规避 fast-refresh only-export-components）
 * - formatFileSize：B / KB / MB 一位小数
 * - formatModifiedAt：MM-DD HH:mm 本地时区；非法时间返回 '-'
 * - fileIconName：文件类型 → 图标名（扩展名映射；目录恒为 folder）
 */
import type { FileEntry } from '@/api/types'

/** 文件大小格式化：B / KB / MB 一位小数 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 修改时间格式化：MM-DD HH:mm 本地时区；非法时间返回 '-' */
export function formatModifiedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 文件类型 → 图标名（扩展名映射；目录恒为 folder） */
export function fileIconName(entry: Pick<FileEntry, 'name' | 'isDirectory'>): string {
  if (entry.isDirectory) return 'folder'
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'properties' || ext === 'txt' || ext === 'log') return 'file-text'
  if (ext === 'json') return 'braces'
  if (ext === 'yml' || ext === 'yaml') return 'settings'
  if (ext === 'jar') return 'archive'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif') return 'image'
  return 'file'
}
