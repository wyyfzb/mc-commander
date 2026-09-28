/**
 * 分页切片单一实现的契约测试（I1：两处公式合一）
 * 关键语义：pageSize=-1「全部」恒单页；页码越界回落到最后一页而非空集
 * （表头「全选当前页」与分页栏显示必须同源，否则勾选范围与所见不符）。
 */
import { describe, it, expect } from 'vitest'
import { paginatePlayerRows } from '../player-pagination'

const rows = Array.from({ length: 25 }, (_, i) => i)

describe('paginatePlayerRows', () => {
  it('按 pageSize 切片，页码从 0 起', () => {
    expect(paginatePlayerRows(rows, 10, 0).rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(paginatePlayerRows(rows, 10, 1).rows).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(paginatePlayerRows(rows, 10, 2).rows).toEqual([20, 21, 22, 23, 24])
  })

  it('pageCount 向上取整，恒 ≥1（空集也是 1 页）', () => {
    expect(paginatePlayerRows(rows, 10, 0).pageCount).toBe(3)
    expect(paginatePlayerRows(rows, 20, 0).pageCount).toBe(2)
    expect(paginatePlayerRows([], 10, 0).pageCount).toBe(1)
  })

  it('pageSize=-1「全部」：单页且返回全量原数组', () => {
    const r = paginatePlayerRows(rows, -1, 0)
    expect(r.pageCount).toBe(1)
    expect(r.safePageIndex).toBe(0)
    expect(r.rows).toBe(rows)
  })

  it('页码越界回落到最后一页（与分页栏显示同源，不返回空集）', () => {
    const r = paginatePlayerRows(rows, 10, 99)
    expect(r.safePageIndex).toBe(2)
    expect(r.rows).toEqual([20, 21, 22, 23, 24])
    // 刚好越界一页同样回落
    expect(paginatePlayerRows(rows, 10, 3).safePageIndex).toBe(2)
  })

  it('恰好整除时不产生空尾页', () => {
    const r = paginatePlayerRows(rows, 5, 5)
    expect(r.pageCount).toBe(5)
    expect(r.safePageIndex).toBe(4)
    expect(r.rows).toEqual([20, 21, 22, 23, 24])
  })
})
