/**
 * GeneralPreferencesFields 测试：
 * 这张卡只剩**浏览器本地偏好**（主题 / 终端自动滚动 / 命令二次确认），三项都只落 localStorage，
 * 换设备不跟随。实例级配置（内存、JVM、自动重启）不在这里，它们的写入口是 PUT /instances/:id。
 * - 主题切换：Select 暗色/亮色 → ui store theme 更新
 * - 两个开关：拨动只改 ui store，不发任何请求
 * - 反向锚点：卡内不出现实例级配置项（本地偏好面板的边界，防止 scope 再次漂移）
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { Toaster } from 'sonner'
import { handlers } from '@tests/support/handlers'
import { GeneralPreferencesFields } from '@/features/settings/components/general-preferences-fields'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

// radix Select 依赖 Pointer Capture API（jsdom 未实现，缺失会崩溃；deploy-dialog 同款补丁）
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

function renderPanel() {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <GeneralPreferencesFields />
      <Toaster />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useUiStore.setState({ theme: 'dark', terminalAutoScroll: true, confirmCommands: false })
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    hasConnectedOnce: true,
    lastStatusEvent: null,
  })
})

afterEach(() => {
  server.resetHandlers()
})

describe('GeneralPreferencesFields 浏览器本地偏好', () => {
  it('三项都在：界面主题 / 终端自动滚动 / 命令执行二次确认', () => {
    renderPanel()

    expect(screen.getByRole('combobox', { name: '界面主题' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '终端自动滚动' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '命令执行二次确认' })).toBeInTheDocument()
  })

  /* 反向锚点：本地偏好面板里出现实例级配置，说明「换设备跟不跟」这条分组判据漂了 */
  it('不出现实例级配置项：自动重启已搬到实例设置，这里不该再有', () => {
    renderPanel()

    expect(screen.queryByText('意外停止自动重启')).not.toBeInTheDocument()
    expect(screen.queryByText('意外停止后自动重启')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '意外停止后自动重启' })).not.toBeInTheDocument()
    // 也不该留「未选择实例 — 自动重启为服务器实例配置」这类占位：那说明它还在这张卡里
    expect(screen.queryByText(/自动重启为服务器实例配置/)).not.toBeInTheDocument()
  })

  it('两个开关只改浏览器本地 store，不发请求', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole('switch', { name: '终端自动滚动' }))
    expect(useUiStore.getState().terminalAutoScroll).toBe(false)

    await user.click(screen.getByRole('switch', { name: '命令执行二次确认' }))
    expect(useUiStore.getState().confirmCommands).toBe(true)
  })

  it('无实例时三项照常可用（本地偏好与有没有实例无关）', () => {
    useServerStore.setState({ instanceId: null })
    renderPanel()

    expect(screen.getByRole('combobox', { name: '界面主题' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '终端自动滚动' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '命令执行二次确认' })).toBeInTheDocument()
  })
})

describe('GeneralPreferencesFields 主题切换', () => {
  it('Select 暗色/亮色 → ui store theme 更新（本地偏好即时生效）', async () => {
    const user = userEvent.setup()
    renderPanel()
    expect(useUiStore.getState().theme).toBe('dark')
    // 当前主题回显在 Select trigger 上
    expect(screen.getByRole('combobox', { name: '界面主题' })).toHaveTextContent('暗色')

    await user.click(screen.getByRole('combobox', { name: '界面主题' }))
    await user.click(await screen.findByRole('option', { name: '亮色' }))
    expect(useUiStore.getState().theme).toBe('light')

    // 再切回暗色
    await user.click(screen.getByRole('combobox', { name: '界面主题' }))
    await user.click(await screen.findByRole('option', { name: '暗色' }))
    expect(useUiStore.getState().theme).toBe('dark')
  })
})
