import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from '../error-boundary'

/** 正常渲染的测试子组件 */
function GoodChild() {
  return <div data-testid="child">正常内容</div>
}

/** 渲染时抛出异常的测试子组件 */
function BadChild(): never {
  throw new Error('测试渲染异常')
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('正常渲染时不展示降级 UI', () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('child')).toHaveTextContent('正常内容')
    expect(screen.queryByText('页面渲染出现异常')).not.toBeInTheDocument()
  })

  it('子组件渲染异常时展示降级 UI 和重新加载按钮', () => {
    render(
      <ErrorBoundary>
        <BadChild />
      </ErrorBoundary>,
    )
    expect(screen.getByText('页面渲染出现异常，请尝试重新加载')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    expect(screen.queryByTestId('child')).not.toBeInTheDocument()
  })

  it('点击重新加载按钮触发 onReset 回调', async () => {
    const onReset = vi.fn()
    const user = userEvent.setup()
    render(
      <ErrorBoundary onReset={onReset}>
        <BadChild />
      </ErrorBoundary>,
    )
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('无 onReset 时点击重新加载不报错（兜底刷新）', async () => {
    const user = userEvent.setup()
    render(
      <ErrorBoundary>
        <BadChild />
      </ErrorBoundary>,
    )
    // 无 onReset 时不抛异常
    await user.click(screen.getByRole('button', { name: '重新加载' }))
  })
})
