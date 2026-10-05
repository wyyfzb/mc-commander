/**
 * 实例页 ?tab=deploy 深链（URL 为单一事实源）
 * - 挂载即带参：跨路由 CTA（仪表盘等各页空态）直达部署向导
 * - 同路由再点（顶栏「暂无实例，前往部署」）：曾只认挂载时那一次 → URL 变了向导不开（点击无反应）
 * - 前进/后退：向导随 URL 开合，不再与 URL 脱钩
 * - 关闭向导：参数从 URL 移除（可再次打开同一深链）
 * MSW 拦截实例列表（结构占位虚构数据，严禁真实服务器信息）
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { InstancesPage } from '../instances-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

type Router = ReturnType<typeof createMemoryRouter>

function renderPage(initialPath = '/instances') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/instances',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <InstancesPage />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
  return router as Router
}

const deployDialog = () => screen.queryByRole('dialog', { name: '部署新实例' })

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

describe('InstancesPage ?tab=deploy 深链', () => {
  it('挂载即带参：直接打开部署向导', async () => {
    renderPage('/instances?tab=deploy')
    expect(await screen.findByRole('dialog', { name: '部署新实例' })).toBeInTheDocument()
  })

  it('同路由再点：URL 变为 ?tab=deploy → 向导打开（不再只认挂载时那一次）', async () => {
    const router = renderPage()
    expect(await screen.findByRole('button', { name: '部署新实例' })).toBeInTheDocument()
    expect(deployDialog()).not.toBeInTheDocument()

    await act(async () => {
      await router.navigate('/instances?tab=deploy')
    })
    expect(await screen.findByRole('dialog', { name: '部署新实例' })).toBeInTheDocument()
  })

  it('前进/后退：向导随 URL 开合（关掉后回退再把向导带回来）', async () => {
    const router = renderPage()
    await screen.findByRole('button', { name: '部署新实例' })

    await act(async () => {
      await router.navigate('/instances?tab=deploy')
    })
    expect(await screen.findByRole('dialog', { name: '部署新实例' })).toBeInTheDocument()

    await act(async () => {
      await router.navigate(-1)
    })
    expect(deployDialog()).not.toBeInTheDocument()

    await act(async () => {
      await router.navigate(1)
    })
    expect(await screen.findByRole('dialog', { name: '部署新实例' })).toBeInTheDocument()
  })

  it('关闭向导用 replace：参数从 URL 移除，且后退不会把已关掉的向导弹回来', async () => {
    const user = userEvent.setup()
    const router = renderPage('/instances?tab=deploy')
    expect(await screen.findByRole('dialog', { name: '部署新实例' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(deployDialog()).not.toBeInTheDocument()
    expect(router.state.location.search).toBe('')

    await act(async () => {
      await router.navigate(-1)
    })
    expect(deployDialog()).not.toBeInTheDocument()
    expect(router.state.location.search).toBe('')
  })
})
