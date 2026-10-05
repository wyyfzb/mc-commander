/**
 * InstancesPage · 实例隔离说明的载体
 * 该说明与单实例时的部署引导块是同一条信息，做成常驻信息条等于在首屏重复一遍、还固定占一行高度。
 * 它降级为页头描述行的信息入口（Popover），因此这里守两条：
 * - 正文不再常驻该文案（否则「降级」没发生）
 * - 点按 / 键盘打开入口仍能拿到完整信息（否则是信息丢失，不是降级）
 * MSW 拦截，结构占位虚构数据
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { InstancesPage } from '../instances-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/instances',
        element: (
          <QueryClientProvider client={qc}>
            {/* delayDuration=0：不经等待时长验证悬浮行为（时机语义另有假时钟用例覆盖） */}
            <TooltipProvider delayDuration={0}>
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
})

describe('InstancesPage · 实例隔离说明', () => {
  it('说明不常驻：正文无该文案，只在页头描述行留一个信息入口', async () => {
    renderPage()
    await screen.findByText(/已安装 1 个实例/)

    // 断言带前缀的整条文案：单实例时右栏部署引导块仍写着后半句（同一条信息），
    // 常驻条与它重复正是被撤掉的原因——故不能只匹配「独立目录 / 端口 / Java 版本」
    expect(screen.queryByText(/实例隔离：/)).not.toBeInTheDocument()
    expect(screen.getByText(/独立目录 \/ 端口 \/ Java 版本，切换实例互不影响/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '实例隔离说明' })).toBeInTheDocument()
  })

  it('信息不丢：点按入口即可读到原有全部要点（独立目录端口Java版本 / 顶栏切换 / 互不影响）', async () => {
    renderPage()
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: '实例隔离说明' })

    await user.click(trigger)

    const hint = await screen.findByRole('dialog', { name: '实例隔离说明' })
    expect(hint).toHaveTextContent('每个实例独立目录 / 端口 / Java 版本')
    expect(hint).toHaveTextContent('切换实例只需在顶栏选择')
    expect(hint).toHaveTextContent('互不影响')
  })

  it('键盘可达：焦点落到入口上按 Enter 即打开，Escape 关闭（不依赖鼠标悬停）', async () => {
    renderPage()
    const user = userEvent.setup()
    await screen.findByRole('button', { name: '实例隔离说明' })

    await user.tab()
    const trigger = screen.getByRole('button', { name: '实例隔离说明' })
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog', { name: '实例隔离说明' })).toHaveTextContent(
      '实例隔离：每个实例独立目录 / 端口 / Java 版本',
    )

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '实例隔离说明' })).not.toBeInTheDocument(),
    )
  })
})
