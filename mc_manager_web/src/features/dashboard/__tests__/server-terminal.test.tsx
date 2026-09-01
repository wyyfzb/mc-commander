import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { ServerTerminal } from '../components/server-terminal'
import { useTerminalStore } from '@/stores/terminal'
import { useServerStore } from '@/stores/server'
import { useConnectionStore } from '@/stores/connection'

/**
 * 终端组件测试：Ctrl+L 清屏（xterm 在 jsdom 不可用，mock 掉；buffer 清空断言）
 */

// xterm 构造需要 canvas/测量，jsdom 不支持 → mock 最小面（ServerTerminal 用到的 API）
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: { theme?: unknown } = {}
    rows = 24
    buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0 } }
    loadAddon() {}
    open() {}
    write() {}
    clear() {}
    scrollToBottom() {}
    dispose() {}
    onScroll() {
      return { dispose() {} }
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
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
