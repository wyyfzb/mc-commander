import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from '@/components/mcs/page-header'

describe('PageHeader', () => {
  it('renders title only', () => {
    render(<PageHeader title="测试标题" />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('测试标题')
    expect(screen.queryByText('描述文本')).not.toBeInTheDocument()
  })

  it('renders title and description', () => {
    render(<PageHeader title="测试标题" description="描述文本" />)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('测试标题')
    expect(screen.getByText('描述文本')).toBeInTheDocument()
  })

  it('renders actions when provided', () => {
    render(
      <PageHeader
        title="测试标题"
        description="描述文本"
        actions={<button data-testid="action-btn">操作</button>}
      />,
    )
    expect(screen.getByTestId('action-btn')).toBeInTheDocument()
    expect(screen.getByTestId('action-btn')).toHaveTextContent('操作')
  })

  it('omits actions when not provided', () => {
    const { container } = render(<PageHeader title="测试标题" />)
    // Only one child div (the title wrapper), no actions wrapper
    const header = container.querySelector('header')
    expect(header?.children).toHaveLength(1)
  })

  it('uses semantic <header> element', () => {
    const { container } = render(<PageHeader title="测试标题" />)
    expect(container.querySelector('header')).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const { container } = render(<PageHeader title="测试标题" className="px-4 pt-1" />)
    const header = container.querySelector('header')
    expect(header?.className).toContain('px-4')
    expect(header?.className).toContain('pt-1')
  })

  it('supports ReactNode title', () => {
    render(<PageHeader title={<span data-testid="custom-title">自定义标题</span>} />)
    expect(screen.getByTestId('custom-title')).toBeInTheDocument()
  })

  it('supports ReactNode description with mixed content', () => {
    render(
      <PageHeader
        title="测试"
        description={
          <>
            基础描述
            <span data-testid="extra">额外信息</span>
          </>
        }
      />,
    )
    expect(screen.getByText('基础描述')).toBeInTheDocument()
    expect(screen.getByTestId('extra')).toBeInTheDocument()
  })
})
