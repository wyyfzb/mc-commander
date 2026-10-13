/**
 * 审计日志 & 命令历史导出工具单测（issue 384 / issue 403）
 * mock @/api/audit 捕获分页拉取入参 + 拦截 write-excel-file 断言工作表数据与下载文件名：
 * - 文件名生成：审计日志/命令历史_yyyyMMdd_HHmm.xlsx 格式
 * - 分页循环拉取：上限 1000 条（5 页 × 200 即停）、数据耗尽即停、审计日志恒以 desc 取数、
 *   命令历史不传 order（服务端固定最新优先）
 * - 排序回排：asc 反转（与页面所见一致）、desc 保持、原数组不被修改
 * - 端到端：工作表名 + 表头 + 行构造（时间列本地时区格式化到秒；命令历史结果列 成功/失败
 *   文本 + 耗时格式化）+ 下载文件名
 * 全部数据为虚构占位，无真实服务器信息。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  arrangeRowsForExport,
  buildAuditExportFilename,
  buildCommandExportFilename,
  exportAuditLogsToExcel,
  exportCommandHistoryToExcel,
  fetchAuditExportRows,
  fetchCommandExportRows,
  AUDIT_EXPORT_MAX_ROWS,
} from '@/features/audit/audit-export'
import type { AuditLogItem, CommandHistoryItem } from '@/api/types'

const { pageImpl, cmdPageImpl, writeXlsxFileMock } = vi.hoisted(() => ({
  pageImpl: { current: (() => null) as (...args: unknown[]) => unknown },
  cmdPageImpl: { current: (() => null) as (...args: unknown[]) => unknown },
  writeXlsxFileMock: vi.fn((..._args: unknown[]) => ({ toBlob: vi.fn(), toFile: vi.fn() })),
}))

vi.mock('@/api/audit', () => ({
  apiGetAuditLogsPage: (...args: unknown[]) => pageImpl.current(...args),
  apiGetCommandHistoryPage: (...args: unknown[]) => cmdPageImpl.current(...args),
}))

vi.mock('write-excel-file/browser', () => ({ default: writeXlsxFileMock }))

const config = { baseUrl: 'http://test.local', apiKey: 'k-test' } as Parameters<
  typeof fetchAuditExportRows
>[0]

type Cell = { value?: unknown }
type SheetOptions = { sheet?: string; columns?: { width?: number }[] }

/** 取最近一次导出传给库的工作表数据与该次工作表选项 */
function lastCall(): { data: Cell[][]; options: SheetOptions } {
  const call = writeXlsxFileMock.mock.calls.at(-1)
  expect(call).toBeDefined()
  return { data: call![0] as Cell[][], options: call![1] as SheetOptions }
}
/** 取最近一次导出请求的下载文件名（库的 toFile 在每次调用时新建，故从返回值上取） */
function lastFileName(): string {
  const result = writeXlsxFileMock.mock.results.at(-1)?.value as { toFile: (name: string) => void }
  const spy = vi.mocked(result.toFile)
  expect(spy).toHaveBeenCalledTimes(1)
  return spy.mock.calls[0]![0]
}

/** 行内第 n 列（1-based，与表格列号一致）的值 */
function column(data: Cell[][], rowIndex: number, columnNumber: number): unknown {
  return data[rowIndex]![columnNumber - 1]!.value
}

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

  it('端到端导出：工作表名 + 表头 + 时间列本地时区格式化 + 下载文件名约定', async () => {
    pageImpl.current = () => {
      return { data: mkRows(1, 2), pagination: { page: 1, totalPages: 1, total: 2 } }
    }
    await exportAuditLogsToExcel(config, {}, 'desc')

    const { data, options } = lastCall()
    expect(options.sheet).toBe('审计日志')
    expect(data[0]!.map((cell) => cell.value)).toEqual(['时间', '操作', '来源', '目标', '详情摘要'])
    expect(data).toHaveLength(3)
    // 时间列：服务端下发 ISO8601，导出须按本地时区格式化到秒（直写原串会带 T/Z 且溢出列宽）
    expect(column(data, 1, 1)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(lastFileName()).toMatch(/^审计日志_\d{8}_\d{4}\.xlsx$/)
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
      return {
        data: Array.from({ length: 200 }, (_, i) => mkCmdRow((p.page - 1) * 200 + i)),
        pagination: { page: p.page, totalPages: 6, total: 1200 },
      }
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
      return {
        data: Array.from({ length: p.page === 3 ? 50 : 200 }, (_, i) => mkCmdRow(i)),
        pagination: { page: p.page, totalPages: 3, total: 450 },
      }
    }
    const rows = await fetchCommandExportRows(config, {})
    expect(calls).toBe(3)
    expect(rows).toHaveLength(450)
  })

  it('端到端导出：行构造五列（结果/耗时映射）+ 工作表名 + 文件名「命令历史_*」', async () => {
    cmdPageImpl.current = () => ({
      data: [mkCmdRow(0), mkCmdRow(1), mkCmdRow(2)],
      pagination: { page: 1, totalPages: 1, total: 3 },
    })
    await exportCommandHistoryToExcel(config, {})

    const { data, options } = lastCall()
    expect(options.sheet).toBe('命令历史')
    expect(column(data, 0, 2)).toBe('命令')
    expect(data).toHaveLength(4)
    // seq 0：成功 + 1.5s；seq 1：失败 + null 耗时 → '-'；seq 2：成功
    expect(column(data, 1, 3)).toBe('成功')
    expect(column(data, 1, 5)).toBe('1.5s')
    expect(column(data, 2, 3)).toBe('失败')
    expect(column(data, 2, 5)).toBe('-')
    expect(column(data, 2, 2)).toBe('say hello-1')
    expect(column(data, 3, 3)).toBe('成功')
    // 时间列同审计日志：本地时区格式化到秒，非原样 ISO
    expect(column(data, 1, 1)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(lastFileName()).toMatch(/^命令历史_\d{8}_\d{4}\.xlsx$/)
  })
})
