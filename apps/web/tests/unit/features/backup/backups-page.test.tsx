/**
 * BackupsPage 页级归属：无实例时的门归页面，不归面板。
 *
 * 两道判据：
 * - 无实例 ⇒ 出统一空态（InstanceRequiredState，四态各自诚实），不出备份列表
 * - 无实例 ⇒ 归档快照仍在（面板级资产，不跟实例空态一起消失）
 * 面板内那道门已删（ps：面板的 instanceId 已收紧为非空类型），故本组是它的替代守卫。
 * MSW 数据为结构占位虚构内容，严禁真实服务器信息。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@tests/support/handlers'
import { BackupsPage } from '@/features/backup/backups-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())
afterEach(() => server.resetHandlers())

function ok(data: unknown) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function renderPage(instanceId: string | null = 'demo') {
  useServerStore.setState({ instanceId })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/backups',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <BackupsPage />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/backups'] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
})

describe('BackupsPage 无实例', () => {
  it('零实例：出统一空态，不渲染备份列表与自动备份摘要', async () => {
    server.use(http.get('*/api/v1/instances', () => ok([])))
    renderPage(null)

    expect(await screen.findByText('暂无服务器实例')).toBeInTheDocument()
    expect(screen.queryByText('备份列表')).not.toBeInTheDocument()
    expect(screen.queryByText(/自动备份/)).not.toBeInTheDocument()
  })

  /* 归档快照是面板级资产：卸载最后一台时确认框刚说过「已保留 N 份备份」，
     这一页若跟着实例空态一起消失，用户就再也找不到它们 */
  it('零实例：归档快照仍可见，且不给挂载按钮（没有可登记的目标实例）', async () => {
    server.use(
      http.get('*/api/v1/instances', () => ok([])),
      http.get('*/api/v1/backups/archived', () =>
        ok([
          {
            archiveId: 'paper-1a2b3c4d',
            instanceExists: false,
            snapshotCount: 3,
            usableCount: 2,
            latestMtime: '2026-09-01T00:00:00.000Z',
          },
        ]),
      ),
    )
    renderPage(null)

    expect(await screen.findByText('归档快照（未建立索引）')).toBeInTheDocument()
    expect(screen.getByText('paper-1a2b3c4d')).toBeInTheDocument()
    expect(screen.getByText(/挂载需要先有一台实例/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /挂载到本实例/ })).not.toBeInTheDocument()
  })

  it('有实例：渲染自动备份摘要与备份列表（空态不误报「没有实例」）', async () => {
    // 摘要条读任务列表：共享 handlers 里没有该端点，此处补一条空的（未配置自动备份态）
    server.use(http.get('*/api/v1/instances/:id/tasks', () => ok([])))
    renderPage('demo')

    expect(await screen.findByText('备份列表')).toBeInTheDocument()
    expect(await screen.findByText(/自动备份/)).toBeInTheDocument()
    expect(screen.queryByText('暂无服务器实例')).not.toBeInTheDocument()
  })

  it('实例列表未回（首帧）：给过渡占位，不谎报零实例', async () => {
    renderPage(null)
    await waitFor(() => expect(screen.getByText('正在载入服务器实例…')).toBeInTheDocument())
    expect(screen.queryByText('暂无服务器实例')).not.toBeInTheDocument()
    expect(screen.queryByText('备份列表')).not.toBeInTheDocument()
  })
})
