import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { render, fireEvent, waitFor, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { ServerTerminal } from '../components/server-terminal'
import { useTerminalStore } from '@/stores/terminal'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'

/**
 * 终端组件测试：Ctrl+L 清屏（xterm 在 jsdom 不可用，mock 掉；buffer 清空断言）/
 * 终端内搜索：搜索条开闭、Ctrl+F 拦截、Enter/上/下查找接线、n/m 计数、Esc 清理 /
 * JVM 眼睛切换：清屏全量重写（P2-27 复现修复）
 */

/** 捕获 SearchAddon 与 xterm 内部注册物，供搜索/渲染交互断言（vi.hoisted 提升到 mock 工厂之前） */
const xtermStub = vi.hoisted(() => {
  type ResultCb = (r: { resultIndex: number; resultCount: number }) => void
  type TermEvent = { op: 'write'; text: string } | { op: 'clear' }
  return {
    customKeyHandlers: [] as ((e: { key: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void }) => boolean)[],
    searchAddonInstances: [] as {
      findNext: ReturnType<typeof vi.fn>
      findPrevious: ReturnType<typeof vi.fn>
      clearDecorations: ReturnType<typeof vi.fn>
      fireResults: (r: { resultIndex: number; resultCount: number }) => void
    }[],
    resultCb: null as ResultCb | null,
    /** Terminal 实例（单渲染一个） */
    terminals: [] as unknown[],
    /** 渲染事件序列：write/clear 依序记录（JVM 切换全量重写断言用） */
    events: [] as TermEvent[],
  }
})

// xterm 构造需要 canvas/测量，jsdom 不支持 → mock 最小面（ServerTerminal 用到的 API）
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: { theme?: unknown } = {}
    rows = 24
    buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0 } }
    loadAddon() {}
    open() {}
    write(t: string) {
      xtermStub.events.push({ op: 'write', text: t })
    }
    clear() {
      xtermStub.events.push({ op: 'clear' })
    }
    scrollToBottom() {}
    dispose() {}
    focus() {}
    onScroll() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler(h: (e: { key: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void }) => boolean) {
      xtermStub.customKeyHandlers.push(h)
    }
    constructor() {
      xtermStub.terminals.push(this)
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext = vi.fn(() => true)
    findPrevious = vi.fn(() => true)
    clearDecorations = vi.fn()
    constructor() {
      xtermStub.searchAddonInstances.push(this)
    }
    // IEvent 形态：(cb) => IDisposable；捕获回调供测试手动驱动计数
    onDidChangeResults = (cb: (r: { resultIndex: number; resultCount: number }) => void) => {
      xtermStub.resultCb = cb
      return { dispose() {} }
    }
    fireResults(r: { resultIndex: number; resultCount: number }) {
      xtermStub.resultCb?.(r)
    }
  },
}))

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  xtermStub.customKeyHandlers.length = 0
  xtermStub.searchAddonInstances.length = 0
  xtermStub.resultCb = null
  xtermStub.terminals.length = 0
  xtermStub.events.length = 0
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({
    status: { isRunning: true } as never,
    systemStats: null,
    instanceId: 'demo',
    socketConnected: true,
    lastStatusEvent: null,
  })
  useTerminalStore.setState({ buffer: [], instanceId: 'demo', suppressBackfill: false })
})

