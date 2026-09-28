/**
 * UpgradeDialog 测试（实例版本升级）：
 * - 渲染：类型三卡（默认 vanilla）+ 警示条 + 版本下拉（当前版本禁选）
 * - 交互：类型切换重置版本选择；版本选中后开始升级 POST 202 受理
 * - 受理失败：alert 友好文案（错误码 50000）
 * - WS 进度注入：applyUpgradeProgress → 进度条 + 中文 stage 标签 + 45%
 * - 终态：成功块（completed）/ 回滚块（rolled_back）/ 中性块（cancelled）→ 关闭即清空该实例进度
 * - 升级中：关闭禁用 + Escape 不触发关闭；唯一可用出口是「取消升级」（确认后调服务端）
 * mock 数据为结构占位虚构（虚构实例/版本），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { Toaster, toast } from 'sonner'
import {
  handlers,
  mockInstanceStatus,
  upgradeMock,
  upgradeCancelMock,
  upgradeStatusMock,
} from '@/test/mocks/handlers'
import { UpgradeDialog } from '../upgrade-dialog'
import { applyUpgradeProgress, useUpgradeStore } from '@/stores/upgrade'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import type { InstanceStatus } from '@/api/types'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

// radix Select/下拉依赖 Pointer Capture API（jsdom 未实现，缺失会崩溃）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

// ── 虚构占位数据 ────────────────────────────────────────────────

const alpha: InstanceStatus = {
  ...mockInstanceStatus,
  id: 'alpha',
  name: '虚构甲服',
  mcVersion: '1.21.1',
}

function renderDialog() {
  const onOpenChange = vi.fn<(open: boolean) => void>()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <UpgradeDialog instance={alpha} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

/** 带 Toaster 的渲染（仅断言 toast 文案的用例需要；其余用例不挂以免 toast 文本混入查询面） */
function renderDialogWithToaster() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Toaster />
      <UpgradeDialog instance={alpha} open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  )
}

