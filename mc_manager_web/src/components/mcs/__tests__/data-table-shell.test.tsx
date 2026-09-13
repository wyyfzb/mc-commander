/**
 * DataTableShell 骨架列宽契约：
 * skeletonWidths 是**宽度 class 数组**（props 文档口径），必须落在 className 上——
 * 历史实现塞进 `style={{ width }}`，浏览器把 'w-20' 当非法长度丢弃，
 * 审计页两张表的骨架列宽整体失效（表现为每列等宽铺满）。
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
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
