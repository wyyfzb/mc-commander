/**
 * DataTableShell 骨架列宽契约：
 * skeletonWidths 是**宽度 class 数组**（props 文档口径），必须落在 className 上——
 * 历史实现塞进 `style={{ width }}`，浏览器把 'w-20' 当非法长度丢弃，
 * 审计页两张表的骨架列宽整体失效（表现为每列等宽铺满）。
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { createRef } from 'react'
import { DataTableShell } from '../data-table-shell'

const header = (
  <thead>
    <tr>
      <th>操作</th>
      <th>目标</th>
    </tr>
  </thead>
)

describe('DataTableShell 骨架', () => {
  it('skeletonWidths 作为 class 下发，不写成非法行内宽度', () => {
    const { container } = render(
      <DataTableShell
        header={header}
        columns={2}
        isLoading
        skeletonRows={1}
        skeletonWidths={['w-20', 'w-14']}
      >
        <tbody />
      </DataTableShell>,
    )

    const bars = container.querySelectorAll('[data-slot="skeleton"]')
    expect(bars).toHaveLength(2)
    expect(bars[0]).toHaveClass('w-20')
    expect(bars[1]).toHaveClass('w-14')
    for (const bar of bars) {
      expect(bar.getAttribute('style') ?? '').not.toContain('width')
    }
  })

  it('未传 skeletonWidths 时退回默认宽度类', () => {
    const { container } = render(
      <DataTableShell header={header} columns={2} isLoading skeletonRows={1}>
        <tbody />
      </DataTableShell>,
    )

    const bars = container.querySelectorAll('[data-slot="skeleton"]')
    expect(bars).toHaveLength(2)
    for (const bar of bars) {
      expect(bar).toHaveClass('w-24')
    }
  })
})

describe('DataTableShell 滚动容器与表格类', () => {
  it('scrollRef 指向壳内滚动容器（卡片面），tableClassName 合并到 table 基础配方', () => {
    const scrollRef = createRef<HTMLElement>()
    const { container } = render(
      <DataTableShell header={header} columns={2} scrollRef={scrollRef} tableClassName="table-fixed text-left">
        <tbody>
          <tr>
            <td>A</td>
            <td>B</td>
          </tr>
        </tbody>
      </DataTableShell>,
    )

    // 滚动容器 = 卡片面（overflow-auto），虚滚动的 getScrollElement 依赖它；
    // contains(table) 防将来 overflow-auto 移到内层而 ref 仍挂外层的错位回归
    expect(scrollRef.current).not.toBeNull()
    expect(scrollRef.current).toHaveClass('overflow-auto')
    const table = container.querySelector('table')
    expect(scrollRef.current?.contains(table)).toBe(true)
    expect(table).toHaveClass('w-full')
    expect(table).toHaveClass('text-mcs-sm')
    expect(table).toHaveClass('table-fixed')
    expect(table).toHaveClass('text-left')
  })
})
