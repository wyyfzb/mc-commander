/**
 * useUnsavedGuard 单测：dirty 时拦截导航、proceed 放行、cancel 回滚
 */
import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { createMemoryRouter, Link, RouterProvider } from 'react-router'
import { useUnsavedGuard } from '../use-unsaved-guard'

/** 测试页 A：dirty 开关 + 守卫 + 跳转链接 */
function PageA() {
  const [dirty, setDirty] = useState(false)
  const guard = useUnsavedGuard(dirty)
  return (
    <div>
      <button onClick={() => setDirty(true)}>编辑（置脏）</button>
      <Link to="/b">跳转到 B</Link>
      <span data-testid="blocked">{guard.isBlocked ? '已拦截' : '未拦截'}</span>
      <button onClick={guard.proceed}>离开</button>
      <button onClick={guard.cancel}>留下</button>
    </div>
  )
}

function PageB() {
  return <div>页面 B</div>
}

function renderGuard() {
  const router = createMemoryRouter(
    [
      { path: '/a', element: <PageA /> },
      { path: '/b', element: <PageB /> },
      { path: '*', element: <div>兜底</div> },
    ],
    { initialEntries: ['/a'] },
  )
  return render(<RouterProvider router={router} />)
}

describe('useUnsavedGuard', () => {
  it('不脏时导航放行', async () => {
    renderGuard()
    fireEvent.click(screen.getByText('跳转到 B'))
    expect(await screen.findByText('页面 B')).toBeInTheDocument()
  })

  it('脏时导航被拦截；留下回滚、离开放行', async () => {
    renderGuard()
    fireEvent.click(screen.getByText('编辑（置脏）'))
    expect(screen.getByTestId('blocked')).toHaveTextContent('未拦截')
    await act(async () => {
      fireEvent.click(screen.getByText('跳转到 B'))
    })
    // 导航被拦截：仍在页面 A，isBlocked 打开
    expect(screen.getByTestId('blocked')).toHaveTextContent('已拦截')
    expect(screen.queryByText('页面 B')).not.toBeInTheDocument()
    // 留下：解除拦截态，仍在 A
    await act(async () => {
      fireEvent.click(screen.getByText('留下'))
    })
    expect(screen.getByTestId('blocked')).toHaveTextContent('未拦截')
    // 再次跳转并选择离开：放行到 B
    await act(async () => {
      fireEvent.click(screen.getByText('跳转到 B'))
    })
    expect(screen.getByTestId('blocked')).toHaveTextContent('已拦截')
    await act(async () => {
      fireEvent.click(screen.getByText('离开'))
    })
    expect(await screen.findByText('页面 B')).toBeInTheDocument()
  })
})