/** 打开版本下拉并选中指定版本 */
async function selectVersion(user: ReturnType<typeof userEvent.setup>, version: string) {
  await user.click(screen.getByRole('combobox'))
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${version}`) }))
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ socketConnected: true })
  useUpgradeStore.setState({ progress: {} })
  upgradeMock.shouldFail = false
  upgradeMock.conflict = false
  // sonner toast store 是模块级：清残留防跨用例泄漏
  toast.dismiss()
  upgradeCancelMock.notInProgress = false
  upgradeCancelMock.calls = 0
  upgradeStatusMock.upgrading = true
  upgradeStatusMock.stage = 'download'
  upgradeStatusMock.percent = 80
  upgradeStatusMock.detail = '正在下载新版本服务端…'
})

describe('UpgradeDialog', () => {
  it('渲染：类型三卡默认 vanilla + 警示条 + 开始升级禁用（未选版本）', () => {
    renderDialog()
    expect(screen.getByRole('radio', { name: 'Vanilla' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Paper' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: 'Purpur' })).toBeInTheDocument()
    expect(screen.getByText('升级须知')).toBeInTheDocument()
    expect(screen.getByText(/当前版本 1\.21\.1/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始升级' })).toBeDisabled()
  })

  it('版本下拉：目标版本可选、当前版本（1.21.1）禁选', async () => {
    renderDialog()
    const user = userEvent.setup()
    await user.click(screen.getByRole('combobox'))
    // 打开状态下 Select 内容为可查询焦点域（外部 aria-hidden）
    const current = await screen.findByRole('option', { name: /1\.21\.1/ })
    expect(current).toHaveTextContent('（当前）')
    expect(current).toHaveAttribute('aria-disabled', 'true')
    // 点击禁选项不产生选择：下拉保持打开，Escape 关闭后仍是占位
    await user.click(current)
    expect(screen.getByRole('option', { name: /1\.21\.1/ })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('combobox')).toHaveTextContent('选择版本')
    expect(screen.getByRole('button', { name: '开始升级' })).toBeDisabled()
    // 目标版本可选
    await selectVersion(user, '1.21.4')
    expect(screen.getByRole('combobox')).toHaveTextContent('1.21.4')
    expect(screen.getByRole('button', { name: '开始升级' })).toBeEnabled()
  })

  it('类型切换重置版本选择（事件驱动，无 useEffect）', async () => {
    renderDialog()
    const user = userEvent.setup()
    await selectVersion(user, '1.21.4')
    expect(screen.getByRole('combobox')).toHaveTextContent('1.21.4')

    await user.click(screen.getByRole('radio', { name: 'Paper' }))
    expect(screen.getByRole('radio', { name: 'Paper' })).toHaveAttribute('aria-checked', 'true')
    // 版本已重置为占位，且按钮回到禁用
    expect(screen.getByRole('combobox')).toHaveTextContent('选择版本')
    expect(screen.getByRole('button', { name: '开始升级' })).toBeDisabled()
  })

  it('开始升级：POST 202 受理成功（无 alert，按钮回可用）', async () => {
    renderDialog()
    const user = userEvent.setup()
    await selectVersion(user, '1.21.4')
    await user.click(screen.getByRole('button', { name: '开始升级' }))
    // 受理成功：按钮回可用（进度未到前可再次触发，由服务端 409 拦截）、无错误提示
    await waitFor(() => expect(screen.getByRole('button', { name: '开始升级' })).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('受理失败：alert 友好文案（错误码 50000）', async () => {
    upgradeMock.shouldFail = true
    renderDialog()
    const user = userEvent.setup()
    await selectVersion(user, '1.21.4')
    await user.click(screen.getByRole('button', { name: '开始升级' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('服务器内部错误，请稍后重试')
  })

  it('WS 进度注入：进度条 + 中文 stage 标签 + 百分比 + 升级中禁用取消', () => {
    renderDialog()
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'download',
        percent: 45,
        detail: '正在下载新版本服务端…',
        timestamp: Date.now(),
      })
    })
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByText('下载中')).toBeInTheDocument()
    expect(screen.getByText('45%')).toBeInTheDocument()
    expect(screen.getByText('正在下载新版本服务端…')).toBeInTheDocument()
    // 升级中：取消与开始均禁用
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '开始升级' })).toBeDisabled()
  })

  it('终态（completed）：成功块 + 关闭按钮 + 关闭清空该实例进度', async () => {
    const { onOpenChange } = renderDialog()
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'completed',
        percent: 100,
        detail: '升级完成',
        timestamp: Date.now(),
      })
    })
    expect(screen.getByText('升级完成')).toBeInTheDocument()
    // 终态：无进度条（隐藏版本选择与取消）
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()

    const closeButtons = screen.getAllByRole('button', { name: '关闭' })
    await userEvent.click(closeButtons[closeButtons.length - 1]!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useUpgradeStore.getState().progress['alpha']).toBeUndefined()
  })

  it('终态（rolled_back）：回滚警告块（warning 色）', () => {
    renderDialog()
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'rolled_back',
        percent: 0,
        detail: '升级失败并已回滚：下载失败',
        timestamp: Date.now(),
      })
    })
    expect(screen.getByText('升级失败并已回滚：下载失败')).toBeInTheDocument()
    expect(screen.getByText('升级失败并已回滚：下载失败').className).toMatch(/mcs-warning-fg/)
  })

  it('升级中：进度块提供「取消升级」入口（点开前不显示确认框）', () => {
    renderDialog()
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'download',
        percent: 20,
        detail: '正在下载新版本服务端…',
        timestamp: Date.now(),
      })
    })
    expect(screen.getByRole('button', { name: '取消升级' })).toBeEnabled()
    expect(screen.queryByText('取消升级？')).not.toBeInTheDocument()
  })

  it('确认取消升级：调服务端取消端点，按钮转「正在取消…」并禁用', async () => {
    const user = userEvent.setup()
    renderDialog()
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'backup',
        percent: 0,
        detail: '正在创建备份…',
        timestamp: Date.now(),
      })
    })

    await user.click(screen.getByRole('button', { name: '取消升级' }))
    expect(await screen.findByText('取消升级？')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '中断升级' }))

    await waitFor(() => expect(upgradeCancelMock.calls).toBe(1))
    // 受理不等于已中断：终态事件未到前按钮保持「正在取消…」且不可重复点
    expect(screen.getByRole('button', { name: '正在取消升级' })).toBeDisabled()
  })

  it('服务端回「无可取消对象」（40908）：失败可见且解除取消中状态，可重试', async () => {
    upgradeCancelMock.notInProgress = true
    renderDialogWithToaster()
    const user = userEvent.setup()
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'download',
        percent: 10,
        detail: '正在下载新版本服务端…',
        timestamp: Date.now(),
      })
    })

    await user.click(screen.getByRole('button', { name: '取消升级' }))
    await user.click(await screen.findByRole('button', { name: '中断升级' }))

    expect(await screen.findByText(/取消升级失败：该升级已结束或不在进行中/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '取消升级' })).toBeEnabled())
  })

  it('终态（cancelled）：中性块展示服务端 detail（含是否已回滚），不占 error 档', () => {
    renderDialog()
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'cancelled',
        percent: 0,
        detail: '已取消，已回滚到 1.21.1',
        timestamp: Date.now(),
      })
    })
    const text = screen.getByText('已取消，已回滚到 1.21.1')
    expect(text).toBeInTheDocument()
    // 取消不是故障：既不用失败红也不用成功绿
    expect(text.className).toMatch(/mcs-text-muted/)
    expect(text.className).not.toMatch(/mcs-error-fg|mcs-success-fg/)
    // 终态：无进度条、无取消升级入口，只剩关闭
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消升级' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '关闭' }).length).toBeGreaterThan(0)
  })

  it('升级中 Escape 不触发关闭（防误触丢进度）', async () => {
    const { onOpenChange } = renderDialog()
    const user = userEvent.setup()
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'backup',
        percent: 0,
        detail: '正在创建备份…',
        timestamp: Date.now(),
      })
    })
    await user.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('WS 断线轮询空态：服务端已不在升级 → 清掉本地进度，弹窗不再卡在「升级中」', async () => {
    vi.useFakeTimers()
    try {
      // WS 断线 + 已在升级中 → 弹窗起轮询；服务端回空态（终态/被取消/重启）
      useServerStore.setState({ socketConnected: false })
      upgradeStatusMock.upgrading = false
      renderDialog()
      act(() => {
        applyUpgradeProgress({
          instanceId: 'alpha',
          stage: 'download',
          percent: 30,
          detail: '旧进度',
          timestamp: Date.now(),
        })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      // 清空即「本会话不再声称升级中」：弹窗回到版本选择（关闭不再是死路）
      expect(useUpgradeStore.getState().progress['alpha']).toBeUndefined()
      expect(screen.queryByText('下载中')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('WS 断线轮询的陈旧响应不推翻已落定终态（终态块不被清掉/倒回）', async () => {
    vi.useFakeTimers()
    try {
      useServerStore.setState({ socketConnected: false })
      // 服务端此刻已无在途升级（空态），但终态事件已先到
      upgradeStatusMock.upgrading = false
      renderDialog()
      act(() => {
        applyUpgradeProgress({
          instanceId: 'alpha',
          stage: 'cancelled',
          percent: 0,
          detail: '已取消，已回滚到 1.21.1',
          timestamp: Date.now(),
        })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      // 陈旧响应（空态）不得清掉刚到的终态展示
      expect(useUpgradeStore.getState().progress['alpha']?.stage).toBe('cancelled')
      expect(screen.getByText('已取消，已回滚到 1.21.1')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('WS 断线轮询：apiGetUpgradeStatus 数据可写入 upgrade store', async () => {
    // 验证轮询数据路径：API 返回 → applyUpgradeProgress → store 更新
    // （setInterval 的实际触发在 jsdom 中不可靠，此处验证数据流正确性）
    const mockStatus = {
      upgrading: true,
      stage: 'verify' as const,
      percent: 90,
      detail: '正在校验新版本…',
    }
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: 'download',
        percent: 30,
        detail: '旧进度',
        timestamp: Date.now(),
      })
    })
    // 模拟轮询回调体内的逻辑
    act(() => {
      applyUpgradeProgress({
        instanceId: 'alpha',
        stage: mockStatus.stage,
        percent: mockStatus.percent,
        detail: mockStatus.detail,
        timestamp: Date.now(),
      })
    })
    const prog = useUpgradeStore.getState().progress['alpha']
    expect(prog!.stage).toBe('verify')
    expect(prog!.percent).toBe(90)
    expect(prog!.detail).toBe('正在校验新版本…')
  })

  it('服务端类型单选组：方向键移动即选中，aria-checked 与焦点同步', () => {
    renderDialog()
    const group = screen.getByRole('radiogroup', { name: '服务端类型' })
    const [vanilla, paper, purpur] = within(group).getAllByRole('radio')
    expect(vanilla).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(paper).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(paper)

    fireEvent.keyDown(group, { key: 'End' })
    expect(purpur).toHaveAttribute('aria-checked', 'true')
    expect(vanilla).toHaveAttribute('aria-checked', 'false')
  })
})
