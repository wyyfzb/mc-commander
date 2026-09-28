/**
 * AuditPage 导出按钮组件测试（issue 384）
 * mock @/api/queries（页面数据源）+ mock ../audit-export（捕获导出调用）：
 * - 导出入口渲染 + 上限提示（最多导出 1000 条）
 * - 点击触发：按当前筛选（action/时间）与排序口径调用导出
 * - 导出进行中按钮禁用，完成后恢复
 * - 导出失败：页面不崩溃（toast 由根布局 Toaster 承接，页面级测试不断言）
 * 全部数据为虚构占位，无真实服务器信息。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuditPage } from '../audit-page'

const { exportImpl, exportCalls } = vi.hoisted(() => ({
  exportImpl: { current: (() => Promise.resolve()) as (...args: unknown[]) => Promise<void> },
  exportCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/api/queries', () => ({
  useInstances: () => ({ data: [] }),
  useAuditLogs: () => ({
    isLoading: false,
    isFetching: false,
    isError: false,
    error: undefined,
    data: { data: [], pagination: { page: 1, totalPages: 1, total: 0 } },
    refetch: vi.fn(),
  }),
  useCommandHistory: () => ({
    isLoading: false,
    isFetching: false,
    isError: false,
    error: undefined,
    data: { data: [], pagination: { page: 1, totalPages: 1, total: 0 } },
    refetch: vi.fn(),
  }),
}))

vi.mock('../audit-export', () => ({
  AUDIT_EXPORT_MAX_ROWS: 1000,
  exportAuditLogsToExcel: (...args: unknown[]) => {
    exportCalls.push({ config: args[0], params: args[1], order: args[2] })
    return exportImpl.current(...args)
  },
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
  exportCalls.length = 0
  exportImpl.current = () => Promise.resolve()
})

describe('AuditPage 导出入口（issue 384）', () => {
  it('导出按钮 + 上限提示渲染（最多导出 1000 条（时间最新优先））', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('audit-export')).toBeInTheDocument())
    expect(screen.getByText(/最多导出 1000 条/)).toBeInTheDocument()
  })

  it('点击导出：以当前筛选与排序口径调用（默认无筛选 → 空参数 + desc）', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('audit-export'))

    await waitFor(() => expect(exportCalls).toHaveLength(1))
    const call = exportCalls[0]!
    expect(call.params).toEqual({ action: undefined, startTime: undefined, endTime: undefined })
    expect(call.order).toBe('desc')
  })

  it('带筛选与正序挂载：导出参数透传筛选与 asc 口径', async () => {
    const user = userEvent.setup()
    renderPage('/audit?action=INSTANCE_START&order=asc&start=2026-01-01&end=2026-01-31')
    await user.click(await screen.findByTestId('audit-export'))

    await waitFor(() => expect(exportCalls).toHaveLength(1))
    const call = exportCalls[0]!
    const params = call.params as Record<string, string | undefined>
    expect(params.action).toBe('INSTANCE_START')
    expect(params.startTime).toBeDefined()
    expect(params.endTime).toBeDefined()
    expect(call.order).toBe('asc')
  })

  it('导出进行中按钮禁用，完成后恢复可点击', async () => {
    let resolveExport: () => void = () => {}
    exportImpl.current = () =>
      new Promise<void>((resolve) => {
        resolveExport = resolve
      })

    const user = userEvent.setup()
    renderPage()
    const button = await screen.findByTestId('audit-export')
    await user.click(button)
    await waitFor(() => expect(button).toBeDisabled())

    resolveExport()
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('导出失败：页面不崩溃（按钮恢复，留待 toast 反馈）', async () => {
    exportImpl.current = () => Promise.reject(new Error('network down'))

    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('audit-export'))

    await waitFor(() => expect(screen.getByTestId('audit-export')).not.toBeDisabled())
    // 页面仍完整渲染（空态文案在）
    expect(screen.getByText('暂无记录')).toBeInTheDocument()
  })
})
