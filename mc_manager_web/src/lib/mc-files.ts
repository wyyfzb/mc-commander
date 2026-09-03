/**
 * 文件域纯函数工具（与组件分离，规避 fast-refresh only-export-components）
 * - formatFileSize：B / KB / MB 一位小数
 * - formatModifiedAt：MM-DD HH:mm 本地时区；非法时间返回 '-'
 * - fileIconName：文件类型 → 图标名（扩展名映射；目录恒为 folder）
 * - isBinaryFileName / isEditableFile：二进制文件判定（feat-9 编辑保护）
 */
import type { FileEntry } from '@/api/types'
import { formatStartTime } from './format'

/** 文件大小格式化：B / KB / MB 一位小数 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 修改时间格式化：MM-DD HH:mm 本地时区；非法时间返回 '-'（收口复用 lib/format） */
export function formatModifiedAt(iso: string): string {
  return formatStartTime(iso, '-')
}

/** 文件类型 → 图标名（扩展名映射；目录恒为 folder） */
export function fileIconName(entry: Pick<FileEntry, 'name' | 'isDirectory'>): string {
  if (entry.isDirectory) return 'folder'
  const ext = fileExtension(entry.name)
  if (ext === 'properties' || ext === 'txt' || ext === 'log') return 'file-text'
  if (ext === 'json') return 'braces'
  if (ext === 'yml' || ext === 'yaml') return 'settings'
  if (ext === 'jar') return 'archive'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif') return 'image'
  return 'file'
}

/** 扩展名提取（小写、无点；无扩展名返回空串） */
function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  // 隐藏文件（.gitignore）与无扩展名文件均无可用扩展名
  if (idx <= 0) return ''
  return name.slice(idx + 1).toLowerCase()
}

/**
 * 已知二进制扩展名黑名单（feat-9）：
 * 前端按扩展名启发式判断（服务端 /content 是内容级 NUL 检测，前端拿不到字节），
 * 黑名单方向保守——误禁文本文件的编辑只是少了便利（仍可下载本地编辑后上传），
 * 误放二进制文件进编辑器则会误导用户保存空内容（服务端会拒绝，但体验已受损）。
 * 覆盖：归档/压缩、图片、字体、音视频、可执行与 MC 特有二进制（region 存档等）。
 */
const BINARY_EXTENSIONS = new Set([
  // 归档与压缩（jar 本质是 zip）
  'jar', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'lz4', 'zst',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff',
  // 字体
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // 音视频
  'mp3', 'mp4', 'ogg', 'wav', 'flac', 'webm', 'mkv', 'mov', 'avi',
  // 可执行 / 库 / 文档
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'msi', 'deb', 'rpm', 'pdf',
  // MC 特有二进制：level.dat（NBT）、region 存档、基岩版 leveldb、备份快照
  'dat', 'dat_old', 'mca', 'mcr', 'ldb', 'pac',
])

/** 已知二进制文件（按扩展名黑名单；无扩展名 / 未收录扩展名视为可编辑） */
export function isBinaryFileName(name: string): boolean {
  return BINARY_EXTENSIONS.has(fileExtension(name))
}

/** 该文件是否可进文本编辑器（目录不可；二进制扩展名不可——下载到本地处理） */
export function isEditableFile(entry: Pick<FileEntry, 'name' | 'isDirectory'>): boolean {
  return !entry.isDirectory && !isBinaryFileName(entry.name)
}
