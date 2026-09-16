/**
 * InstancesPage 加载态形态：实例列表在途时用骨架基座（流光占位），不是静态灰块
 * 断言结构而非像素（jsdom 无布局引擎）：占位必须是 mcs 骨架基座（`data-slot="skeleton"`）
 * 且保持列表的 h-28 卡高。既有一处静态 `bg-mcs-bg-muted` 占位读起来像「坏了」而非「加载中」。
 * 列数与格数按**单实例形态**：实例数在数据到达前不可知，而 xl 三列只对多实例成立——
 * 骨架假称三列会在单实例冷加载后跳变成两栏。故断言骨架网格类名与
 * `instanceGridClass(1)` 逐字相同（与真实网格同一条规则），而不只是「有两格」。
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
import { instanceGridClass } from '../components/instance-cards'
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
  it('列表在途时渲染骨架基座占位（单实例形态两格、保持卡高），而非静态灰块', async () => {
    renderPage()

    const grid = await screen.findByLabelText('加载实例中')
    const bars = grid.querySelectorAll('[data-slot="skeleton"]')
    // 两格：填满单实例形态那一行（一卡 + 部署引导块）
    expect(bars).toHaveLength(2)
    // 列数规则与真实网格同源：改真实网格时这里会同步变，硬编码回三列则立刻报错
    expect(grid.className).toBe(instanceGridClass(1))
    expect(grid.className).not.toContain('xl:grid-cols-3')
    // 规则本体逐分支直测：上面两条是同源比较，抓不住「规则本身被改坏」，且有牙的只有
    // 那条否定断言——多实例分支此前全仓零覆盖（grep xl:grid-cols-3 仅命中它）
    expect(instanceGridClass(0)).not.toContain('xl:grid-cols-3')
    expect(instanceGridClass(1)).not.toContain('xl:grid-cols-3')
    expect(instanceGridClass(2)).toContain('xl:grid-cols-3')
    for (const bar of bars) {
      expect(bar).toHaveClass('h-28')
      // 骨架基座自带流光动效；静态灰块（无动效）会被读成「坏了」而不是「加载中」
      expect(bar.className).toContain('animate-mcs-shimmer')
    }
    // 占位是装饰，不进可访问树
    for (const bar of bars) expect(bar).toHaveAttribute('aria-hidden')
  })
})
