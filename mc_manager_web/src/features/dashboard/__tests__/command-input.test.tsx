import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen, fireEvent , waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { CommandInput } from '../components/command-input'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'
import { useCommandBus } from '@/stores/command-bus'
import { useTerminalStore } from '@/stores/terminal'

/**
 * 命令输入组件测试：补全 / 发送（MSW 拦截）/ 快捷 chips
 */

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

function renderInput() {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <CommandInput />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
  useTerminalStore.setState({ buffer: [], instanceId: 'demo', suppressBackfill: false })
  useCommandBus.setState({ baseRunner: null, overlayRunner: null })
})

describe('CommandInput', () => {
  it('输入 / 开头触发补全（命令名前缀）', () => {
    renderInput()
    const input = screen.getByLabelText('服务器命令输入')
    fireEvent.change(input, { target: { value: '/ga' } })
    expect(screen.getByRole('option', { name: /gamemode/ })).toBeInTheDocument()
  })

  it('回车发送命令（MSW 拦截 command 端点）', async () => {
    renderInput()
    const input = screen.getByLabelText('服务器命令输入')
    fireEvent.change(input, { target: { value: 'say hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // RCON 响应插入终端；成功不弹 toast（终端为反馈源），以输入框清空为完成信号
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('快捷 chips：默认 5 条渲染（图标+播放+删除）', () => {
    renderInput()
    expect(screen.getByTitle('give @p diamond 64')).toBeInTheDocument()
    expect(screen.getByTitle('gamemode creative')).toBeInTheDocument()
    expect(screen.getByTitle('time set day')).toBeInTheDocument()
    expect(screen.getByTitle('tp @p 0 100 0')).toBeInTheDocument()
    expect(screen.getByTitle('kill @e[type=!player]')).toBeInTheDocument()
  })

  it('点击 chip 主体仅填充不发送；播放按钮立即发送', async () => {
    renderInput()
    fireEvent.click(screen.getByTitle('time set day'))
    expect(screen.getByLabelText('服务器命令输入')).toHaveValue('time set day')
    fireEvent.click(screen.getByRole('button', { name: /发送 time set day/ }))
    await waitFor(() => expect(screen.getByLabelText('服务器命令输入')).toHaveValue(''))
  })

  it('注册命令总线 runner（Cmd+K 命令域桥）', () => {
    renderInput()
    const runner = useCommandBus.getState().overlayRunner
    expect(runner).not.toBeNull()
  })

  describe('命令历史（↑↓）', () => {
    /** 发送两条命令入历史 */
    const sendCommands = async (cmds: string[]) => {
      const input = screen.getByLabelText('服务器命令输入')
      for (const cmd of cmds) {
        fireEvent.change(input, { target: { value: cmd } })
        fireEvent.keyDown(input, { key: 'Enter' })
        await waitFor(() => expect(input).toHaveValue(''))
      }
    }

    it('↑ 恢复最近发送的命令，再次 ↑ 翻更早一条', async () => {
      renderInput()
      await sendCommands(['say one', 'say two'])
      const input = screen.getByLabelText('服务器命令输入')
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('say two')
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('say one')
    })

    it('↓ 沿历史向下，越过最新恢复导航前草稿', async () => {
      renderInput()
      await sendCommands(['say one', 'say two'])
      const input = screen.getByLabelText('服务器命令输入')
      // 先输入未发送的草稿
      fireEvent.change(input, { target: { value: 'say draft' } })
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('say two')
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue('say draft')
      // 再次 ↓ 无变化（已退出导航）
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue('say draft')
    })

    it('连续相同命令去重（shell 语义）', async () => {
      renderInput()
      await sendCommands(['say same', 'say same', 'say other'])
      const input = screen.getByLabelText('服务器命令输入')
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('say other')
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('say same')
      // 只有一条 say same（不出现两次）
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('say same')
    })

    it('IME 组合期 ↑ 不触发历史导航', async () => {
      renderInput()
      await sendCommands(['say one'])
      const input = screen.getByLabelText('服务器命令输入')
      fireEvent.keyDown(input, { key: 'ArrowUp', isComposing: true })
      expect(input).toHaveValue('')
    })

    it('导航态输入新内容退出导航', async () => {
      renderInput()
      await sendCommands(['say one'])
      const input = screen.getByLabelText('服务器命令输入')
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('say one')
      fireEvent.change(input, { target: { value: 'fresh' } })
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(input).toHaveValue('fresh')
    })
  })
})
