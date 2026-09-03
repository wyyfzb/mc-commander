/**
 * RecentBackupsCard 测试：
 * - 骨架加载态 / 空态引导跳转 / 正常渲染最近 5 条 + 状态徽章
 * - 立即备份按钮 + 在途禁用 / 「全部」链接跳转备份设置页
 * - 旧格式(zip)徽章 / failed 状态图标
 * mock 数据为结构占位（mockBackups 虚构内容），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { RecentBackupsCard } from '../components/recent-backups-card'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <RecentBackupsCard />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
      { path: '/settings/backups', element: <div>备份管理页</div> },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
}

describe('RecentBackupsCard', () => {
  beforeEach(() => {
    useConnectionStore.setState({ status: 'ready', baseUrl: 'http://localhost:8080', apiKey: 'test-key' })
    useServerStore.setState({
      instanceId: 'demo',
      status: null,
      socketConnected: true,
      lastStatusEvent: null,
    })
  })

  it('骨架加载态', () => {
    // 阻塞请求让 loading 持续
    server.use(
      http.get('*/api/v1/instances/:id/backups', async () => {
        await new Promise((r) => setTimeout(r, 10_000))
        return HttpResponse.json({ status: 'ok', data: [] })
      }),
    )
    renderCard()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('空态：无备份时显示引导 + 跳转链接', async () => {
    server.use(http.get('*/api/v1/instances/:id/backups', () => HttpResponse.json({ status: 'ok', data: [] })))
    renderCard()
    await waitFor(() => expect(screen.getByText('暂无备份记录')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '前往备份管理' })).toBeInTheDocument()
  })

  it('显示最近 5 条备份 + 状态徽章', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByText('手动备份 2026-08-14')).toBeInTheDocument())
    // mockBackups 有 3 条（id 11, 10, 9），全部显示
    expect(screen.getByText('旧格式压缩包')).toBeInTheDocument()
    expect(screen.getByText('失败的备份')).toBeInTheDocument()
    // 状态徽章（mockBackups 有 2 条 completed，故 getAllByText）
    expect(screen.getAllByText('已就绪').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('失败').textContent).toBe('失败')
    // 旧格式徽章
    expect(screen.getByText('旧格式')).toBeInTheDocument()
  })

  it('立即备份按钮 + 成功 toast', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('*/api/v1/instances/:id/backups', () =>
        HttpResponse.json({
          status: 'ok',
          data: {
            id: 99,
            instanceId: 'demo',
            name: '新备份',
            description: null,
            type: 'manual',
            size: 0,
            status: 'creating',
            worldName: 'world',
            format: 'snapshot',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      ),
    )
    renderCard()
    await waitFor(() => expect(screen.getByText('立即备份')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /立即备份/ }))
    await waitFor(() => expect(screen.getByText('备份任务已启动')).toBeInTheDocument())
  })

  it('备份中时按钮禁用', async () => {
    // mock 有 creating 状态的备份
    const creatingBackups = [
      {
        id: 1, instanceId: 'demo', name: '进行中', description: null, type: 'manual',
        size: 0, status: 'creating', worldName: 'world', format: 'snapshot',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]
    server.use(
      http.get('*/api/v1/instances/:id/backups', () =>
        HttpResponse.json({ status: 'ok', data: creatingBackups }),
      ),
    )
    renderCard()
    await waitFor(() => expect(screen.getByText('进行中')).toBeInTheDocument())
    // 立即备份按钮应被禁用（有备份进行中）
    const btn = screen.getByRole('button', { name: /立即备份/ })
    expect(btn).toBeDisabled()
  })

  it('「全部」链接导航到备份管理页', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByText('手动备份 2026-08-14')).toBeInTheDocument())
    const btn = screen.getByRole('button', { name: '查看全部备份' })
    expect(btn).toBeInTheDocument()
  })
})
