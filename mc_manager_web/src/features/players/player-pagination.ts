/**
 * 玩家表手动分页切片（单一实现）。
 *
 * 表格未注册分页 feature，`getRowModel().rows` 恒为**全量**筛选结果，页码切片只能
 * 由外部完成。表头「全选当前页」需要按同一规则复算当前页 id——两处一旦各写一份，
 * 排序或分页语义变更时必然漏改其一，勾选范围会与所见不符（issue 383 同源）。
 *
 * `pageSize === -1` 表示「全部」，恒为单页。
 */
export interface PlayerPageSlice<T> {
  /** 归一化页码（越界回落到最后一页，与分页栏显示一致） */
  safePageIndex: number
  /** 总页数（「全部」档恒为 1） */
  pageCount: number
  /** 当前页数据（「全部」档即全量） */
  rows: T[]
}

export function paginatePlayerRows<T>(
  rows: T[],
  pageSize: number,
  pageIndex: number,
): PlayerPageSlice<T> {
  const pageCount = pageSize === -1 ? 1 : Math.max(1, Math.ceil(rows.length / pageSize))
  const safePageIndex = Math.min(pageIndex, pageCount - 1)
  return {
    safePageIndex,
    pageCount,
    rows:
      pageSize === -1 ? rows : rows.slice(safePageIndex * pageSize, (safePageIndex + 1) * pageSize),
  }
}
