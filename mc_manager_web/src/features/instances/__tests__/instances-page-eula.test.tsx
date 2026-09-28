/**
 * 实例页 EULA 首启闭环测试（issue 312）：
 * - 卡片「启动」命中 EULA 需求（403 EULA_NOT_ACCEPTED）→ 弹中文同意对话框
 * - 同意 → POST /eula 写入 + 自动续启（start 第二次调用成功）→ toast 反馈
 * - 拒绝 → 提示不启动，不写 EULA
 * MSW 拦截（instanceListMock.running=false → 卡片显示启动按钮；结构占位虚构数据）
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers, startMock, eulaMock, instanceListMock } from '@/test/mocks/handlers'
import { InstancesPage } from '../instances-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const router = createMemoryRouter(
    [
      {
        path: '/instances',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <InstancesPage />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/instances'] },
  )
  return render(<RouterProvider router={router} />)
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
  startMock.eulaRequired = false
  startMock.shouldFail = false
  startMock.calls = 0
  eulaMock.shouldFail = false
  eulaMock.calls = 0
  instanceListMock.running = true
})

describe('InstancesPage EULA 首启闭环（issue 312）', () => {
  it('启动命中 EULA → 同意弹窗 → 确认后写入 EULA 并自动续启成功', async () => {
    instanceListMock.running = false // 非运行实例 → 卡片显示「启动」按钮
    startMock.eulaRequired = true // 首启：服务端返回 EULA_NOT_ACCEPTED
    renderPage()
    const user = userEvent.setup()

    // 卡片出现后点启动
    const startBtn = await screen.findByRole('button', { name: '启动 演示实例' })
    await user.click(startBtn)

    // 命中 EULA 特例：弹中文同意对话框（而不是无关报错 toast）
    expect(await screen.findByText('Minecraft EULA 协议')).toBeInTheDocument()
    // 文案说的是**文件内容**（eula=true），不是请求体字段（agreed）——勿把两者混为一谈
    expect(
      screen.getByText(/同意后将在 eula\.txt 中写入 eula=true 并自动启动服务器/),
    ).toBeInTheDocument()
    expect(startMock.calls).toBe(1)
    expect(eulaMock.calls).toBe(0)

    // 同意 → 写入 EULA + 自动续启（第二次 start 成功）
    startMock.eulaRequired = false
    await user.click(screen.getByRole('button', { name: '同意并启动' }))

    expect(await screen.findByText('启动指令已发送')).toBeInTheDocument()
    expect(eulaMock.calls).toBe(1)
    expect(startMock.calls).toBe(2)
  })

  it('拒绝 EULA：提示不启动，不写入 EULA 不续启', async () => {
    instanceListMock.running = false
    startMock.eulaRequired = true
    renderPage()
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: '启动 演示实例' }))
    expect(await screen.findByText('Minecraft EULA 协议')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '不同意' }))

    expect(await screen.findByText('已拒绝 EULA，无法启动服务器')).toBeInTheDocument()
    expect(eulaMock.calls).toBe(0)
    expect(startMock.calls).toBe(1) // 仅首次被拦截的调用
  })
})
