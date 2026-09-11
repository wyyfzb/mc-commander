/**
 * InstanceRequiredState 测试：实例门四态各自诚实（原先把「列表没到/加载失败」谎报成零实例）
 * - 加载中：过渡占位（不出现「暂无服务器实例」）
 * - 加载失败：报错 + 重试（重试后能恢复）
 * - 确实无实例：空态 + 部署向导 CTA（深链 /instances?tab=deploy）
 * - 有实例但 app-shell 尚未选中：过渡占位（不是零实例）
 * mock 数据为虚构示例，严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { handlers } from '@/test/mocks/handlers'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { InstanceRequiredState } from '../instance-required-state'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
// 运行时 handler 会累积到后续用例：不 reset 会让前一例的响应串场（本文件首例故意挂起）
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** 统一响应信封（结构占位） */
function okEnvelope<T>(data: T) {
  return HttpResponse.json({ status: 'ok', code: 0, message: 'Success', data })
}

function ReachedInstances() {
  const location = useLocation()
  return <div>{`reached:${location.pathname}${location.search}`}</div>
}

function renderGate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/dashboard',
        element: (
          <QueryClientProvider client={qc}>
            <InstanceRequiredState />
          </QueryClientProvider>
        ),
      },
      { path: '/instances', element: <ReachedInstances /> },
    ],
    { initialEntries: ['/dashboard'] },
  )
  render(<RouterProvider router={router} />)
  // 返回 queryClient 供用例等待「列表真正落地」——只断挂载首帧的话，任何响应都能蒙对
  return { qc }
}

beforeEach(() => {
  localStorage.clear()
  // 需要实例列表请求真正发出：status=ready 才 enabled
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
})

describe('InstanceRequiredState', () => {
  it('列表加载中：过渡占位，不谎报「暂无服务器实例」', async () => {
    // 永不 resolve 的请求：钉住 pending 态
    server.use(http.get('*/api/v1/instances', () => new Promise(() => {})))
    renderGate()

    expect(await screen.findByRole('status')).toHaveTextContent('正在载入服务器实例…')
    expect(screen.queryByText('暂无服务器实例')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '部署新实例' })).not.toBeInTheDocument()
  })

  it('列表加载失败：报错可重试，重试成功后进入空态', async () => {
    let calls = 0
    server.use(
      http.get('*/api/v1/instances', () => {
        calls += 1
        return calls === 1 ? HttpResponse.json({ status: 'error', code: 50000, message: 'boom' }, { status: 500 }) : okEnvelope([])
      }),
    )
    const user = userEvent.setup()
    renderGate()

    expect(await screen.findByText('实例列表加载失败')).toBeInTheDocument()
    expect(screen.queryByText('暂无服务器实例')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('暂无服务器实例')).toBeInTheDocument()
    expect(calls).toBe(2)
  })

  it('确实无实例：空态 + CTA 深链直达部署向导', async () => {
    server.use(http.get('*/api/v1/instances', () => okEnvelope([])))
    const user = userEvent.setup()
    renderGate()

    expect(await screen.findByText('暂无服务器实例')).toBeInTheDocument()
    expect(screen.getByText('使用部署向导创建第一个实例')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '部署新实例' }))
    expect(screen.getByText('reached:/instances?tab=deploy')).toBeInTheDocument()
  })

  it('有实例但尚未选中：过渡占位（不得当成零实例把人推向部署向导）', async () => {
    // 默认 handlers 返回 1 个实例；app-shell 只在列表就绪后才自动选中，此帧 instanceId 仍为空
    const { qc } = renderGate()

    // 等列表结算落地（缓存里确有 1 个实例）再断言：只断首帧时该例区分不了空列表与非空列表
    await waitFor(() => expect(qc.getQueryData(queryKeys.instances())).toHaveLength(1))
    expect(screen.getByRole('status')).toHaveTextContent('正在载入服务器实例…')
    expect(screen.queryByText('暂无服务器实例')).not.toBeInTheDocument()
  })
})
