/**
 * TaskDialog + CronEditor 测试：
 * 新建校验/类型切换/描述实时/预置回填/可视化编辑器联动/保存 payload/编辑回填/dirty 关闭拦截/保存中禁用
 * mock 数据为结构占位（虚构任务名），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster, toast as sonnerToast } from 'sonner'
import { TaskDialog } from '../task-dialog'
import type { ScheduledTask, TaskRunHistory } from '@/api/types'

// 执行历史 hook 模块级 mock：对话框测试不依赖网络层/QueryClientProvider，
// 由用例按需注入返回值（默认空数据 → 编辑模式显示「暂无执行记录」）
const useTaskHistoryMock = vi.hoisted(() =>
  vi.fn<() => {
    data?: TaskRunHistory[]
    isLoading: boolean
    isError?: boolean
    error?: Error | null
    refetch?: () => Promise<unknown>
  }>(() => ({ isLoading: false })),
)
vi.mock('../../queries', () => ({ useTaskHistory: useTaskHistoryMock }))

// jsdom 未实现 Pointer Capture API（radix Select/下拉依赖，缺失会崩溃）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

beforeEach(() => {
  // sonner toast 存于模块级 store，跨测试残留会导致同文案 toast 重复匹配
  sonnerToast.dismiss()
  useTaskHistoryMock.mockClear()
  useTaskHistoryMock.mockImplementation(() => ({ data: undefined, isLoading: false }))
})

// ── 结构占位 mock ────────────────────────────────────────────────

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 1,
    instanceId: 'demo',
    name: '每日自动重启',
    type: 'restart',
    cronExpression: '0 4 * * *',
    command: null,
    isEnabled: true,
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunError: null,
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderDialog(opts: { task?: ScheduledTask | null; saving?: boolean } = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(
    <>
      <TaskDialog
        task={opts.task === undefined ? null : opts.task}
        onClose={onClose}
        onSave={onSave}
        saving={opts.saving ?? false}
      />
      <Toaster />
    </>,
  )
  return { onSave, onClose }
}

/** dirty 确认弹窗定位（嵌套 Dialog 时外层内容可能 aria-hidden，逐层找标题） */
async function findConfirmDialog() {
  const dialogs = await screen.findAllByRole('dialog')
  const confirm = dialogs.find((d) => within(d).queryByText('放弃未保存的修改？'))
  expect(confirm).toBeDefined()
  return confirm!
}

// ── 新建模式与校验 ───────────────────────────────────────────────

describe('TaskDialog 新建模式与校验', { timeout: 15000 }, () => {
  it('默认渲染：标题/字段默认值/类型重启/命令框隐藏/未启用/创建按钮', () => {
    renderDialog()
    expect(screen.getByText('新建定时任务')).toBeInTheDocument()
    expect(screen.getByLabelText('任务名称')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: '任务类型' })).toHaveTextContent('重启服务器')
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('')
    expect(screen.getByRole('switch', { name: '启用' })).toBeChecked()
    expect(screen.queryByLabelText('执行的命令')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })

  it('空名称与空 cron：行内错误提示且不触发 onSave', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.getByText('请填写任务名称')).toBeInTheDocument()
    expect(screen.getByText('请填写 Cron 表达式')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('仅填名称（cron 为空）：仅显示 cron 行内错误', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.type(screen.getByLabelText('任务名称'), '只有名字')
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.queryByText('请填写任务名称')).not.toBeInTheDocument()
    expect(screen.getByText('请填写 Cron 表达式')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('类型切换：command 显示命令框，切回其他类型隐藏', async () => {
    const user = userEvent.setup()
    renderDialog()
    expect(screen.queryByLabelText('执行的命令')).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: '任务类型' }))
    await user.click(await screen.findByRole('option', { name: '执行命令' }))
    expect(screen.getByLabelText('执行的命令')).toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: '任务类型' }))
    await user.click(await screen.findByRole('option', { name: '重启服务器' }))
    expect(screen.queryByLabelText('执行的命令')).not.toBeInTheDocument()
  })
})

