/**
 * TaskList 测试：
 * - 渲染 3 mock 任务（名称/类型标签/cron mono/命令/时间行）
 * - 启用开关切换回调（onToggle(task, enabled)）
 * - 立即执行/编辑/删除 aria-label 点击回调
 * - runningTaskId 命中行「立即执行」禁用 + hourglass，其余行不受影响
 * - 空态文案 + 新建任务按钮；加载态骨架行
 * - tone token 类抽查（token 纪律：禁硬编码色值）
 * mock 数据全部为测试占位（虚构内容，无真实服务器信息）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import userEvent from '@testing-library/user-event'
import { TaskList, type TaskListProps } from '../task-list'
import { mockTasks } from '@/test/mocks/handlers'
import { TASK_TYPE_LABELS, formatNextRunCountdown, formatTaskDate } from '@/lib/mc-deploy'
import type { ScheduledTask } from '@/api/types'

afterEach(() => {
  vi.useRealTimers()
})

function renderList(overrides: Partial<TaskListProps> = {}) {
  const handlers = {
    onToggle: vi.fn(),
    onRunNow: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onNewTask: vi.fn(),
  }
  render(
    <TooltipProvider>
    <TaskList
      tasks={overrides.tasks ?? mockTasks}
      isLoading={overrides.isLoading ?? false}
      runningTaskId={overrides.runningTaskId ?? null}
      onToggle={handlers.onToggle}
      onRunNow={handlers.onRunNow}
      onEdit={handlers.onEdit}
      onDelete={handlers.onDelete}
      onNewTask={handlers.onNewTask}
    />
    </TooltipProvider>,
  )
  return handlers
}

describe('TaskList 渲染', () => {
  it('渲染 3 个 mock 任务（名称/类型标签/cron/命令/时间行）', () => {
    // 固定时钟使倒计时断言稳定（mockTasks 为模块加载时相对真实时间构造，取当前真实时间为基准差值不变）
    vi.useFakeTimers({ now: Date.now() })
    renderList()

    // 名称
    for (const t of mockTasks) {
      expect(screen.getByText(t.name)).toBeInTheDocument()
    }
    // 类型 PillBadge（TASK_TYPE_LABELS 文案）
    for (const t of mockTasks) {
      expect(screen.getAllByText(TASK_TYPE_LABELS[t.type]).length).toBeGreaterThan(0)
    }
    // cron 表达式（mono 行）
    expect(screen.getByText('0 4 * * *')).toBeInTheDocument()
    expect(screen.getByText('0 0 * * *')).toBeInTheDocument()
    expect(screen.getByText('*/30 * * * *')).toBeInTheDocument()
    // 命令（仅 command 类型任务显示）
    expect(screen.getByText('say 服务器每半小时自动公告')).toBeInTheDocument()

    // 时间行「上次运行/下次运行」（formatTaskDate 格式化；null → 从未）
    const timeRows = screen.getAllByText((_, el) => el?.textContent?.startsWith('上次运行:') ?? false)
    expect(timeRows).toHaveLength(3)
    expect(timeRows[0]?.textContent).toContain(`上次运行: ${formatTaskDate(mockTasks[0]!.lastRunAt)}`)
    expect(timeRows[0]?.textContent).toContain(`下次运行: ${formatTaskDate(mockTasks[0]!.nextRunAt)}（`)
    // 下次运行追加倒计时（2h 前生成：2h 0m 后；容差断言，精确格式由 formatNextRunCountdown 单测锁定）
    expect(timeRows[0]?.textContent).toContain(
      `（${formatNextRunCountdown(mockTasks[0]!.nextRunAt, Date.now())}）`,
    )
    // 从未兜底：任务 2 无上次运行、任务 3 无下次运行
    expect(timeRows[1]?.textContent).toContain('上次运行: 从未')
    expect(timeRows[2]?.textContent).toContain('下次运行: 从未')
  })

  it('类型徽章与图标使用 tone token 类（restart → warning）', () => {
    renderList()
    const badge = screen.getByText('重启')
    expect(badge.className).toContain('bg-mcs-warning-bg-subtle')
    expect(badge.className).toContain('text-mcs-warning-fg')
    expect(badge.className).toContain('border-mcs-warning-border')
    const backupBadge = screen.getByText('备份')
    expect(backupBadge.className).toContain('text-mcs-info-fg')
  })
})

