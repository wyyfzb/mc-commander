/**
 * 实例页部署进行中横幅测试（issue 352）：
 * - deployStore 部署中（deploying + progress）→ 横幅显示实例名 + 阶段标签（刷新后 WS 补发恢复的最小可见标识）
 * - 无进行中部署 → 横幅不渲染；部署终态 → 横幅收敛（deploying 为 false）
 * - 下载阶段带百分比；非下载阶段（forge_install/first_launch）不带误导性 0%
 * MSW 拦截实例列表（结构占位虚构数据，严禁真实服务器信息）
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { InstancesPage } from '../instances-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useDeployStore } from '@/stores/deploy'

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
  useDeployStore.setState({ progress: null, deploying: false, lastResult: null })
})

describe('InstancesPage 部署进行中横幅（issue 352）', () => {
  it('部署中：横幅显示实例名 + 阶段标签（恢复态可见标识）', () => {
    act(() => {
      useDeployStore.setState({
        deploying: true,
        progress: {
          stage: 'forge_install',
          percent: 0,
          transferred: 0,
          total: 0,
          instanceId: 'forge-abc1',
          instanceName: 'Forge 服',
        },
        lastResult: null,
      })
    })
    renderPage()

    expect(screen.getByText('有实例正在部署：「Forge 服」正在安装 Forge…')).toBeInTheDocument()
  })

  it('下载阶段：横幅带百分比后缀', () => {
    act(() => {
      useDeployStore.setState({
        deploying: true,
        progress: {
          stage: 'download',
          percent: 0.45,
          transferred: 52_428_800,
          total: 104_857_600,
          instanceId: 'paper-abc2',
          instanceName: '生存服',
        },
        lastResult: null,
      })
    })
    renderPage()

    expect(
      screen.getByText('有实例正在部署：「生存服」正在下载服务端核心…（45%）'),
    ).toBeInTheDocument()
  })

  it('无进行中部署：横幅不渲染', () => {
    renderPage()

    expect(screen.queryByText(/有实例正在部署/)).not.toBeInTheDocument()
  })

  it('部署终态收敛：deploying 为 false 时不渲染横幅', () => {
    act(() => {
      useDeployStore.setState({
        deploying: false, // applyDeployProgress 对终态不再置 deploying
        progress: { stage: 'complete', percent: 1, transferred: 0, total: 0 },
        lastResult: { ok: true, instanceId: 'vanilla-x' },
      })
    })
    renderPage()

    expect(screen.queryByText(/有实例正在部署/)).not.toBeInTheDocument()
  })
})
