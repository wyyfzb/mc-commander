/**
 * 审计页格式化工具 —— 时间列/详情列的人性化收口（audit-tables 行渲染共用）
 */
import { formatDateTime } from '@/lib/format'

/** 时间列：合法 ISO 走统一收口格式（MM-dd HH:mm:ss）；非法输入原样返回（保留审计原始值兜底） */
export function formatTime(iso: string): string {
  if (Number.isNaN(new Date(iso).getTime())) return iso
  return formatDateTime(iso)
}

/** 详情对象常见键的中文标签（未映射键原样展示；新增键按需补充） */
const DETAIL_KEY_LABELS: Record<string, string> = {
  reason: '原因',
  by: '操作人',
  key: '配置项',
  sizeBytes: '大小',
  name: '名称',
  id: 'ID',
}

/** 值字符串化：嵌套对象/数组降级 JSON（审计详情只出现标量，兜底） */
function detailValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * 详情列人性化：对象 →「标签: 值 · 标签: 值」；key+from+to 三件套合并为
 * 「key值: from → to」；字符串原样；空值 '-'（替代裸 JSON.stringify）
 */
export function formatAuditDetail(detail: unknown): string {
  if (detail === null || detail === undefined || detail === '') return '-'
  if (typeof detail !== 'object') return String(detail)
  const entries = Object.entries(detail as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (entries.length === 0) return '-'
  const get = (k: string) => detailValue((detail as Record<string, unknown>)[k])
  const parts: string[] = []
  if (get('from') !== '' && get('to') !== '') {
    const key = get('key')
    parts.push(key ? `${key}: ${get('from')} → ${get('to')}` : `${get('from')} → ${get('to')}`)
  }
  for (const [k, v] of entries) {
    if (k === 'from' || k === 'to' || (k === 'key' && get('from') !== '')) continue
    const label = DETAIL_KEY_LABELS[k] ?? k
    const value = detailValue(v)
    if (value) parts.push(`${label}: ${value}`)
  }
  return parts.join(' · ')
}