describe('TaskList 上次运行结果标记', () => {
  /** 单任务列表（虚构数据），按 lastRunStatus 渲染验证结果标记 */
  function renderOneTask(status: ScheduledTask['lastRunStatus'], lastRunAt: string | null) {
    const task: ScheduledTask = {
      id: 9,
      instanceId: 'demo',
      name: '结果标记任务',
      type: 'restart',
      cronExpression: '0 4 * * *',
      command: null,
      isEnabled: true,
      lastRunAt,
      lastRunStatus: status,
      lastRunError: status === 'failed' ? 'RCON 不可用' : null,
      nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    renderList({ tasks: [task] })
  }

  it('success → 显示成功标记', () => {
    renderOneTask('success', new Date().toISOString())
    expect(screen.getByText('成功')).toBeInTheDocument()
  })

  it('failed → 显示失败标记', async () => {
    renderOneTask('failed', new Date().toISOString())
    expect(screen.getByText('失败')).toBeInTheDocument()

    // 失败原因 tooltip 内容 break-all：无空格长串（压缩 JSON/路径）不溢出 tooltip 框
    const user = userEvent.setup()
    await user.hover(screen.getByText('失败'))
    expect(await screen.findByText('RCON 不可用')).toHaveClass('break-all')
  })

  it('skipped → 显示跳过标记（warning 语义，备份互斥跳过）', () => {
    renderOneTask('skipped', new Date().toISOString())
    expect(screen.getByText('跳过')).toBeInTheDocument()
  })

  it('never（未运行）→ 不显示结果标记', () => {
    renderOneTask('never', null)
    expect(screen.queryByText('成功')).not.toBeInTheDocument()
    expect(screen.queryByText('失败')).not.toBeInTheDocument()
    expect(screen.queryByText('跳过')).not.toBeInTheDocument()
  })
})

describe('TaskList 交互', () => {
  it('启用开关切换回调（onToggle(task, enabled)）', async () => {
    const user = userEvent.setup()
    const { onToggle } = renderList()
    await user.click(screen.getByRole('switch', { name: '每日自动重启 启用开关' }))
    expect(onToggle).toHaveBeenCalledWith(mockTasks[0], false)
    await user.click(screen.getByRole('switch', { name: '清理告示牌命令 启用开关' }))
    expect(onToggle).toHaveBeenCalledWith(mockTasks[2], true)
  })

  it('立即执行/编辑/删除按钮按 aria-label 点击回调', async () => {
    const user = userEvent.setup()
    const { onRunNow, onEdit, onDelete } = renderList()
    await user.click(screen.getByRole('button', { name: '每日自动重启 立即执行' }))
    expect(onRunNow).toHaveBeenCalledWith(mockTasks[0])
    await user.click(screen.getByRole('button', { name: '每日自动重启 编辑' }))
    expect(onEdit).toHaveBeenCalledWith(mockTasks[0])
    await user.click(screen.getByRole('button', { name: '每日自动重启 删除' }))
    expect(onDelete).toHaveBeenCalledWith(mockTasks[0])
  })

  it('runningTaskId 命中行「立即执行」禁用，其余行不受影响', () => {
    renderList({ runningTaskId: 1 })
    expect(screen.getByRole('button', { name: '每日自动重启 立即执行' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '每日备份 立即执行' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '清理告示牌命令 立即执行' })).toBeEnabled()
  })
})

describe('TaskList 空态与加载态', () => {
  it('空态文案 + 新建任务按钮', async () => {
    const user = userEvent.setup()
    const { onNewTask } = renderList({ tasks: [] })
    expect(screen.getByText('暂无定时任务')).toBeInTheDocument()
    expect(screen.getByText('创建定时任务以自动执行重启、备份等操作')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建任务' }))
    expect(onNewTask).toHaveBeenCalled()
  })

  it('加载态显示骨架行（不显示空态与列表）', () => {
    renderList({ tasks: [], isLoading: true })
    expect(screen.getByTestId('task-skeletons')).toBeInTheDocument()
    expect(screen.queryByText('暂无定时任务')).not.toBeInTheDocument()
    expect(screen.queryByText('每日自动重启')).not.toBeInTheDocument()
  })
})
