/**
 * Pagination 可达性语义：
 * - 当前页必须用 `aria-current="page"` 暴露：底色只是视觉线索，读屏拿不到
 *   （语义值域与全站先例一致：导航/tab 用 page，步骤条用 step）
 * - 上一页/下一页在首/末页禁用（方向语义不能靠「点了没反应」表达）
 * - prev-next 模式无页码按钮，不引入 aria-current
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

  it('prev-next：不渲染页码按钮（该模式没有 aria-current 的语义位）', () => {
    render(<Pagination page={1} totalPages={3} onPageChange={() => {}} />)

    expect(screen.queryByRole('button', { name: /^第 \d+ 页$/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    // 当前页信息仍以文本送达（第 1 / 3 页）
    expect(screen.getByText('第 1 / 3 页')).toBeInTheDocument()
  })
})
