import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from '@/components/mcs/error-boundary'

/** 正常渲染的测试子组件 */
function GoodChild() {
  return <div data-testid="child">正常内容</div>
}

/** 渲染时抛出异常的测试子组件 */
function BadChild(): never {
  throw new Error('测试渲染异常')
}

/**
 * 一直抛错、直到测试把开关翻掉的子组件。
 * 「重新加载」的语义是**恢复渲染**：用恒抛错的子组件测不出这一点——
 * 把 handleReset 里的 setState 删掉，按钮点了没反应，断言照样过。
 * 开关由 onReset 翻（handleReset 先 setState 再回调），故恢复渲染只能来自那次 setState。
 */
let recoverState = { shouldThrow: true }
function ThrowUntilReset() {
  if (recoverState.shouldThrow) throw new Error('渲染异常')
  return <div data-testid="recovered">已恢复</div>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    recoverState = { shouldThrow: true }
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

  it('点击重新加载后降级 UI 消失、子组件恢复渲染（按钮真的起作用）', async () => {
    const user = userEvent.setup()
    // 重置回调里翻开关：下一次渲染的子组件不再抛错
    const onReset = vi.fn(() => {
      recoverState.shouldThrow = false
    })
    render(
      <ErrorBoundary onReset={onReset}>
        <ThrowUntilReset />
      </ErrorBoundary>,
    )
    expect(screen.getByText('页面渲染出现异常，请尝试重新加载')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新加载' }))
    expect(onReset).toHaveBeenCalledOnce()
    expect(screen.getByTestId('recovered')).toHaveTextContent('已恢复')
    expect(screen.queryByText('页面渲染出现异常，请尝试重新加载')).not.toBeInTheDocument()
  })
})
