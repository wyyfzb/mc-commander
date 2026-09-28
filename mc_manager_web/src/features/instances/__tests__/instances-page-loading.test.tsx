/**
 * InstancesPage 加载态形态：实例列表在途时用骨架基座（流光占位），不是静态灰块
 * 断言结构而非像素（jsdom 无布局引擎）：占位必须是 mcs 骨架基座（`data-slot="skeleton"`）
 * 且保持列表的 h-28 卡高。既有一处静态 `bg-mcs-bg-muted` 占位读起来像「坏了」而非「加载中」。
 * 列数恒定（`INSTANCE_GRID_CLASS`）：真实网格与骨架共用同一条声明，装几个实例都不跳变；
 * 两格＝一张实例卡 + 单实例形态下的部署引导块（三列档跨两列，骨架同样跨列，几何逐格对齐）。
 * 骨架容器是 `role="status"`（读屏能进可访问树并播报「加载实例中」），格本身 aria-hidden
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
import { INSTANCE_GRID_CLASS } from '../components/instance-cards'
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
  it('列表在途时渲染骨架基座占位（两格、保持卡高），而非静态灰块', async () => {
    renderPage()

    const grid = await screen.findByRole('status', { name: '加载实例中' })
    const bars = grid.querySelectorAll('[data-slot="skeleton"]')
    // 两格：第一格＝实例卡，第二格＝单实例形态的部署引导块（三列档跨两列）
    expect(bars).toHaveLength(2)
    // 列数规则与真实网格同源（改真实网格这里同步变，不再有「按实例数分叉」的可能）
    expect(grid.className).toBe(INSTANCE_GRID_CLASS)
    // 容器档而非视口档：侧栏折叠会使同视口下内容宽差 152px，视口断点判不准列数。
    // 用词边界判定「前面没有 @」才算视口档（@5xl 里也含 xl 子串）
    const viewportTier = (tier: string) => new RegExp(`(?:^|\\s)${tier}:`).test(INSTANCE_GRID_CLASS)
    expect(INSTANCE_GRID_CLASS).toContain('@2xl:grid-cols-2')
    expect(INSTANCE_GRID_CLASS).toContain('@5xl:grid-cols-3')
    expect(viewportTier('sm')).toBe(false)
    expect(viewportTier('xl')).toBe(false)
    expect(bars[0]?.className).not.toContain('@5xl:col-span-2')
    // 第二格跨两列：与真实引导块同几何，三列档冷加载不再 2→3 列跳变
    expect(bars[1]?.className).toContain('@5xl:col-span-2')
    for (const bar of bars) {
      expect(bar).toHaveClass('h-28')
      // 骨架基座自带流光动效；静态灰块（无动效）会被读成「坏了」而不是「加载中」
      expect(bar.className).toContain('animate-mcs-shimmer')
    }
    // 占位是装饰，不进可访问树
    for (const bar of bars) expect(bar).toHaveAttribute('aria-hidden')
  })
})