// ── Cron 表达式交互 ──────────────────────────────────────────────

describe('TaskDialog Cron 表达式交互', { timeout: 15000 }, () => {
  it('cron 描述随输入实时更新', async () => {
    const user = userEvent.setup()
    renderDialog()
    const cronInput = screen.getByLabelText('Cron 表达式')
    await user.type(cronInput, '0 4 * * *')
    expect(screen.getByText('04:00每天执行')).toBeInTheDocument()
    await user.clear(cronInput)
    await user.type(cronInput, '*/30 * * * *')
    expect(screen.getByText('每30分钟每天执行')).toBeInTheDocument()
    await user.clear(cronInput)
    await user.type(cronInput, '0 4 * * 1')
    expect(screen.getByText('04:00每周一执行')).toBeInTheDocument()
  })

  it('预置 chip 点击回填 cron + 描述 + 激活态', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: '每天 4:00' }))
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('0 4 * * *')
    expect(screen.getByText('04:00每天执行')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '每天 4:00' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('预置 chip 点击自动填充名称建议（名称为空时）', async () => {
    const user = userEvent.setup()
    renderDialog()
    expect(screen.getByLabelText('任务名称')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: '每天 4:00' }))
    expect(screen.getByLabelText('任务名称')).toHaveValue('每天 4:00 重启服务器')
  })

  it('预置 chip 点击不覆盖已有名称', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByLabelText('任务名称'), '自定义任务名')
    await user.click(screen.getByRole('button', { name: '每小时' }))
    expect(screen.getByLabelText('任务名称')).toHaveValue('自定义任务名')
  })

  it('可视化编辑器：四字段联动回写 + 周字段 chip + 自定义值项 + 双向同步', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: '可视化编辑' }))
    // 空表达式按全 * 显示（四字段 Select + 周字段 chip）
    expect(screen.getByRole('combobox', { name: '分' })).toHaveTextContent('每分钟')
    expect(screen.getByRole('combobox', { name: '时' })).toHaveTextContent('每小时')
    expect(screen.getByRole('combobox', { name: '日' })).toHaveTextContent('每天')
    expect(screen.getByRole('combobox', { name: '月' })).toHaveTextContent('每月')
    // 周字段用 chip 多选：全不选=任意天（*），无 chip 激活
    expect(screen.getByRole('button', { name: '周日' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '周一' })).toHaveAttribute('aria-pressed', 'false')
    // 选「分=0分」「时=4点」→ 逐字段回写完整表达式，描述实时更新
    await user.click(screen.getByRole('combobox', { name: '分' }))
    await user.click(await screen.findByRole('option', { name: '0分' }))
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('0 * * * *')
    await user.click(screen.getByRole('combobox', { name: '时' }))
    await user.click(await screen.findByRole('option', { name: '4点' }))
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('0 4 * * *')
    expect(screen.getByText('04:00每天执行')).toBeInTheDocument()
    // 点击周 chip 选中周一 → 表达式更新
    await user.click(screen.getByRole('button', { name: '周一' }))
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('0 4 * * 1')
    expect(screen.getByRole('button', { name: '周一' })).toHaveAttribute('aria-pressed', 'true')
    // 文本输入非预设值 → 字段下拉出现「自定义: xxx」项
    const cronInput = screen.getByLabelText('Cron 表达式')
    await user.clear(cronInput)
    await user.type(cronInput, '45 * * * *')
    expect(screen.getByRole('combobox', { name: '分' })).toHaveTextContent('自定义: 45')
    await user.click(screen.getByRole('combobox', { name: '分' }))
    expect(await screen.findByRole('option', { name: '自定义: 45' })).toBeInTheDocument()
    // 选预设项 → 回写覆盖自定义值
    await user.click(screen.getByRole('option', { name: '30分' }))
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('30 * * * *')
  })
})

