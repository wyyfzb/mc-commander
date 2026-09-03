import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Zap } from 'lucide-react'
import { IconButton } from '../icon-button'

/**
 * IconButton 抽象组件测试：
 * - aria-label 必填契约（渲染为可访问按钮）
 * - 无 tooltip → 纯 button；有 tooltip → 触发器包裹
 * - variant/size/disabled/onClick 透传
 */

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('IconButton', () => {
  it('渲染为带 aria-label 的按钮（icon 按钮无可见文本，无障碍名必填）', () => {
    renderWithProvider(
      <IconButton aria-label="刷新">
        <Zap aria-hidden />
      </IconButton>,
    )
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  })

  it('不传 tooltip 时不渲染 Tooltip 触发器结构（纯 button）', () => {
    renderWithProvider(
      <IconButton aria-label="编辑">
        <Zap aria-hidden />
      </IconButton>,
    )
    expect(screen.getByRole('button', { name: '编辑' }).tagName).toBe('BUTTON')
  })

  it('tooltip 内容作为提示渲染（TooltipTrigger asChild 包裹）', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <IconButton aria-label="删除" tooltip="删除该文件">
        <Zap aria-hidden />
      </IconButton>,
    )
    // Radix Tooltip 延迟展示：hover 后出现
    await user.hover(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('删除该文件')).toBeInTheDocument()
  })

  it('透传 onClick / disabled / title', () => {
    const onClick = vi.fn()
    renderWithProvider(
      <IconButton aria-label="停止" onClick={onClick} disabled title="停止服务器">
        <Zap aria-hidden />
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: '停止' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', '停止服务器')
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled() // disabled 不触发
  })

  it('透传 variant 与 size（data-size 落在按钮上）', () => {
    renderWithProvider(
      <IconButton aria-label="放大" variant="outline" size="icon-lg">
        <Zap aria-hidden />
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: '放大' })
    expect(btn).toHaveAttribute('data-size', 'icon-lg')
    expect(btn).toHaveAttribute('data-variant', 'outline')
  })

  it('默认 ghost 变体 + icon-sm 尺寸（与高频既有用法一致）', () => {
    renderWithProvider(
      <IconButton aria-label="默认态">
        <Zap aria-hidden />
      </IconButton>,
    )
    const btn = screen.getByRole('button', { name: '默认态' })
    expect(btn).toHaveAttribute('data-size', 'icon-sm')
    expect(btn).toHaveAttribute('data-variant', 'ghost')
  })
})
