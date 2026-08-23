import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServerOff } from 'lucide-react'
import { EmptyState } from '../empty-state'

/**
 * EmptyState 空态组件：图标/标题/说明/可选 CTA
 */

describe('EmptyState', () => {
  it('渲染图标 + 主标题 + 说明', () => {
    const { container } = render(
      <EmptyState icon={ServerOff} title="暂无服务器实例" hint="请先在服务端创建 MC 服务器实例" />,
    )
    expect(screen.getByText('暂无服务器实例')).toBeInTheDocument()
    expect(screen.getByText('请先在服务端创建 MC 服务器实例')).toBeInTheDocument()
    // 图标存在（lucide 图标为 aria-hidden svg，装饰性）
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('无 CTA 时不渲染按钮', () => {
    render(<EmptyState title="暂无数据" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('CTA 渲染并触发 onClick', () => {
    const onClick = vi.fn()
    render(<EmptyState title="暂无服务器实例" action={{ label: '前往实例管理', onClick }} />)
    const btn = screen.getByRole('button', { name: '前往实例管理' })
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
