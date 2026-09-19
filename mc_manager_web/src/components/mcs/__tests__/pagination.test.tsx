/**
 * Pagination 可达性语义：
 * - 当前页必须用 `aria-current="page"` 暴露：底色只是视觉线索，读屏拿不到
 *   （语义值域与全站先例一致：导航/tab 用 page，步骤条用 step）
 * - 上一页/下一页在首/末页禁用（方向语义不能靠「点了没反应」表达）
 * - prev-next 模式无页码按钮，不引入 aria-current
 * - 总页数 ≤1（含「全部」档、空结果）不渲染翻页控件：箭头/页码会暗示「还有别的页」
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Pagination } from '../pagination'

describe('Pagination 当前页语义', () => {
  it('numbers：当前页带 aria-current=page，其余页不带', () => {
    render(<Pagination page={2} totalPages={3} onPageChange={() => {}} variant="numbers" />)

    expect(screen.getByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '第 1 页' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('button', { name: '第 3 页' })).not.toHaveAttribute('aria-current')
  })

  it('numbers：首/末页的翻页箭头分别禁用；点击页码回调新页码', async () => {
    const onPageChange = vi.fn()
    const user = userEvent.setup()
    const { unmount } = render(
      <Pagination page={1} totalPages={2} onPageChange={onPageChange} variant="numbers" />,
    )
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '第 2 页' }))
    expect(onPageChange).toHaveBeenCalledWith(2)

    unmount()
    render(<Pagination page={2} totalPages={2} onPageChange={onPageChange} variant="numbers" />)
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  })

  it('numbers：page 超出 totalPages 时按钳制后的末页标记（当前态不得静默丢失）', () => {
    // 残留 page=5 / totalPages=3：左侧信息已按 safePage 显示「第 3 / 3 页」，
    // 若标记用未钳制的 page，则没有任何页码带 aria-current——当前态从语义层消失
    render(<Pagination page={5} totalPages={3} onPageChange={() => {}} variant="numbers" />)

    expect(screen.getByRole('button', { name: '第 3 页' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('第 3 / 3 页')).toBeInTheDocument()
  })

  it('numbers：总页数=1 时不渲染页码组与箭头，仅保留每页选择器与总数', () => {
    render(
      <Pagination
        page={1}
        totalPages={1}
        totalItems={12}
        onPageChange={() => {}}
        variant="numbers"
        pageSize={10}
        showPageSizeSelector
        onPageSizeChange={() => {}}
      />,
    )

    // 「‹ [1] ›」会让人以为还有别的页；单页没有可翻的页。
    // 用「组件里一个 button 都没有」做结构断言——按可访问名的负断言会在改名后静默失效
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    // 每页选择器必须保留：切到「全部」档后这是切回分页的唯一入口
    expect(screen.getByLabelText('每页行数')).toBeInTheDocument()
    expect(screen.getByText('共 12 条')).toBeInTheDocument()
  })

  it('numbers：totalPages=0（空结果）只报「共 0 条」，不出现「第 1/0 页」', () => {
    const { container } = render(
      <Pagination
        page={1}
        totalPages={0}
        totalItems={0}
        onPageChange={() => {}}
        variant="numbers"
      />,
    )

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('共 0 条')).toBeInTheDocument()
    // 旧实现会渲染「共 0 条 · 第 1/0 页」（safePage 兜底 1、totalPages 为 0）
    expect(container.textContent).not.toMatch(/第\s*\d+\s*\/\s*0\s*页/)
  })

  it('prev-next：总页数=1 时同样不渲染两个方向按钮', () => {
    render(<Pagination page={1} totalPages={1} totalItems={3} onPageChange={() => {}} />)

    expect(screen.queryByRole('button', { name: '上一页' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '下一页' })).not.toBeInTheDocument()
    expect(screen.getByText('共 3 条')).toBeInTheDocument()
  })

  it('prev-next：只有上一页/下一页两枚按钮，不渲染页码按钮（该模式没有 aria-current 的语义位）', () => {
    render(<Pagination page={1} totalPages={3} onPageChange={() => {}} />)

    // 结构锚定：该模式恰好两枚按钮，多出页码按钮即回归（按可访问名的负断言改名后会静默失效）
    expect(screen.queryAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    // 当前页信息仍以文本送达（第 1 / 3 页）
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument()
  })
})
