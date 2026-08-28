/**
 * UpgradeDialog 测试（实例版本升级 P0-4）：
 * - 渲染：类型三卡（默认 vanilla）+ 警示条 + 版本下拉（当前版本禁选）
 * - 交互：类型切换重置版本选择；版本选中后开始升级 POST 202 受理
 * - 受理失败：alert 友好文案（错误码 50000）
 * - WS 进度注入：applyUpgradeProgress → 进度条 + 中文 stage 标签 + 45%
 * - 终态：成功块（completed）/ 回滚块（rolled_back）→ 关闭即清空该实例进度
 * - 升级中：取消按钮禁用 + Escape 不触发关闭
 * mock 数据为结构占位虚构（虚构实例/版本），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { handlers, mockInstanceStatus, upgradeMock } from '@/test/mocks/handlers'
import { UpgradeDialog } from '../upgrade-dialog'
import { applyUpgradeProgress, useUpgradeStore } from '@/stores/upgrade'
import { useConnectionStore } from '@/stores/connection'
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

/** 打开版本下拉并选中指定版本 */
async function selectVersion(user: ReturnType<typeof userEvent.setup>, version: string) {
  await user.click(screen.getByRole('combobox'))
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${version}`) }))
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useUpgradeStore.setState({ progress: {} })
  upgradeMock.shouldFail = false
  upgradeMock.conflict = false
})

describe('UpgradeDialog', () => {
  it('渲染：类型三卡默认 vanilla + 警示条 + 开始升级禁用（未选版本）', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: 'Vanilla' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Purpur' })).toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: 'Paper' }))
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'true')
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
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '开始升级' })).toBeEnabled(),
    )
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

    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
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
})
