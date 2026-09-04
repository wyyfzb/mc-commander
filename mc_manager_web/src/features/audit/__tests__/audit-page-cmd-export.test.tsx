/**
 * AuditPage 命令历史导出按钮组件测试（issue 403）
 * 对齐 audit-page-export.test.tsx 范式：mock @/api/queries + mock ../audit-export：
 * - commands tab 导出入口渲染 + 上限提示（最多导出 1000 条），与审计日志 tab 同构
 * - 点击触发：按当前 cmd 筛选（时间起止）口径调用导出
 * - 导出进行中按钮禁用，完成后恢复；失败不崩溃
 * - tab 隔离：audit tab 不渲染 cmd-export，commands tab 不渲染 audit-export
 * 全部数据为虚构占位，无真实服务器信息。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuditPage } from '../audit-page'

const { cmdExportImpl, cmdExportCalls } = vi.hoisted(() => ({
  cmdExportImpl: { current: (() => Promise.resolve()) as (...args: unknown[]) => Promise<void> },
  cmdExportCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/api/queries', () => ({
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
  exportAuditLogsToExcel: vi.fn(() => Promise.resolve()),
  exportCommandHistoryToExcel: (...args: unknown[]) => {
    cmdExportCalls.push({ config: args[0], params: args[1] })
    return cmdExportImpl.current(...args)
  },
}))

function renderPage(initialPath = '/audit?tab=commands') {
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
  cmdExportCalls.length = 0
  cmdExportImpl.current = () => Promise.resolve()
})

describe('AuditPage 命令历史导出入口（issue 403）', () => {
  it('commands tab 导出按钮 + 上限提示渲染（最多导出 1000 条（时间最新优先））', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('cmd-export')).toBeInTheDocument())
    expect(screen.getByText(/最多导出 1000 条/)).toBeInTheDocument()
  })

  it('tab 隔离：commands tab 不渲染 audit-export（导出入口各 tab 独立）', async () => {
    renderPage('/audit?tab=commands')
    await waitFor(() => expect(screen.getByTestId('cmd-export')).toBeInTheDocument())
    expect(screen.queryByTestId('audit-export')).not.toBeInTheDocument()
  })

  it('点击导出：无筛选 → 空参数透传（时间由服务端默认口径承接）', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('cmd-export'))

    await waitFor(() => expect(cmdExportCalls).toHaveLength(1))
    const call = cmdExportCalls[0]!
    expect(call.params).toEqual({ startTime: undefined, endTime: undefined })
  })

  it('URL 挂载 cmd 筛选（cmdStart/cmdEnd）：导出参数透传时间起止', async () => {
    const user = userEvent.setup()
    renderPage('/audit?tab=commands&cmdStart=2026-01-01&cmdEnd=2026-01-31')
    await user.click(await screen.findByTestId('cmd-export'))

    await waitFor(() => expect(cmdExportCalls).toHaveLength(1))
    const params = cmdExportCalls[0]!.params as Record<string, string | undefined>
    expect(params.startTime).toBeDefined()
    expect(params.endTime).toBeDefined()
  })

  it('导出进行中按钮禁用，完成后恢复可点击', async () => {
    let resolveExport: () => void = () => {}
    cmdExportImpl.current = () =>
      new Promise<void>((resolve) => {
        resolveExport = resolve
      })

    const user = userEvent.setup()
    renderPage()
    const button = await screen.findByTestId('cmd-export')
    await user.click(button)
    await waitFor(() => expect(button).toBeDisabled())

    resolveExport()
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('导出失败：页面不崩溃（按钮恢复，留待 toast 反馈）', async () => {
    cmdExportImpl.current = () => Promise.reject(new Error('network down'))

    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('cmd-export'))

    await waitFor(() => expect(screen.getByTestId('cmd-export')).not.toBeDisabled())
    // 页面仍完整渲染（空态文案在）
    expect(screen.getByText('暂无记录')).toBeInTheDocument()
  })
})
