/**
 * 审计日志 & 命令历史导出工具单测（issue 384 / issue 403）
 * mock @/api/audit 捕获分页拉取入参 + stub 下载链路（createObjectURL / anchor click）：
 * - 文件名生成：审计日志/命令历史_yyyyMMdd_HHmm.xlsx 格式
 * - 分页循环拉取：上限 1000 条（5 页 × 200 即停）、数据耗尽即停、审计日志恒以 desc 取数、
 *   命令历史不传 order（服务端固定最新优先）
 * - 排序回排：asc 反转（与页面所见一致）、desc 保持、原数组不被修改
 * - 端到端：Blob 构造 + anchor.download 文件名 + 触发点击 + 释放 URL；
 *   时间列（本地时区格式化到秒）与命令历史行构造（结果列 成功/失败 文本 + 耗时格式化）
 *   经 ExcelJS 读回验证
 * 全部数据为虚构占位，无真实服务器信息。
 */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest'
import ExcelJS from 'exceljs'
import {
  arrangeRowsForExport,
  buildAuditExportFilename,
  buildCommandExportFilename,
  exportAuditLogsToExcel,
  exportCommandHistoryToExcel,
  fetchAuditExportRows,
  fetchCommandExportRows,
  AUDIT_EXPORT_MAX_ROWS,
} from '../audit-export'
import type { AuditLogItem, CommandHistoryItem } from '@/api/types'

const { pageImpl, cmdPageImpl } = vi.hoisted(() => ({
  pageImpl: { current: (() => null) as (...args: unknown[]) => unknown },
  cmdPageImpl: { current: (() => null) as (...args: unknown[]) => unknown },
}))

vi.mock('@/api/audit', () => ({
  apiGetAuditLogsPage: (...args: unknown[]) => pageImpl.current(...args),
  apiGetCommandHistoryPage: (...args: unknown[]) => cmdPageImpl.current(...args),
}))

const config = { baseUrl: 'http://test.local', apiKey: 'k-test' } as Parameters<typeof fetchAuditExportRows>[0]

/** 构造单条记录（seq 递减模拟 desc 时间序：seq 越大越旧） */
function mkRow(seq: number): AuditLogItem {
  return {
    id: 10000 - seq,
    instanceId: null,
    action: 'INSTANCE_START',
    targetType: 'instance',
    targetId: `srv-${seq}`,
    detail: seq % 2 === 0 ? { reason: 'manual', seq } : null,
    source: 'api',
    createdAt: '2026-09-03T20:00:00.000Z',
  }
}

/** 构造第 p 页（每页 size 条） */
function mkRows(page: number, size: number): AuditLogItem[] {
  return Array.from({ length: size }, (_, i) => mkRow((page - 1) * size + i))
}

function envelope(page: number, totalPages: number, total: number) {
  return {
    data: mkRows(page, page < totalPages ? 200 : 50),
    pagination: { page, totalPages, total },
  }
}

beforeAll(() => {
  // jsdom 未实现 Blob URL 与 anchor 下载语义，stub 并记录调用
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock-url'),
    revokeObjectURL: vi.fn(),
  })
  HTMLAnchorElement.prototype.click = vi.fn()
})

afterEach(() => {
  vi.clearAllMocks()
})

/** 构造单条命令历史（seq 递减模拟 desc 时间序；奇数序失败 + null 耗时覆盖两态） */
function mkCmdRow(seq: number): CommandHistoryItem {
  return {
    id: 20000 - seq,
    instanceId: null,
    command: `say hello-${seq}`,
    source: 'web',
    success: seq % 2 === 0,
    response: null,
    durationMs: seq % 3 === 1 ? null : 1500,
    createdAt: '2026-09-03T21:00:00.000Z',
  }
}

