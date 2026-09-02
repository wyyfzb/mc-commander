/**
 * AuditPage 时间范围筛选测试（#303）
 * mock @/api/queries 捕获 useAuditLogs 入参，验证：
 * - 快捷区间（今天/近7天/近30天）点击后 startTime/endTime 按
 *   服务端口径（UTC「YYYY-MM-DD HH:MM:SS」）透传（期望值经同一工具换算，时区自洽）
 * - 自定义起止（date input）透传 + 起止倒置时暂停时间过滤并给出可见提示（role=alert）
 * - 筛选变更重置回第 1 页（与 action 筛选行为一致）
 * - 快捷区间再次点击取消、清空时间恢复全量
 * - 与 action 筛选叠加（组合查询）
 * 全部数据为虚构占位，无真实服务器信息。
 */
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuditPage } from '../audit-page'
import { quickRangeDates, toServerStart, toServerEnd } from '../time-range'

const { auditCalls, cmdCalls, auditPageState } = vi.hoisted(() => ({
  auditCalls: [] as Array<Record<string, unknown>>,
  cmdCalls: [] as Array<Record<string, unknown>>,
  auditPageState: { page: 1 },
}))

vi.mock('@/api/queries', () => ({
  useAuditLogs: (params: Record<string, unknown>) => {
    auditCalls.push(params)
    return {
      isLoading: false,
      isFetching: false,
      isError: false,
      error: undefined,
      data: {
        data: [
          {
            id: 1,
            instanceId: 'demo',
            action: 'INSTANCE_START',
            targetType: 'instance',
            targetId: 'demo',
            detail: { note: '示例记录' },
            source: 'api',
            createdAt: '2026-01-01T10:00:00.000Z',
          },
        ],
        pagination: { page: auditPageState.page, totalPages: 3, total: 60 },
      },
      refetch: vi.fn(),
    }
  },
  useCommandHistory: (params: Record<string, unknown>) => {
    cmdCalls.push(params)
    return {
      isLoading: false,
      isFetching: false,
      isError: false,
      error: undefined,
      data: { data: [], pagination: { page: 1, totalPages: 1, total: 0 } },
      refetch: vi.fn(),
    }
  },
}))

function lastCall(): Record<string, unknown> {
  const last = auditCalls.at(-1)
  expect(last).toBeDefined()
  return last!
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <AuditPage />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

function dateInput(label: string): HTMLInputElement {
  const el = screen.getByLabelText(label) as HTMLInputElement
  expect(el).not.toBeNull()
  return el
}

beforeEach(() => {
  auditCalls.length = 0
  cmdCalls.length = 0
  auditPageState.page = 1
})

// jsdom 未实现 Pointer Capture / scrollIntoView（Radix Select 交互所需），本文件内补 stub
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('快捷区间透传', () => {
  it('点击「近 7 天」→ startTime/endTime 按服务端口径透传（UTC YYYY-MM-DD HH:MM:SS）', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(lastCall().startTime).toBeUndefined()
    expect(lastCall().endTime).toBeUndefined()

    await user.click(screen.getByRole('button', { name: '近 7 天' }))
    const r = quickRangeDates(6)
    expect(lastCall()).toMatchObject({
      page: 1,
      pageSize: 20,
      startTime: toServerStart(r.start),
      endTime: toServerEnd(r.end),
    })
  })

  it('点击「今天」→ 单日区间；再次点击同一快捷键 → 取消恢复全量（时间参数消失）', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: '今天' }))
    const r = quickRangeDates(0)
    expect(lastCall()).toMatchObject({
      startTime: toServerStart(r.start),
      endTime: toServerEnd(r.end),
    })
    // aria-pressed 高亮
    expect(screen.getByRole('button', { name: '今天' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: '今天' }))
    expect(screen.getByRole('button', { name: '今天' })).toHaveAttribute('aria-pressed', 'false')
    expect(lastCall().startTime).toBeUndefined()
    expect(lastCall().endTime).toBeUndefined()
  })
})

describe('筛选变更重置分页', () => {
  it('翻到第 2 页后应用时间筛选 → 请求回到第 1 页', async () => {
    const user = userEvent.setup()
    renderPage()

    // prev-next 分页按钮（audit tab 唯一分页，totalPages=3）
    await user.click(screen.getByRole('button', { name: '下一页' }))
    expect(lastCall().page).toBe(2)

    await user.click(screen.getByRole('button', { name: '近 30 天' }))
    const r = quickRangeDates(29)
    expect(lastCall()).toMatchObject({
      page: 1,
      startTime: toServerStart(r.start),
      endTime: toServerEnd(r.end),
    })
  })
})

describe('自定义起止与倒置防护', () => {
  it('起止 date input 透传换算后的时间参数', () => {
    renderPage()
    fireEvent.change(dateInput('开始日期'), { target: { value: '2026-01-10' } })
    expect(lastCall()).toMatchObject({ startTime: toServerStart('2026-01-10'), endTime: undefined })

    fireEvent.change(dateInput('结束日期'), { target: { value: '2026-01-20' } })
    expect(lastCall()).toMatchObject({
      startTime: toServerStart('2026-01-10'),
      endTime: toServerEnd('2026-01-20'),
    })
  })

  it('start > end：可见提示（role=alert）+ 时间参数暂停透传（不静默空结果）', () => {
    renderPage()
    fireEvent.change(dateInput('开始日期'), { target: { value: '2026-02-10' } })
    fireEvent.change(dateInput('结束日期'), { target: { value: '2026-02-01' } })

    expect(screen.getByRole('alert')).toHaveTextContent('起止时间倒置')
    expect(lastCall().startTime).toBeUndefined()
    expect(lastCall().endTime).toBeUndefined()

    // 修正后自动恢复过滤
    fireEvent.change(dateInput('开始日期'), { target: { value: '2026-01-05' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(lastCall()).toMatchObject({
      startTime: toServerStart('2026-01-05'),
      endTime: toServerEnd('2026-02-01'),
    })
  })
})

describe('清空恢复全量', () => {
  it('「清空时间」按钮移除全部时间参数（快捷区间与自定义起止通用）', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: '近 7 天' }))
    expect(lastCall().startTime).toBeDefined()

    await user.click(screen.getByRole('button', { name: '清空时间' }))
    expect(lastCall().startTime).toBeUndefined()
    expect(lastCall().endTime).toBeUndefined()
  })
})

describe('与 action 筛选叠加', () => {
  it('操作类型 + 时间范围组合查询', async () => {
    const user = userEvent.setup()
    renderPage()

    // 打开操作类型下拉，选择「启动实例」
    await user.click(screen.getByLabelText('操作类型'))
    await user.click(await screen.findByRole('option', { name: '启动实例' }))

    await user.click(screen.getByRole('button', { name: '近 7 天' }))
    const r = quickRangeDates(6)
    expect(lastCall()).toMatchObject({
      action: 'INSTANCE_START',
      page: 1,
      startTime: toServerStart(r.start),
      endTime: toServerEnd(r.end),
    })
  })
})
