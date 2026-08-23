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
import type { ScheduledTask } from '@/api/types'

// jsdom 未实现 Pointer Capture API（radix Select/下拉依赖，缺失会崩溃）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

beforeEach(() => {
  // sonner toast 存于模块级 store，跨测试残留会导致同文案 toast 重复匹配
  sonnerToast.dismiss()
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
    expect(screen.getByRole('switch', { name: '启用' })).not.toBeChecked()
    expect(screen.queryByLabelText('执行的命令')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })

  it('空名称与空 cron：toast 提示且不触发 onSave', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText('请填写任务名称和 Cron 表达式')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('仅填名称（cron 为空）：仍拦截', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.type(screen.getByLabelText('任务名称'), '只有名字')
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText('请填写任务名称和 Cron 表达式')).toBeInTheDocument()
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

  it('可视化编辑器：五字段联动回写 + 自定义值项 + 双向同步', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: '可视化编辑' }))
    // 空表达式按全 * 显示
    expect(screen.getByRole('combobox', { name: '分' })).toHaveTextContent('每分钟')
    expect(screen.getByRole('combobox', { name: '时' })).toHaveTextContent('每小时')
    expect(screen.getByRole('combobox', { name: '日' })).toHaveTextContent('每天')
    expect(screen.getByRole('combobox', { name: '月' })).toHaveTextContent('每月')
    expect(screen.getByRole('combobox', { name: '周' })).toHaveTextContent('每天')
    // 选「分=0分」「时=4点」→ 逐字段回写完整表达式，描述实时更新
    // （空表达式按全 * 处理：仅改小时字段会得到 `* 4 * * *`）
    await user.click(screen.getByRole('combobox', { name: '分' }))
    await user.click(await screen.findByRole('option', { name: '0分' }))
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('0 * * * *')
    await user.click(screen.getByRole('combobox', { name: '时' }))
    await user.click(await screen.findByRole('option', { name: '4点' }))
    expect(screen.getByLabelText('Cron 表达式')).toHaveValue('0 4 * * *')
    expect(screen.getByText('04:00每天执行')).toBeInTheDocument()
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
    await user.click(screen.getByRole('switch', { name: '启用' }))
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

  it('保存：非 command 类型 command 为 null、未启用为 false', async () => {
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
        isEnabled: false,
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
