/**
 * AuditPage 筛选状态 URL 持久化测试（issue 381）
 * mock @/api/queries 捕获 useAuditLogs 入参 + createMemoryRouter 检查 location.search：
 * - URL 带参数挂载：筛选初始值生效（UI 选中态 + 查询参数按服务端口径透传）
 * - 无参数访问：默认行为与现状一致（全部空 = 不过滤）
 * - 变更筛选：URL 同步写回（操作类型 / 时间起止）
 * - 清空筛选：URL 参数全部移除（回归无参数形态）
 * 全部数据为虚构占位，无真实服务器信息。
 */
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuditPage } from '../audit-page'
import { toServerStart, toServerEnd } from '../time-range'

const { auditParams } = vi.hoisted(() => ({
  auditParams: {
    action: undefined as string | undefined,
    startTime: undefined as string | undefined,
    endTime: undefined as string | undefined,
  },
}))

vi.mock('@/api/queries', () => ({
  useInstances: () => ({ data: [] }),
  useAuditLogs: (params: Record<string, unknown>) => {
    // 捕获当前查询参数（URL 恢复的筛选应原样透传）
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
  // 返回 router 以便断言 location.search（MemoryRouter 的 URL 真源）
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
  auditParams.action = undefined
  auditParams.startTime = undefined
  auditParams.endTime = undefined
})

// jsdom 未实现 Pointer Capture / scrollIntoView（Radix Select 交互所需），本文件内补 stub
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('AuditPage 筛选状态 URL 持久化（issue 381）', () => {
  it('URL 带参数挂载：筛选初始值生效（UI 选中态 + 查询参数透传）', async () => {
    renderPage('/audit?action=INSTANCE_UPDATE&start=2026-01-01&end=2026-01-31')

    // 操作类型下拉初始选中「更新实例配置」
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '操作类型' })).toHaveTextContent(
        '操作类型：更新实例配置',
      ),
    )
    // 时间起止初始值
    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-01-01')
    expect(screen.getByLabelText('结束日期')).toHaveValue('2026-01-31')
    // 查询参数透传（时间按服务端口径换算）
    expect(auditParams.action).toBe('INSTANCE_UPDATE')
    expect(auditParams.startTime).toBe(toServerStart('2026-01-01'))
    expect(auditParams.endTime).toBe(toServerEnd('2026-01-31'))
  })

  it('非法参数挂载回退默认 + 无参数访问行为一致', async () => {
    renderPage('/audit?action=NOT_AN_ACTION&page=0&start=not-a-date')

    await waitFor(() => expect(screen.getByText('暂无记录')).toBeInTheDocument())
    // 未知操作类型 / 非法页码 / 非法日期 → 全部回退默认（不过滤）
    expect(screen.getByRole('combobox', { name: '操作类型' })).toHaveTextContent('操作类型：全部')
    expect(screen.getByLabelText('开始日期')).toHaveValue('')
    expect(auditParams.action).toBeUndefined()
    expect(auditParams.startTime).toBeUndefined()
    expect(auditParams.endTime).toBeUndefined()
  })

  it('变更筛选 → URL 同步写回；清空筛选 → 参数全部移除', async () => {
    const user = userEvent.setup()
    const router = renderPage()
    // 初始无参数（URL 最短形态）
    expect(router.state.location.search).toBe('')

    // 选择操作类型 → URL 写回
    await user.click(screen.getByRole('combobox', { name: '操作类型' }))
    await user.click(screen.getByRole('option', { name: '启动实例' }))
    await waitFor(() => expect(router.state.location.search).toBe('?action=INSTANCE_START'))

    // 设置时间起止 → URL 依次追加（翻页重置不产生 page 参数：默认第 1 页不留痕）
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-02-10' } })
    await waitFor(() =>
      expect(router.state.location.search).toBe('?action=INSTANCE_START&start=2026-02-10'),
    )
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-02-20' } })
    await waitFor(() =>
      expect(router.state.location.search).toBe(
        '?action=INSTANCE_START&start=2026-02-10&end=2026-02-20',
      ),
    )

    // 清空筛选（空态 CTA）→ URL 回归无参数形态
    await user.click(screen.getByTestId('audit-clear-filters'))
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(auditParams.action).toBeUndefined()
    expect(auditParams.startTime).toBeUndefined()
    expect(auditParams.endTime).toBeUndefined()
  })
})
