import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
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
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
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
    // chip 主体按钮的名称即命令全文（文本内容），tooltip 全文由 Radix Tooltip 提供
    expect(screen.getByRole('button', { name: 'give @p diamond 64' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'gamemode creative' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'time set day' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'tp @p 0 100 0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'kill @e[type=!player]' })).toBeInTheDocument()
  })

  it('删除快捷指令：经二次确认后移除并更新持久化', () => {
    renderInput()
    fireEvent.click(screen.getByRole('button', { name: '删除 give @p diamond 64' }))
    // 确认前不删除（Dialog modal 置背景 aria-hidden，role 查询不可用，用文本断言）
    expect(screen.getByText('give @p diamond 64')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^删除$/ }))
    expect(screen.queryByText('give @p diamond 64')).not.toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem('mcs-command-presets') ?? '[]') as string[]
    expect(stored).not.toContain('give @p diamond 64')
  })

  it('点击 chip 主体仅填充不发送；播放按钮立即发送', async () => {
    renderInput()
    fireEvent.click(screen.getByRole('button', { name: 'time set day' }))
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

  describe('RCON 降级横幅', () => {
    it('isRunning + !isRconConnected 时显示降级横幅', () => {
      useServerStore.setState({
        status: { isRunning: true, capabilities: { rcon: false, msmp: false } } as NonNullable<
          ReturnType<typeof useServerStore.getState>['status']
        >,
      })
      renderInput()
      const banner = screen.getByRole('status')
      expect(banner).toBeInTheDocument()
      expect(banner).toHaveTextContent('RCON 未启用，命令已发送但响应不可见')
    })

    it('isRunning + isRconConnected 时不显示横幅', () => {
      useServerStore.setState({
        status: { isRunning: true, capabilities: { rcon: true, msmp: false } } as NonNullable<
          ReturnType<typeof useServerStore.getState>['status']
        >,
      })
      renderInput()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('!isRunning 时不显示横幅', () => {
      useServerStore.setState({ status: null })
      renderInput()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })

  describe('历史状态回显（sent/failed 指示器）', () => {
    const HISTORY_KEY = 'mcs-command-history'

    it('成功命令入列 + ↑ 导航显示「已送达」', async () => {
      renderInput()
      const input = screen.getByLabelText('服务器命令输入')
      // 非导航态指示器不显示
      expect(screen.queryByText('已送达')).not.toBeInTheDocument()
      fireEvent.change(input, { target: { value: 'say ok' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(input).toHaveValue(''))
      // ↑ 进入导航 → 指示器出现
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(input).toHaveValue('say ok')
      expect(screen.getByText('已送达')).toBeInTheDocument()
      // 编辑退出导航 → 指示器消失
      fireEvent.change(input, { target: { value: 'fresh' } })
      expect(screen.queryByText('已送达')).not.toBeInTheDocument()
    })

    it('失败命令入列含 error，↑ 导航显示「失败: 原因」', async () => {
      server.use(
        http.post('*/api/v1/instances/:id/command', () =>
          HttpResponse.json(
            {
              status: 'error',
              code: 99999,
              message: 'mock 命令失败原因',
              details: null,
              timestamp: new Date().toISOString(),
            },
            { status: 500 },
          ),
        ),
      )
      renderInput()
      const input = screen.getByLabelText('服务器命令输入')
      fireEvent.change(input, { target: { value: 'say bad' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      // 失败 toast + 输入框不清空（失败保留输入）
      expect(await screen.findByText(/命令发送失败/)).toBeInTheDocument()
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(screen.getByText('失败: mock 命令失败原因')).toBeInTheDocument()
    })

    it('连续重复命令仅更新状态不重复入列（后态覆盖前态）', async () => {
      renderInput()
      const input = screen.getByLabelText('服务器命令输入')
      // 第一次成功入列
      fireEvent.change(input, { target: { value: 'say dup' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(input).toHaveValue(''))
      // 第二次失败（覆盖状态）
      server.use(
        http.post('*/api/v1/instances/:id/command', () =>
          HttpResponse.json(
            {
              status: 'error',
              code: 99999,
              message: 'mock 二次失败',
              details: null,
              timestamp: new Date().toISOString(),
            },
            { status: 500 },
          ),
        ),
      )
      fireEvent.change(input, { target: { value: 'say dup' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(await screen.findByText(/命令发送失败/)).toBeInTheDocument()
      // 历史仍只有一条
      const stored = JSON.parse(localStorage.getItem(HISTORY_KEY)!) as string[]
      expect(stored.filter((c) => c === 'say dup').length).toBe(1)
      // ↑ 导航显示最新（失败）状态
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(screen.getByText('失败: mock 二次失败')).toBeInTheDocument()
    })
  })

  describe('命令历史持久化（localStorage）', () => {
    const HISTORY_KEY = 'mcs-command-history'

    it('发送命令后写入 localStorage', async () => {
      renderInput()
      const input = screen.getByLabelText('服务器命令输入')
      fireEvent.change(input, { target: { value: 'say persist-test' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(input).toHaveValue(''))
      const stored = JSON.parse(localStorage.getItem(HISTORY_KEY)!) as string[]
      expect(Array.isArray(stored)).toBe(true)
      expect(stored).toContain('say persist-test')
    })

    it('连续相同命令不重复写入', async () => {
      renderInput()
      const input = screen.getByLabelText('服务器命令输入')
      fireEvent.change(input, { target: { value: 'say dup' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(input).toHaveValue(''))
      fireEvent.change(input, { target: { value: 'say dup' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(input).toHaveValue(''))
      const stored = JSON.parse(localStorage.getItem(HISTORY_KEY)!) as string[]
      const dupCount = stored.filter((c) => c === 'say dup').length
      expect(dupCount).toBe(1)
    })

    it('超出 50 条上限裁剪最旧条目', async () => {
      // 预填 50 条历史
      const fifty = Array.from({ length: 50 }, (_, i) => `cmd ${i}`)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(fifty))
      renderInput()
      const input = screen.getByLabelText('服务器命令输入')
      fireEvent.change(input, { target: { value: 'cmd newest' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(input).toHaveValue(''))
      const stored = JSON.parse(localStorage.getItem(HISTORY_KEY)!) as string[]
      expect(stored.length).toBe(50)
      // 最旧的 cmd 0 被裁掉
      expect(stored).not.toContain('cmd 0')
      expect(stored).toContain('cmd newest')
    })
  })
})