describe('审计导出工具（issue 384）', () => {
  it('buildAuditExportFilename 生成「审计日志_yyyyMMdd_HHmm.xlsx」', () => {
    const name = buildAuditExportFilename(new Date(2026, 8, 3, 20, 5)) // 2026-09-03 20:05
    expect(name).toBe('审计日志_20260903_2005.xlsx')
  })

  it('分页循环拉取：达到 1000 条上限即停（5 页 × 200），恒以 desc 取数', async () => {
    pageImpl.current = (_config, params) => {
      const p = params as { page: number; order?: string; pageSize?: number }
      expect(p.pageSize).toBe(200)
      expect(p.order).toBe('desc')
      return envelope(p.page, 6, 1200)
    }
    const rows = await fetchAuditExportRows(config, { action: 'INSTANCE_START' })
    expect(rows).toHaveLength(AUDIT_EXPORT_MAX_ROWS)
    expect(rows[0]!.targetId).toBe('srv-0')
  })

  it('分页循环拉取：数据耗尽即停（450 条 = 3 页）', async () => {
    let calls = 0
    pageImpl.current = (_configArg, params) => {
      calls += 1
      const p = params as { page: number }
      return envelope(p.page, 3, 450)
    }
    const rows = await fetchAuditExportRows(config, {})
    expect(calls).toBe(3)
    expect(rows).toHaveLength(450)
  })

  it('arrangeRowsForExport：asc 反转与页面所见一致，desc 保持，不改原数组', () => {
    const original: AuditLogItem[] = [mkRow(0), mkRow(1), mkRow(2)]
    const asc = arrangeRowsForExport(original, 'asc')
    expect(asc.map((r) => r.id)).toEqual([10000, 9999, 9998].slice().reverse())
    expect(original.map((r) => r.id)).toEqual([10000, 9999, 9998])
    const desc = arrangeRowsForExport(original, 'desc')
    expect(desc.map((r) => r.id)).toEqual([10000, 9999, 9998])
    expect(desc).not.toBe(original)
  })

  it('端到端导出：构造 Blob + anchor.download 文件名 + 触发点击 + 释放 URL', async () => {
    pageImpl.current = () => {
      return { data: mkRows(1, 2), pagination: { page: 1, totalPages: 1, total: 2 } }
    }
    await exportAuditLogsToExcel(config, {}, 'desc')

    const createObjectURL = URL.createObjectURL as ReturnType<typeof vi.fn>
    const revokeObjectURL = URL.revokeObjectURL as ReturnType<typeof vi.fn>
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blobArg = createObjectURL.mock.calls[0]![0] as Blob
    expect(blobArg).toBeInstanceOf(Blob)
    expect(blobArg.type).toContain('spreadsheetml')

    const click = HTMLAnchorElement.prototype.click as ReturnType<typeof vi.fn>
    expect(click).toHaveBeenCalledTimes(1)
    // 下载文件名符合「审计日志_yyyyMMdd_HHmm.xlsx」约定
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toMatch(/^审计日志_\d{8}_\d{4}\.xlsx$/)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')

    // 时间列：服务端下发 ISO8601，导出须按本地时区格式化到秒（直写原串会带 T/Z 且溢出列宽）
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blobArg.arrayBuffer())
    const sheet = wb.getWorksheet('审计日志')!
    expect(sheet.getRow(1).getCell(1).value).toBe('时间')
    expect(sheet.getRow(2).getCell(1).value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('命令历史导出工具（issue 403）', () => {
  it('buildCommandExportFilename 生成「命令历史_yyyyMMdd_HHmm.xlsx」', () => {
    const name = buildCommandExportFilename(new Date(2026, 8, 4, 8, 30)) // 2026-09-04 08:30
    expect(name).toBe('命令历史_20260904_0830.xlsx')
  })

  it('分页循环拉取：上限 1000 即停，不传 order（服务端固定最新优先），pageSize 200', async () => {
    cmdPageImpl.current = (_config, params) => {
      const p = params as { page: number; pageSize?: number; order?: string }
      expect(p.pageSize).toBe(200)
      expect('order' in p).toBe(false) // 命令历史无 order 语义：不传该键
      return { data: Array.from({ length: 200 }, (_, i) => mkCmdRow((p.page - 1) * 200 + i)), pagination: { page: p.page, totalPages: 6, total: 1200 } }
    }
    const rows = await fetchCommandExportRows(config, { startTime: '2026-01-01T00:00:00Z' })
    expect(rows).toHaveLength(AUDIT_EXPORT_MAX_ROWS)
    expect(rows[0]!.id).toBe(20000) // 最新优先：第一条为 seq 0
    expect(rows[0]!.command).toBe('say hello-0')
  })

  it('分页循环拉取：数据耗尽即停（450 条 = 3 页）', async () => {
    let calls = 0
    cmdPageImpl.current = (_configArg, params) => {
      calls += 1
      const p = params as { page: number }
      return { data: Array.from({ length: p.page === 3 ? 50 : 200 }, (_, i) => mkCmdRow(i)), pagination: { page: p.page, totalPages: 3, total: 450 } }
    }
    const rows = await fetchCommandExportRows(config, {})
    expect(calls).toBe(3)
    expect(rows).toHaveLength(450)
  })

  it('端到端导出：文件名「命令历史_*」+ 行构造五列（结果/耗时映射）经 ExcelJS 读回验证', async () => {
    cmdPageImpl.current = () => ({
      data: [mkCmdRow(0), mkCmdRow(1), mkCmdRow(2)],
      pagination: { page: 1, totalPages: 1, total: 3 },
    })
    await exportCommandHistoryToExcel(config, {})

    const click = HTMLAnchorElement.prototype.click as ReturnType<typeof vi.fn>
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toMatch(/^命令历史_\d{8}_\d{4}\.xlsx$/)

    // 读回工作簿验证行构造：表头 + 3 条数据，结果/耗时列与 CmdHeader/CmdBody 同构
    const createObjectURL = URL.createObjectURL as ReturnType<typeof vi.fn>
    const blobArg = createObjectURL.mock.calls[0]![0] as Blob
    const buffer = await blobArg.arrayBuffer()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer)
    const sheet = wb.getWorksheet('命令历史')!
    expect(sheet.getRow(1).getCell(2).value).toBe('命令')
    expect(sheet.actualRowCount).toBe(4)
    // seq 0：成功 + 1.5s；seq 1：失败 + null 耗时 → '-'；seq 2：成功
    expect(sheet.getRow(2).getCell(3).value).toBe('成功')
    expect(sheet.getRow(2).getCell(5).value).toBe('1.5s')
    expect(sheet.getRow(3).getCell(3).value).toBe('失败')
    expect(sheet.getRow(3).getCell(5).value).toBe('-')
    expect(sheet.getRow(3).getCell(2).value).toBe('say hello-1')
    expect(sheet.getRow(4).getCell(3).value).toBe('成功')
    // 时间列同审计日志：本地时区格式化到秒，非原样 ISO
    expect(sheet.getRow(2).getCell(1).value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})
