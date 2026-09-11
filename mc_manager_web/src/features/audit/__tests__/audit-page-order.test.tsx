/**
 * AuditPage 时间排序切换测试（issue 383）
 * mock @/api/queries 捕获 useAuditLogs 入参 + createMemoryRouter 检查 location.search：
 * - 默认倒序：「最新优先」激活，order 不入查询参数（与历史请求形态一致）
 * - 切换正序：URL 写回 order=asc，查询参数透传 asc
 * - URL 带参数挂载：asc 恢复生效；非法值回退倒序
 * - 切换排序：重置页码（page 参数移除）、保留现有筛选（action 参数保留）
 * - 切回倒序：URL 回归无 order 参数形态
 * 全部数据为虚构占位，无真实服务器信息。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuditPage } from '../audit-page'

const { auditParams } = vi.hoisted(() => ({
  auditParams: {
    page: undefined as number | undefined,
    action: undefined as string | undefined,
    order: undefined as string | undefined,
  },
}))

vi.mock('@/api/queries', () => ({
  useAuditLogs: (params: Record<string, unknown>) => {
    // 捕获当前查询参数（排序/筛选/页码应按服务端口径透传）
    auditParams.page = params.page as number | undefined
    auditParams.action = params.action as string | undefined
    auditParams.order = params.order as string | undefined
    return {
      isLoading: false,
      isFetching: false,
      isError: false,
      error: undefined,
      data: { data: [], pagination: { page: 1, totalPages: 1, total: 0 } },
      refetch: vi.fn(),
    }
  },
  useCommandHistory: () => ({
    isLoading: false,
    isFetching: false,
    isError: false,
    error: undefined,
    data: { data: [], pagination: { page: 1, totalPages: 1, total: 0 } },
    refetch: vi.fn(),
  }),
}))

function renderPage(initialPath = '/audit') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/audit',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <AuditPage />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  auditParams.page = undefined
  auditParams.action = undefined
  auditParams.order = undefined
})

describe('AuditPage 时间排序切换（issue 383）', () => {
  it('默认倒序：最新优先激活，order 不入查询参数（向后兼容）', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText('暂无记录')).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: '最新优先' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '最早优先' })).toHaveAttribute('aria-checked', 'false')
    // desc 为服务端默认：查询参数不携带 order（与历史请求形态一致）
    expect(auditParams.order).toBeUndefined()
  })

  it('切换正序：URL 写回 order=asc，查询参数透传 asc', async () => {
    const user = userEvent.setup()
    const router = renderPage()

    await user.click(screen.getByRole('radio', { name: '最早优先' }))
    await waitFor(() => expect(router.state.location.search).toBe('?order=asc'))
    expect(screen.getByRole('radio', { name: '最早优先' })).toHaveAttribute('aria-checked', 'true')
    expect(auditParams.order).toBe('asc')
  })

  it('URL 带 order=asc 挂载：正序恢复生效；非法值回退倒序', async () => {
    renderPage('/audit?order=asc')

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: '最早优先' })).toHaveAttribute('aria-checked', 'true'),
    )
    expect(auditParams.order).toBe('asc')
  })

  it('非法 order 参数挂载：回退倒序且查询不携带 order', async () => {
    renderPage('/audit?order=newest')

    await waitFor(() => expect(screen.getByText('暂无记录')).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: '最新优先' })).toHaveAttribute('aria-checked', 'true')
    expect(auditParams.order).toBeUndefined()
  })

  it('切换排序：重置页码（page 参数移除）、保留现有筛选（action 保留）', async () => {
    const user = userEvent.setup()
    const router = renderPage('/audit?action=INSTANCE_START&page=3')

    await waitFor(() => expect(auditParams.page).toBe(3))
    expect(auditParams.action).toBe('INSTANCE_START')

    // 切到正序：page 参数消失（重置第 1 页），action 筛选保留
    await user.click(screen.getByRole('radio', { name: '最早优先' }))
    await waitFor(() => expect(router.state.location.search).toBe('?action=INSTANCE_START&order=asc'))
    expect(auditParams.page).toBe(1)
    expect(auditParams.action).toBe('INSTANCE_START')
    expect(auditParams.order).toBe('asc')
  })

  it('切回倒序：URL 回归无 order 参数形态', async () => {
    const user = userEvent.setup()
    const router = renderPage('/audit?order=asc')

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: '最早优先' })).toHaveAttribute('aria-checked', 'true'),
    )

    await user.click(screen.getByRole('radio', { name: '最新优先' }))
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(auditParams.order).toBeUndefined()
  })

  it('排序单选组：方向键移动即选中，aria-checked 与焦点同步', () => {
    renderPage()
    const group = screen.getByRole('radiogroup', { name: '时间排序' })
    const [desc, asc] = within(group).getAllByRole('radio')
    expect(desc).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(asc).toHaveAttribute('aria-checked', 'true')
    expect(desc).toHaveAttribute('aria-checked', 'false')
    expect(asc).toHaveAttribute('tabindex', '0')
    expect(document.activeElement).toBe(asc)
  })

})