// ── 保存链路 ─────────────────────────────────────────────────────

describe('TaskDialog 保存链路', { timeout: 15000 }, () => {
  it('保存：command 类型 payload 完整（名称/类型/cron/命令/启用）', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.type(screen.getByLabelText('任务名称'), '测试任务')
    await user.click(screen.getByRole('button', { name: '每天 4:00' }))
    await user.click(screen.getByRole('combobox', { name: '任务类型' }))
    await user.click(await screen.findByRole('option', { name: '执行命令' }))
    await user.type(screen.getByLabelText('执行的命令'), 'say hello')
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: '测试任务',
        type: 'command',
        cronExpression: '0 4 * * *',
        command: 'say hello',
        isEnabled: true,
      }),
    )
  })

  it('保存：非 command 类型 command 为 null、默认启用', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.type(screen.getByLabelText('任务名称'), '每日重启任务')
    await user.click(screen.getByRole('button', { name: '每小时' }))
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: '每日重启任务',
        type: 'restart',
        cronExpression: '0 * * * *',
        command: null,
        isEnabled: true,
      }),
    )
  })

  it('编辑模式：初始值回填 + 保存按钮文案「保存」+ 描述反映回填值', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog({
      task: makeTask({
        id: 7,
        name: '公告任务',
        type: 'command',
        cronExpression: '*/30 * * * *',
        command: 'say 欢迎',
        isEnabled: true,
      }),
    })
    expect(screen.getByText('编辑任务')).toBeInTheDocument()
    expect(screen.getByLabelText('任务名称')).toHaveValue('公告任务')
    expect(screen.getByRole('combobox', { name: '任务类型' })).toHaveTextContent('执行命令')
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('*/30 * * * *')
    expect(screen.getByLabelText('执行的命令')).toHaveValue('say 欢迎')
    expect(screen.getByRole('switch', { name: '启用' })).toBeChecked()
    expect(screen.getByText('每30分钟每天执行')).toBeInTheDocument()
    // 改名后保存 payload 带更新值
    await user.clear(screen.getByLabelText('任务名称'))
    await user.type(screen.getByLabelText('任务名称'), '公告任务改')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: '公告任务改',
        type: 'command',
        cronExpression: '*/30 * * * *',
        command: 'say 欢迎',
        isEnabled: true,
      }),
    )
  })

  it('保存中：创建/取消按钮禁用，ESC 不触发确认与关闭', async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog({ saving: true })
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ── dirty 关闭拦截 ───────────────────────────────────────────────

describe('TaskDialog dirty 关闭拦截', { timeout: 15000 }, () => {
  it('无改动时点取消直接关闭，不弹确认', async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('放弃未保存的修改？')).not.toBeInTheDocument()
  })

  it('有改动时点取消需确认：继续编辑保留，放弃修改才关闭', async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog()
    await user.type(screen.getByLabelText('任务名称'), '改过的名字')
    await user.click(screen.getByRole('button', { name: '取消' }))
    const confirm = await findConfirmDialog()
    expect(onClose).not.toHaveBeenCalled()
    // 继续编辑 → 确认关闭，任务弹窗保留
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    // 再次取消 → 放弃修改 → onClose
    await user.click(screen.getByRole('button', { name: '取消' }))
    const confirm2 = await findConfirmDialog()
    await user.click(within(confirm2).getByRole('button', { name: '放弃修改' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('有改动时按 ESC 弹确认；继续编辑不关闭', async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog()
    await user.type(screen.getByLabelText('任务名称'), 'abc')
    await user.keyboard('{Escape}')
    const confirm = await findConfirmDialog()
    await user.click(within(confirm).getByRole('button', { name: '继续编辑' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('有改动时点遮罩弹确认；放弃修改后关闭', async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog()
    await user.type(screen.getByLabelText('任务名称'), 'abc')
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).not.toBeNull()
    await user.click(overlay!)
    const confirm = await findConfirmDialog()
    expect(onClose).not.toHaveBeenCalled()
    await user.click(within(confirm).getByRole('button', { name: '放弃修改' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ── 最近执行时间线（issue #299）──────────────────────────────────

const RUN_HISTORY_MOCK: TaskRunHistory[] = [
  { id: 12, taskId: 1, runAt: '2026-09-02T04:00:05.000Z', status: 'success', error: null, durationMs: 850 },
  { id: 11, taskId: 1, runAt: '2026-09-01T04:00:03.000Z', status: 'failed', error: 'RCON 不可用', durationMs: 3000 },
  { id: 10, taskId: 1, runAt: '2026-08-31T04:00:01.000Z', status: 'skipped', error: null, durationMs: null },
]

describe('TaskDialog 最近执行时间线（issue #299）', { timeout: 15000 }, () => {
  it('编辑模式：渲染倒序执行历史（状态/耗时/失败原因），hook 收到任务 id', () => {
    useTaskHistoryMock.mockImplementation(() => ({ data: RUN_HISTORY_MOCK, isLoading: false }))
    renderDialog({ task: makeTask({ id: 1 }) })

    const list = screen.getByRole('list', { name: '最近执行列表' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    // 最新在前
    const successItem = items[0]!
    const failedItem = items[1]!
    const skippedItem = items[2]!
    expect(within(successItem).getByText('成功')).toBeInTheDocument()
    expect(within(successItem).getByText(/850ms/)).toBeInTheDocument()
    expect(within(failedItem).getByText('失败')).toBeInTheDocument()
    expect(within(failedItem).getByText('RCON 不可用')).toBeInTheDocument()
    expect(within(failedItem).getByText(/3\.0s/)).toBeInTheDocument()
    expect(within(skippedItem).getByText('跳过')).toBeInTheDocument()
    // 跳过行无耗时展示
    expect(within(skippedItem).queryByText(/ms$/)).not.toBeInTheDocument()
    expect(useTaskHistoryMock).toHaveBeenCalledWith(1)
  })

  it('编辑模式：历史为空 → 「暂无执行记录」占位', () => {
    renderDialog({ task: makeTask({ id: 1 }) })
    expect(screen.getByTestId('task-run-history')).toBeInTheDocument()
    expect(screen.getByText('暂无执行记录')).toBeInTheDocument()
  })

  it('编辑模式：加载中 → 骨架占位', () => {
    useTaskHistoryMock.mockImplementation(() => ({ data: undefined, isLoading: true }))
    renderDialog({ task: makeTask({ id: 1 }) })
    expect(screen.getByLabelText('加载执行历史中')).toBeInTheDocument()
  })

  it('编辑模式：历史加载失败 → 错误态而非「暂无执行记录」，含失败原因', () => {
    useTaskHistoryMock.mockImplementation(() => ({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
    }))
    renderDialog({ task: makeTask({ id: 1 }) })
    const history = screen.getByTestId('task-run-history')
    expect(within(history).getByText(/执行历史加载失败/)).toBeInTheDocument()
    // 空态文案不得与错误态混淆（网络失败 ≠ 确无记录）
    expect(within(history).queryByText('暂无执行记录')).not.toBeInTheDocument()
  })

  it('编辑模式：历史错误态点击重试 → 调用 refetch', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined)
    useTaskHistoryMock.mockImplementation(() => ({
      data: undefined,
      isLoading: false,
      isError: true,
      error: null,
      refetch,
    }))
    renderDialog({ task: makeTask({ id: 1 }) })
    const history = screen.getByTestId('task-run-history')
    await userEvent.click(within(history).getByRole('button', { name: '重试' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('新建模式：不渲染执行历史区块，也不调用 hook', () => {
    renderDialog()
    expect(screen.queryByTestId('task-run-history')).not.toBeInTheDocument()
    expect(useTaskHistoryMock).not.toHaveBeenCalled()
  })
})
