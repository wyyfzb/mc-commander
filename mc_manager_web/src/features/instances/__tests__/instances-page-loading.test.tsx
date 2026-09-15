/**
 * InstancesPage 加载态形态：实例列表在途时用骨架基座（流光占位），不是静态灰块
 * 断言结构而非像素（jsdom 无布局引擎）：占位必须是 mcs 骨架基座（`data-slot="skeleton"`）
 * 且保持列表的 h-28 卡高。既有一处静态 `bg-mcs-bg-muted` 占位读起来像「坏了」而非「加载中」。
 * MSW 拦截：列表请求挂起（永不 resolve）以停在加载态；结构占位虚构数据
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { InstancesPage } from '../instances-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
  // 列表请求永不落定 ⇒ 页面停在加载态（其余实例查询因无实例而不启用）
  server.use(http.get('*/api/v1/instances', () => new Promise<never>(() => {})))
})

describe('InstancesPage · 加载态', () => {
  it('列表在途时渲染骨架基座占位（3 格、保持卡高），而非静态灰块', async () => {
    renderPage()

    const grid = await screen.findByLabelText('加载实例中')
    const bars = grid.querySelectorAll('[data-slot="skeleton"]')
    expect(bars).toHaveLength(3)
    for (const bar of bars) {
      expect(bar).toHaveClass('h-28')
      // 骨架基座自带流光动效；静态灰块（无动效）会被读成「坏了」而不是「加载中」
      expect(bar.className).toContain('animate-mcs-shimmer')
    }
    // 占位是装饰，不进可访问树
    for (const bar of bars) expect(bar).toHaveAttribute('aria-hidden')
  })
})
