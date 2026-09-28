/**
 * 命令历史重发测试
 *
 * 承重口径：① 重发前必须二次确认（历史含 stop/ban 等不可逆命令，直接下发等于给误点
 * 开门）；② 目标实例取**该行自己的** instanceId（审计页是跨实例汇总，取全局选中实例
 * 会发错机器）；③ 下发时带 `replay` 来源标记（命令史是审计资产，重发与首次下发必须可
 * 分辨）；④ 成功/失败都有用户可见反馈，且成功才重取历史。
 * mock 数据为虚构占位，无真实服务器信息。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster, toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuditPage } from '../audit-page'

const { sendCommandMock, cmdRefetch, historyState, instancesData } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
  cmdRefetch: vi.fn(),
  historyState: { rows: [] as unknown[] },
  instancesData: { list: [] as unknown[] },
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
    data: { data: historyState.rows, pagination: { page: 1, totalPages: 1, total: 1 } },
    refetch: cmdRefetch,
  }),
  useInstances: () => ({ data: instancesData.list }),
}))

vi.mock('@/api/players', () => ({
  apiSendCommand: (...args: unknown[]) => sendCommandMock(...args),
}))

function cmdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    instanceId: 'survival',
    command: 'stop',
    source: 'api',
    success: true,
    response: null,
    durationMs: 12,
    createdAt: '2026-01-02T03:04:05Z',
    ...overrides,
  }
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/audit',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <AuditPage />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/audit?tab=commands'] },
  )
  return render(<RouterProvider router={router} />)
}

/** 走完「点重发 → 确认」两步 */
async function replayViaDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '重发命令 stop' }))
  await user.click(await screen.findByRole('button', { name: '重发' }))
}

describe('AuditPage 命令重发', () => {
  beforeEach(() => {
    sendCommandMock.mockReset()
    sendCommandMock.mockResolvedValue({ response: 'ok' })
    cmdRefetch.mockReset()
    historyState.rows = [cmdRow()]
    instancesData.list = [{ id: 'survival', name: '生存服', isRunning: true, playerCount: 0 }]
    // sonner 的 toast store 是模块级的：清残留防跨用例泄漏干扰反向断言
    toast.dismiss()
  })

  it('点「重发」只弹确认，不直接下发命令', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: '重发命令 stop' }))

    expect(await screen.findByText('重发这条命令？')).toBeInTheDocument()
    // 未确认前不得有任何下发——这条是「二次确认」的全部意义
    expect(sendCommandMock).not.toHaveBeenCalled()
  })

  it('确认后按该行自己的实例下发，并带 replay 来源标记 + 重取命令历史', async () => {
    const user = userEvent.setup()
    renderPage()

    await replayViaDialog(user)

    await waitFor(() => expect(sendCommandMock).toHaveBeenCalledTimes(1))
    // 第三实参是该行 instanceId（不是全局选中实例），第四是来源标记
    expect(sendCommandMock.mock.calls[0]?.[1]).toBe('survival')
    expect(sendCommandMock.mock.calls[0]?.[2]).toBe('stop')
    expect(sendCommandMock.mock.calls[0]?.[3]).toBe('replay')
    await waitFor(() => expect(cmdRefetch).toHaveBeenCalled())
  })

  it('对话框显示实例名而非裸 id（命令史表无实例列，这是唯一的归属提示）', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: '重发命令 stop' }))

    expect(await screen.findByText(/将向实例「生存服」重发/)).toBeInTheDocument()
  })

  it('确认框明示不可逆风险（stop/ban 之类会真实执行）', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: '重发命令 stop' }))

    expect(await screen.findByText(/不可逆命令，重发会真实执行/)).toBeInTheDocument()
  })

  it('含被遮蔽敏感值的行改口径提示（重发遮蔽文本多半失败，不假装等价）', async () => {
    historyState.rows = [cmdRow({ command: 'login ***' })]
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: '重发命令 login ***' }))

    expect(await screen.findByText(/含被遮蔽的敏感值/)).toBeInTheDocument()
    expect(screen.queryByText(/不可逆命令，重发会真实执行/)).not.toBeInTheDocument()
  })

  it('取消确认后不下发，且对话框关闭（可再次打开）', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: '重发命令 stop' }))
    await user.click(await screen.findByRole('button', { name: '取消' }))

    expect(sendCommandMock).not.toHaveBeenCalled()
    // 关闭后状态已复位：再次点击仍能打开（若 cancel 没清 target 这里会失效）
    await waitFor(() => expect(screen.queryByText('重发这条命令？')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: '重发命令 stop' }))
    expect(await screen.findByText('重发这条命令？')).toBeInTheDocument()
  })

  it('成功后有成功提示（不静默）', async () => {
    const user = userEvent.setup()
    renderPage()

    await replayViaDialog(user)

    expect(await screen.findByText('命令已重发')).toBeInTheDocument()
  })

  it('下发失败时提示失败原因，且不重取历史（没有新行）', async () => {
    sendCommandMock.mockRejectedValue(new Error('RCON unavailable'))
    const user = userEvent.setup()
    renderPage()

    await replayViaDialog(user)

    // 必须真的断言提示文案：只断言「调用过」而不看提示，等于没测「不静默」
    await waitFor(() => expect(screen.getByText(/重发失败/)).toBeInTheDocument())
    expect(cmdRefetch).not.toHaveBeenCalled()
  })

  it('无实例归属的行：按钮禁用（不提供一次注定失败的重发）', async () => {
    historyState.rows = [cmdRow({ instanceId: null, command: 'list' })]
    renderPage()

    expect(await screen.findByRole('button', { name: '重发命令 list' })).toBeDisabled()
  })
})
