/**
 * CommandPalette 实例操作分组测试（issue 343）：
 * - 分组渲染（带实例名）+ 三条目（重启/备份/停止）
 * - 停止/重启：关面板 → ConfirmDialog 二次确认 → 确认后发令
 * - 备份：非破坏性直接执行
 * - 实例未运行：重启/停止 disabled，备份仍可用
 * - 无实例名（status 未就绪）：分组不渲染
 * mock 数据为结构占位（演示实例），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster, toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers, mockInstanceStatus } from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useUiStore } from '@/stores/ui'
import { CommandPalette } from '../command-palette'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  toast.dismiss()
})
afterAll(() => server.close())

function renderPalette() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <CommandPalette />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
}

/** 打开面板（Cmd+K）并展开实例操作分组 */
async function openPaletteAndFindGroup() {
  const user = userEvent.setup()
  renderPalette()
  // 面板挂载时 open=false → 直接置 true 模拟 Cmd+K
  useUiStore.getState().setCommandPaletteOpen(true)
  expect(await screen.findByPlaceholderText('输入页面名称或命令…')).toBeInTheDocument()
  return user
}

describe('CommandPalette 实例操作分组', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.setState({ commandPaletteOpen: false, lastOutputInstanceId: null })
    useConnectionStore.setState({ status: 'ready', baseUrl: 'http://localhost:8080', apiKey: 'test-key' })
    useServerStore.setState({
      instanceId: 'demo',
      status: { ...mockInstanceStatus },
      socketConnected: true,
      lastStatusEvent: null,
      phase: {},
    })
  })

  it('渲染「实例操作 · 演示实例」分组：重启/备份/停止三条目带实例名', async () => {
    await openPaletteAndFindGroup()
    expect(screen.getByText('实例操作 · 演示实例')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /重启实例 · 演示实例/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /备份实例 · 演示实例/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /停止实例 · 演示实例/ })).toBeInTheDocument()
  })

  it('停止：先关面板弹二次确认，确认后发 POST stop', async () => {
    let stopCalled = false
    server.use(
      http.post('*/api/v1/instances/:id/stop', () => {
        stopCalled = true
        return HttpResponse.json({ status: 'ok', data: null })
      }),
    )
    const user = await openPaletteAndFindGroup()
    await user.click(screen.getByRole('option', { name: /停止实例/ }))

    // 面板已关，确认弹窗独立弹出
    expect(await screen.findByText('停止服务器')).toBeInTheDocument()
    expect(screen.getByText('确定要关闭服务器吗？')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '停止' }))

    await waitFor(() => expect(stopCalled).toBe(true))
    await waitFor(() =>
      expect(screen.queryByText('确定要关闭服务器吗？')).not.toBeInTheDocument(),
    )
  })

  it('重启：二次确认后发 POST restart', async () => {
    let restartCalled = false
    server.use(
      http.post('*/api/v1/instances/:id/restart', () => {
        restartCalled = true
        return HttpResponse.json({ status: 'ok', data: null })
      }),
    )
    const user = await openPaletteAndFindGroup()
    await user.click(screen.getByRole('option', { name: /重启实例/ }))
    expect(await screen.findByText('重启服务器')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重启' }))
    await waitFor(() => expect(restartCalled).toBe(true))
    await waitFor(() => expect(screen.getByText('重启指令已发送')).toBeInTheDocument())
  })

  it('备份：无确认直接执行 POST backups', async () => {
    let backupCalled = false
    server.use(
      http.post('*/api/v1/instances/:id/backups', () => {
        backupCalled = true
        return HttpResponse.json({ status: 'ok', data: { id: 'b1' } })
      }),
    )
    const user = await openPaletteAndFindGroup()
    await user.click(screen.getByRole('option', { name: /备份实例/ }))
    await waitFor(() => expect(backupCalled).toBe(true))
    await waitFor(() => expect(screen.getByText('备份任务已启动')).toBeInTheDocument())
  })

  it('实例未运行：重启/停止 disabled，备份可用', async () => {
    useServerStore.setState({
      status: { ...mockInstanceStatus, isRunning: false },
    })
    await openPaletteAndFindGroup()
    // radix CommandItem：data-disabled 恒存在，值 true/false
    expect(screen.getByRole('option', { name: /重启实例/ })).toHaveAttribute('data-disabled', 'true')
    expect(screen.getByRole('option', { name: /停止实例/ })).toHaveAttribute('data-disabled', 'true')
    expect(screen.getByRole('option', { name: /备份实例/ })).toHaveAttribute('data-disabled', 'false')
  })

  it('无实例名（status 未就绪）时分组不渲染', async () => {
    useServerStore.setState({ status: null })
    await openPaletteAndFindGroup()
    expect(screen.queryByText(/实例操作 ·/)).not.toBeInTheDocument()
  })
})

describe('CommandPalette 操作辅助', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.setState({ commandPaletteOpen: false, lastOutputInstanceId: null })
    useConnectionStore.setState({ status: 'ready', baseUrl: 'http://localhost:8080', apiKey: 'test-key' })
    useServerStore.setState({
      instanceId: 'demo',
      status: { ...mockInstanceStatus },
      socketConnected: true,
      lastStatusEvent: null,
      phase: {},
    })
  })

  it('键盘指引 footer 常驻：↑↓ 选择 / ↵ 确认 / Esc 关闭', async () => {
    await openPaletteAndFindGroup()
    expect(screen.getByText('选择')).toBeInTheDocument()
    expect(screen.getByText('确认')).toBeInTheDocument()
    expect(screen.getByText('关闭')).toBeInTheDocument()
    // 键位徽标（kbd 元素）与文字标签并存
    expect(screen.getByText('↑')).toBeInTheDocument()
    expect(screen.getByText('Esc')).toBeInTheDocument()
  })

  it('页面导航项带路径提示（落点面包屑）', async () => {
    await openPaletteAndFindGroup()
    // 可访问名随路径提示扩展（icon aria-hidden，仅文本参与命名；JSX 相邻表达式无空白分隔）
    expect(screen.getByRole('option', { name: /仪表盘\s*\/dashboard/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /设置\s*\/settings/ })).toBeInTheDocument()
  })
})
