/**
 * RecentBackupsCard 测试：
 * - 骨架加载态 / 空态引导 / 失败态重试 / 正常渲染（名称 + 时间·大小 + 状态徽章 + 旧格式徽章）
 * - 立即备份按钮（成功 toast / 有在途备份时禁用）
 * - 「全部」与空态入口**真实跳转**到设置页备份子路由（/settings/backup）——防入口路由漂移回归
 * mock 数据为虚构内容（mockBackups），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
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
afterAll(() => server.close())

/** 备份列表端点（覆盖用例用；默认走 handlers 的 mockBackups） */
const BACKUPS_URL = '*/api/v1/instances/:id/backups'

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
      { path: '/settings/backup', element: <div>备份管理页</div> },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
}

/** 渲染卡片并等待列表就绪 */
async function renderReady() {
  renderCard()
  await waitFor(() => expect(screen.getByText('手动备份 2026-08-14')).toBeInTheDocument())
}

beforeEach(() => {
  server.resetHandlers()
  useConnectionStore.setState({ status: 'ready', baseUrl: 'http://localhost:8080', apiKey: 'test-key' })
  useServerStore.setState({
    instanceId: 'demo',
    status: null,
    socketConnected: true,
    lastStatusEvent: null,
  })
})

describe('RecentBackupsCard', () => {
  it('加载中显示骨架（role=status）', () => {
    server.use(
      http.get(BACKUPS_URL, async () => {
        await new Promise((r) => setTimeout(r, 10_000))
        return HttpResponse.json({ status: 'ok', data: [] })
      }),
    )
    renderCard()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('空态：显示引导文案，入口跳转备份管理页', async () => {
    const user = userEvent.setup()
    server.use(http.get(BACKUPS_URL, () => HttpResponse.json({ status: 'ok', data: [] })))
    renderCard()
    await waitFor(() => expect(screen.getByText('暂无备份记录')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '前往备份管理' }))
    expect(await screen.findByText('备份管理页')).toBeInTheDocument()
  })

  it('失败态：展示原因并可重试（重试成功后渲染列表）', async () => {
    const user = userEvent.setup()
    let calls = 0
    server.use(
      http.get(BACKUPS_URL, () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json(
            {
              status: 'error',
              code: 50000,
              message: '内部错误',
              details: null,
              timestamp: '2026-08-15T00:00:00.000Z',
            },
            { status: 500 },
          )
        }
        return HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: [],
          timestamp: '2026-08-15T00:00:00.000Z',
        })
      }),
    )
    renderCard()
    await waitFor(() => expect(screen.getByText(/备份记录加载失败/)).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByText('暂无备份记录')).toBeInTheDocument())
  })

  it('渲染备份行：名称 + 时间·大小 + 状态徽章 + 旧格式徽章', async () => {
    await renderReady()

    // mockBackups 三条：已完成快照 / 已完成 zip / 失败
    expect(screen.getByText('旧格式压缩包')).toBeInTheDocument()
    expect(screen.getByText('失败的备份')).toBeInTheDocument()
    expect(screen.getByText('旧格式')).toBeInTheDocument()
    expect(screen.getByText('失败')).toBeInTheDocument()
    // 两条 completed → 「已就绪」
    expect(screen.getAllByText('已就绪')).toHaveLength(2)
    // 大小格式化（524288000 → 500.0 MB）
    expect(screen.getByText(/500\.0 MB/)).toBeInTheDocument()
  })

  it('立即备份：点击后调用创建接口并提示已启动', async () => {
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: /立即备份/ }))
    await waitFor(() => expect(screen.getByText('备份任务已启动')).toBeInTheDocument())
  })

  it('有在途备份时「立即备份」禁用（服务端互斥状态机同口径）', async () => {
    server.use(
      http.get(BACKUPS_URL, () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: [
            {
              id: 1,
              instanceId: 'demo',
              name: '进行中的备份',
              description: null,
              type: 'manual',
              size: 0,
              status: 'creating',
              worldName: 'world',
              format: 'snapshot',
              createdAt: '2026-08-15T00:00:00.000Z',
              updatedAt: '2026-08-15T00:00:00.000Z',
            },
          ],
          timestamp: '2026-08-15T00:00:00.000Z',
        }),
      ),
    )
    renderCard()
    await waitFor(() => expect(screen.getByText('进行中的备份')).toBeInTheDocument())

    const btn = screen.getByRole('button', { name: /立即备份/ })
    expect(btn).toBeDisabled()
    // 禁用原因外显（无提示会被读作「按钮坏了」）
    expect(btn).toHaveAttribute('title', '已有备份或恢复在进行中，请稍候')
    expect(screen.getByText('备份中')).toBeInTheDocument()
  })

  it('立即备份失败：toast 给出失败原因，不静默', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(BACKUPS_URL, () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 50001,
            message: '备份任务创建失败',
            details: null,
            timestamp: '2026-08-15T00:00:00.000Z',
          },
          { status: 500 },
        ),
      ),
    )
    await renderReady()

    await user.click(screen.getByRole('button', { name: /立即备份/ }))
    await waitFor(() => expect(screen.getByText(/操作失败/)).toBeInTheDocument())
  })

  it('「全部」跳转到设置页备份子路由（/settings/backup）', async () => {
    const user = userEvent.setup()
    await renderReady()

    await user.click(screen.getByRole('button', { name: '查看全部备份' }))
    expect(await screen.findByText('备份管理页')).toBeInTheDocument()
  })
})
