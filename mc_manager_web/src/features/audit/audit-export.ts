/**
 * 审计日志 & 命令历史 Excel 导出（浏览器端 exceljs 生成，复用玩家数据导出范式）
 * 审计日志文件名「审计日志_yyyyMMdd_HHmm.xlsx」；命令历史「命令历史_yyyyMMdd_HHmm.xlsx」
 * 条数上限 AUDIT_EXPORT_MAX_ROWS=1000（时间最新优先）
 * 分页循环拉取（服务端零改动）：审计日志恒以 order=desc 取数保证截断时保留时间最新的记录，
 * 写入工作表前按页面当前排序口径回排（asc 反转）；
 * 命令历史服务端固定最新优先（无 order 参数），导出内容与服务端返回顺序一致（issue 403）
 */
import { apiGetAuditLogsPage, apiGetCommandHistoryPage, type AuditQueryParams } from '@/api/audit'
import type { ConnectionConfig } from '@/api/client'
import type { AuditLogItem, CommandHistoryItem } from '@/api/types'
import { formatDurationMs, formatFullDateTime } from '@/lib/format'
import { getActionLabel } from './action-labels'

export const AUDIT_EXPORT_MAX_ROWS = 1000

/** 单页拉取条数：取服务端 pageSize 上限，减少往返次数 */
const EXPORT_PAGE_SIZE = 200

/** 详情摘要截断长度：对象/长文本序列化后超长截断，避免单元格膨胀 */
const DETAIL_SUMMARY_MAX = 200

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 文件名「审计日志_yyyyMMdd_HHmm.xlsx」（导出触发与文件名生成均有测试覆盖） */
export function buildAuditExportFilename(date: Date): string {
  return `审计日志_${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}.xlsx`
}

/** 文件名「命令历史_yyyyMMdd_HHmm.xlsx」（与审计日志同约定，issue 403） */
export function buildCommandExportFilename(date: Date): string {
  return `命令历史_${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}.xlsx`
}

/** 目标列：与页面展示同构（targetType: targetId；无目标为空） */
function targetText(item: AuditLogItem): string {
  if (!item.targetType) return ''
  return item.targetId ? `${item.targetType}: ${item.targetId}` : item.targetType
}

/** 详情摘要：对象序列化 / 长文本截断；空值返回空串 */
function detailSummary(detail: unknown): string {
  if (detail == null) return ''
  const text = typeof detail === 'object' ? JSON.stringify(detail) : String(detail)
  return text.length > DETAIL_SUMMARY_MAX ? `${text.slice(0, DETAIL_SUMMARY_MAX)}…` : text
}

/** 按页面当前排序口径排列导出行（asc 反转为时间正序，与用户所见一致）；恒返回副本不改原数组 */
export function arrangeRowsForExport(rows: AuditLogItem[], order: 'asc' | 'desc'): AuditLogItem[] {
  return order === 'asc' ? [...rows].reverse() : [...rows]
}

/** 按当前筛选条件分页循环拉取（恒以 desc 取数，截断时保留时间最新的记录），上限 1000 条 */
export async function fetchAuditExportRows(
  config: ConnectionConfig,
  params: AuditQueryParams,
): Promise<AuditLogItem[]> {
  const rows: AuditLogItem[] = []
  let page = 1
  let totalPages = 1
  while (rows.length < AUDIT_EXPORT_MAX_ROWS && page <= totalPages) {
    const res = await apiGetAuditLogsPage(config, {
      ...params,
      order: 'desc',
      page,
      pageSize: EXPORT_PAGE_SIZE,
    })
    rows.push(...res.data)
    totalPages = res.pagination?.totalPages ?? 1
    page += 1
  }
  return rows.slice(0, AUDIT_EXPORT_MAX_ROWS)
}

/**
 * 按当前筛选条件分页循环拉取命令历史，上限 1000 条（issue 403）。
 * 与审计日志同口径（pageSize 200 / 耗尽即停 / 截断保留时间最新的记录）；
 * 不传 order：服务端固定 ORDER BY id DESC（最新优先），导出与页面所见一致。
 */
export async function fetchCommandExportRows(
  config: ConnectionConfig,
  params: AuditQueryParams,
): Promise<CommandHistoryItem[]> {
  const rows: CommandHistoryItem[] = []
  let page = 1
  let totalPages = 1
  while (rows.length < AUDIT_EXPORT_MAX_ROWS && page <= totalPages) {
    const res = await apiGetCommandHistoryPage(config, {
      ...params,
      page,
      pageSize: EXPORT_PAGE_SIZE,
    })
    rows.push(...res.data)
    totalPages = res.pagination?.totalPages ?? 1
    page += 1
  }
  return rows.slice(0, AUDIT_EXPORT_MAX_ROWS)
}

/** 生成并下载审计日志 Excel（5 列：时间/操作/来源/目标/详情摘要） */
export async function exportAuditLogsToExcel(
  config: ConnectionConfig,
  params: AuditQueryParams,
  order: 'asc' | 'desc',
): Promise<void> {
  const fetched = await fetchAuditExportRows(config, params)
  const rows = arrangeRowsForExport(fetched, order)

  // exceljs 约 900KB：按需加载，避免整块计入审计页首访体积（只有点导出才付这份代价）
  const exceljs = await import('exceljs')
  const workbook = new exceljs.Workbook()
  const sheet = workbook.addWorksheet('审计日志')

  sheet.columns = [
    { header: '时间', key: 'createdAt', width: 20 },
    { header: '操作', key: 'action', width: 16 },
    { header: '来源', key: 'source', width: 10 },
    { header: '目标', key: 'target', width: 24 },
    { header: '详情摘要', key: 'detail', width: 48 },
  ]

  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }

  for (const item of rows) {
    sheet.addRow({
      // 服务端下发 ISO8601，导出按本地时区格式化到秒（与页面时间列同口径；
      // 直写 ISO 会让列宽溢出且带 Z 后缀，人类阅读/Excel 排序都不友好）
      createdAt: formatFullDateTime(item.createdAt),
      action: getActionLabel(item.action),
      source: item.source,
      target: targetText(item),
      detail: detailSummary(item.detail),
    })
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = buildAuditExportFilename(new Date())
  anchor.click()
  URL.revokeObjectURL(url)
}

/** 生成并下载命令历史 Excel（5 列：时间/命令/结果/来源/耗时，与 CmdHeader 一致，issue 403） */
export async function exportCommandHistoryToExcel(
  config: ConnectionConfig,
  params: AuditQueryParams,
): Promise<void> {
  const rows = await fetchCommandExportRows(config, params)

  // exceljs 约 900KB：按需加载（同 exportAuditLogsToExcel）
  const exceljs = await import('exceljs')
  const workbook = new exceljs.Workbook()
  const sheet = workbook.addWorksheet('命令历史')

  sheet.columns = [
    { header: '时间', key: 'createdAt', width: 20 },
    { header: '命令', key: 'command', width: 48 },
    { header: '结果', key: 'result', width: 8 },
    { header: '来源', key: 'source', width: 10 },
    { header: '耗时', key: 'duration', width: 10 },
  ]

  sheet.getRow(1).font = { bold: true }

  for (const item of rows) {
    sheet.addRow({
      createdAt: formatFullDateTime(item.createdAt),
      command: item.command,
      result: item.success ? '成功' : '失败',
      source: item.source,
      duration: formatDurationMs(item.durationMs),
    })
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = buildCommandExportFilename(new Date())
  anchor.click()
  URL.revokeObjectURL(url)
}
