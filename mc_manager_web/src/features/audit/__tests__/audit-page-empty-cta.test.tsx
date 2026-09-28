/**
 * AuditPage 空态 CTA 测试（issue 343：空态排查补齐）
 * - 有筛选（操作类型/时间范围）且结果为空 → 空态文案变更 +「清空筛选」按钮
 * - 无筛选且为空 → 普通「暂无记录」，无 CTA
 * - 点击「清空筛选」→ 操作类型与时间范围全部复位
 * mock 数据为虚构占位，无真实服务器信息
 */
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuditPage } from '../audit-page'

const { auditParams } = vi.hoisted(() => ({
  auditParams: {
    action: undefined as string | undefined,
    startTime: undefined as string | undefined,
    endTime: undefined as string | undefined,
  },
}))

vi.mock('@/api/queries', () => ({
  useAuditLogs: (params: Record<string, unknown>) => {
    // 捕获当前查询参数（清空筛选后 action/time 应消失）
    auditParams.action = params.action as string | undefined
    auditParams.startTime = params.startTime as string | undefined
    auditParams.endTime = params.endTime as string | undefined
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
  // AuditPage 内部使用 useSearchParams，须经 Router 提供 context
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
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  auditParams.action = undefined
  auditParams.startTime = undefined
  auditParams.endTime = undefined
})

// jsdom 未实现 Pointer Capture / scrollIntoView（radix Select 交互所需），本文件内补 stub
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('AuditPage 空态 CTA（issue 343）', () => {
  it('无筛选空态：普通「暂无记录」，无清空按钮', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('暂无记录')).toBeInTheDocument())
    expect(screen.queryByTestId('audit-clear-filters')).not.toBeInTheDocument()
  })

  it('筛选（操作类型）后空态：文案变更 + 「清空筛选」按钮出现', async () => {
    const user = userEvent.setup()
    renderPage()
    // 选择操作类型「启动实例」（radix Select 需要 pointer capture stub 环境）
    await user.click(screen.getByRole('combobox', { name: '操作类型' }))
    await user.click(screen.getByRole('option', { name: '启动实例' }))
    await waitFor(() => expect(screen.getByText('当前筛选条件下暂无记录')).toBeInTheDocument())
    expect(screen.getByTestId('audit-clear-filters')).toBeInTheDocument()
    // 透传了 action 参数
    expect(auditParams.action).toBe('INSTANCE_START')

    // 清空筛选 → 复位 + 恢复普通空态
    await user.click(screen.getByTestId('audit-clear-filters'))
    await waitFor(() =>
      expect(screen.queryByText('当前筛选条件下暂无记录')).not.toBeInTheDocument(),
    )
    expect(screen.getByText('暂无记录')).toBeInTheDocument()
    expect(screen.queryByTestId('audit-clear-filters')).not.toBeInTheDocument()
    expect(auditParams.action).toBeUndefined()
  })
})