function renderTerminal() {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ServerTerminal />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('ServerTerminal', () => {
  it('Ctrl+L 清空终端缓冲（window 捕获，P0 快捷键）', async () => {
    renderTerminal()
    // 等历史日志回填（MSW logs 端点）后塞入缓冲，再验证清屏
    await waitFor(() => expect(useTerminalStore.getState().buffer.length).toBeGreaterThan(0))
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(useTerminalStore.getState().buffer).toHaveLength(0)
  })

  it('Cmd+L 同样清屏（macOS 习惯）', async () => {
    renderTerminal()
    await waitFor(() => expect(useTerminalStore.getState().buffer.length).toBeGreaterThan(0))
    fireEvent.keyDown(window, { key: 'L', metaKey: true })
    expect(useTerminalStore.getState().buffer).toHaveLength(0)
  })

  it('实例切换同步清空 xterm——占位不再浮在旧实例日志上（重叠回归）', async () => {
    renderTerminal()
    await waitFor(() => expect(useTerminalStore.getState().buffer.length).toBeGreaterThan(0))
    const clearCountBefore = xtermStub.events.filter((e) => e.op === 'clear').length
    act(() => {
      useServerStore.setState({ instanceId: 'other' })
    })
    // store 缓冲随 setInstance 归零，xterm 必须出现新的 clear 事件（旧日志不得残留）
    await waitFor(() => expect(useTerminalStore.getState().instanceId).toBe('other'))
    expect(xtermStub.events.filter((e) => e.op === 'clear').length).toBeGreaterThan(clearCountBefore)
  })

  it('不带修饰键的 L 不清屏', async () => {
    renderTerminal()
    await waitFor(() => expect(useTerminalStore.getState().buffer.length).toBeGreaterThan(0))
    fireEvent.keyDown(window, { key: 'l' })
    expect(useTerminalStore.getState().buffer.length).toBeGreaterThan(0)
  })

  it('aria-live 屏读镜像区域存在且含终端文本', async () => {
    renderTerminal()
    const srMirror = await waitFor(() =>
      document.querySelector('[data-testid="sr-live-mirror"]'),
    )
    expect(srMirror).toBeTruthy()
    expect(srMirror?.getAttribute('aria-live')).toBe('polite')
    expect(srMirror?.getAttribute('aria-label')).toBe('终端输出')
    // 等日志回填后，屏读镜像应包含文本
    await waitFor(() => {
      expect(srMirror?.textContent).toBeTruthy()
    })
  })
})

describe('ServerTerminal 终端内搜索', () => {
  function lastAddon() {
    return xtermStub.searchAddonInstances.at(-1)
  }

  it('搜索按钮打开搜索条（role=search + input 可聚焦）→ 关闭按钮收起', async () => {
    const user = userEvent.setup()
    renderTerminal()
    await user.click(screen.getByRole('button', { name: '搜索终端内容' }))
    expect(screen.getByRole('search', { name: '终端内容搜索' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '搜索终端内容' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '关闭搜索' }))
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
  })

  it('Ctrl+F 经 attachCustomKeyEventHandler 拦截：preventDefault + 打开搜索条（返回 false 阻断 xterm 处理）', () => {
    renderTerminal()
    expect(xtermStub.customKeyHandlers).toHaveLength(1)
    const pd = vi.fn()
    let handled: boolean | undefined
    act(() => {
      handled = xtermStub.customKeyHandlers[0]!({ key: 'f', ctrlKey: true, preventDefault: pd })
    })
    expect(pd).toHaveBeenCalledTimes(1)
    expect(handled).toBe(false)
    expect(screen.getByRole('search', { name: '终端内容搜索' })).toBeInTheDocument()
    // 非 Ctrl+F 按键放行
    expect(xtermStub.customKeyHandlers[0]!({ key: 'a', preventDefault: vi.fn() })).toBe(true)
  })

  it('输入 + Enter → findNext 接线（含装饰配置）；计数区域渲染 n/m', async () => {
    const user = userEvent.setup()
    renderTerminal()
    await user.click(screen.getByRole('button', { name: '搜索终端内容' }))
    const input = screen.getByRole('textbox', { name: '搜索终端内容' })
    await user.type(input, 'ERROR')
    await user.keyboard('{Enter}')
    const addon = lastAddon()!
    expect(addon.findNext).toHaveBeenCalledWith('ERROR', expect.objectContaining({ decorations: expect.any(Object) }))
    // addon 上报结果 → n/m 计数（resultIndex 0 起 → 显示 3/17）
    addon.fireResults({ resultIndex: 2, resultCount: 17 })
    expect(await screen.findByText('3/17')).toBeInTheDocument()
    // 再次 Enter：继续向后
    await user.keyboard('{Enter}')
    expect(addon.findNext).toHaveBeenCalledTimes(2)
  })

  it('上/下按钮 → findPrevious/findNext；Shift+Enter 向前；无结果时显示「无结果」', async () => {
    const user = userEvent.setup()
    renderTerminal()
    await user.click(screen.getByRole('button', { name: '搜索终端内容' }))
    const input = screen.getByRole('textbox', { name: '搜索终端内容' })
    await user.type(input, 'Exception')
    const addon = lastAddon()!
    await user.click(screen.getByRole('button', { name: '上一个结果' }))
    expect(addon.findPrevious).toHaveBeenCalledWith('Exception', expect.anything())
    await user.click(screen.getByRole('button', { name: '下一个结果' }))
    expect(addon.findNext).toHaveBeenCalledWith('Exception', expect.anything())
    await user.type(input, '{Shift>}{Enter}{/Shift}')
    expect(addon.findPrevious).toHaveBeenCalledTimes(2)
    // 无结果文案
    addon.fireResults({ resultIndex: 0, resultCount: 0 })
    expect(await screen.findByText('无结果')).toBeInTheDocument()
  })

  it('Esc 关闭搜索条：clearDecorations 清除高亮 + 计数清零', async () => {
    const user = userEvent.setup()
    renderTerminal()
    await user.click(screen.getByRole('button', { name: '搜索终端内容' }))
    const addon = lastAddon()!
    const input = screen.getByRole('textbox', { name: '搜索终端内容' })
    await user.type(input, 'ERROR')
    addon.fireResults({ resultIndex: 1, resultCount: 5 })
    expect(await screen.findByText('2/5')).toBeInTheDocument()
    await user.type(input, '{Escape}')
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(addon.clearDecorations).toHaveBeenCalled()
    // 重开后旧计数不残留
    await user.click(screen.getByRole('button', { name: '搜索终端内容' }))
    expect(screen.queryByText('2/5')).not.toBeInTheDocument()
  })

  it('关闭按钮与 Esc 同效：清除高亮；输入变化清计数等待下次查找', async () => {
    const user = userEvent.setup()
    renderTerminal()
    await user.click(screen.getByRole('button', { name: '搜索终端内容' }))
    const addon = lastAddon()!
    const input = screen.getByRole('textbox', { name: '搜索终端内容' })
    await user.type(input, 'WARN')
    addon.fireResults({ resultIndex: 0, resultCount: 3 })
    expect(await screen.findByText('1/3')).toBeInTheDocument()
    // 输入变化 → 旧计数失真清零
    await user.type(input, '2')
    expect(screen.queryByText('1/3')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭搜索' }))
    expect(addon.clearDecorations).toHaveBeenCalled()
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
  })
})

describe('ServerTerminal JVM 眼睛切换（P2-27 复现修复）', () => {
  const JVM_LINE = 'WARNING: A restricted method in java.lang.System.invoke has been called'

  /** 最近一次 clear 之后写入的行（全量重写断言窗口） */
  function writesAfterLastClear(): string[] {
    const ops = xtermStub.events
    const lastClear = ops.map((e) => e.op).lastIndexOf('clear')
    return ops
      .slice(lastClear + 1)
      .filter((e) => e.op === 'write')
      .map((e) => (e as { op: 'write'; text: string }).text)
  }

  it('切换「显示 JVM 警告」→ 清屏 + 历史行含 JVM 警告全量重写（修复前：只 clear 不重写，终端空白）', async () => {
    const user = userEvent.setup()
    // 覆盖 logs 端点：INFO + JVM 警告（stderr）+ INFO（envelope 结构与 apiGet 解包一致）
    server.use(
      http.get('*/api/v1/instances/:id/logs', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: [
            { text: '[00:00:01] [Server thread/INFO]: Starting minecraft server', type: 'stdout' },
            { text: JVM_LINE, type: 'stderr' },
            { text: '[00:00:05] [Server thread/INFO]: Done (1.2s)!', type: 'stdout' },
          ],
          timestamp: new Date().toISOString(),
        }),
      ),
    )
    renderTerminal()
    await waitFor(() => expect(useTerminalStore.getState().buffer).toHaveLength(3))

    // 初始态（默认隐藏 JVM 警告）：2 行可见，无 clear，不含 JVM 行
    expect(xtermStub.events.filter((e) => e.op === 'write')).toHaveLength(2)
    expect(xtermStub.events.some((e) => e.op === 'clear')).toBe(false)
    expect(xtermStub.events.some((e) => e.op === 'write' && e.text.includes('restricted method'))).toBe(false)

    // 切换显示：clear + 3 行全量重写（含 JVM 警告行）→ 历史行回填
    await user.click(screen.getByRole('button', { name: '显示 JVM 警告' }))
    await waitFor(() => expect(xtermStub.events.some((e) => e.op === 'clear')).toBe(true))
    await waitFor(() => expect(writesAfterLastClear()).toHaveLength(3))
    const rewritten = writesAfterLastClear()
    expect(rewritten.some((t) => t.includes('restricted method'))).toBe(true)

    // 切回隐藏：再次 clear + 2 行重写（JVM 行被过滤）
    await user.click(screen.getByRole('button', { name: '隐藏 JVM 警告' }))
    await waitFor(() => expect(writesAfterLastClear()).toHaveLength(2))
    const rewrittenBack = writesAfterLastClear()
    expect(rewrittenBack.some((t) => t.includes('restricted method'))).toBe(false)
  })
})
