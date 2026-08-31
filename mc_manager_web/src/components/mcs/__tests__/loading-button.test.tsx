import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoadingButton } from '../loading-button'

describe('LoadingButton', () => {
  it('非加载态正常渲染 children', () => {
    render(<LoadingButton>提交</LoadingButton>)
    expect(screen.getByRole('button', { name: '提交' })).toBeInTheDocument()
    expect(screen.getByRole('button')).not.toBeDisabled()
  })

  it('加载态自动禁用按钮', () => {
    render(<LoadingButton loading>提交</LoadingButton>)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('加载态显示 spinner（sva-rotate 动画类）', () => {
    const { container } = render(<LoadingButton loading>提交</LoadingButton>)
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('loadingText: 加载态替换文案', () => {
    render(<LoadingButton loading loadingText="处理中…">提交</LoadingButton>)
    expect(screen.getByRole('button', { name: /处理中/ })).toBeInTheDocument()
    expect(screen.queryByText('提交')).not.toBeInTheDocument()
  })

  it('无 loadingText: 加载态保留原 children 并添加 spinner', () => {
    render(<LoadingButton loading>保存</LoadingButton>)
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
    const { container } = render(<LoadingButton loading>保存</LoadingButton>)
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('disabled + loading 同时生效', () => {
    render(<LoadingButton loading disabled>禁用提交</LoadingButton>)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('非加载态 disabled 正常工作', () => {
    render(<LoadingButton disabled>禁用</LoadingButton>)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('继承 Button variant/size/className', () => {
    const { container } = render(
      <LoadingButton variant="outline" size="sm" className="test-cls">
        确认
      </LoadingButton>,
    )
    const btn = container.querySelector('button')!
    expect(btn.className).toContain('test-cls')
  })
})
