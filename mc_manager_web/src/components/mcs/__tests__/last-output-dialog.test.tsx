/**
 * LastOutputDialog 测试（issue 343：崩溃排障深入链接）：
 * - 打开时拉取实例状态并展示 lastOutput
 * - lastOutput 为空：诚实空态
 * - 拉取失败：错误提示 + 重试
 * - 关闭（按钮/Esc）：ui store 复位
 * mock 数据为结构占位（演示实例 + 虚构日志内容），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { handlers, mockInstanceStatus } from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'
import { LastOutputDialog } from '../last-output-dialog'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <LastOutputDialog />
    </QueryClientProvider>,
  )
}

describe('LastOutputDialog', () => {
  beforeEach(() => {
    useConnectionStore.setState({
      status: 'ready',
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
    })
    useUiStore.setState({ lastOutputInstanceId: null })
  })

  it('关闭态不渲染弹窗', () => {
    renderDialog()
    expect(screen.queryByText('实例末尾日志')).not.toBeInTheDocument()
  })

  it('打开时拉取并展示 lastOutput', async () => {
    server.use(
      http.get('*/api/v1/instances/:id', () =>
        HttpResponse.json({
          status: 'ok',
          data: {
            ...mockInstanceStatus,
            lastOutput:
              '[12:00:01] [Server thread/ERROR]: Failed to start server\n[12:00:02] Done (1.2s)!',
          },
        }),
      ),
    )
    useUiStore.getState().setLastOutputInstanceId('demo')
    renderDialog()
    const content = await screen.findByTestId('last-output-content')
    await waitFor(() => expect(content.textContent).toContain('Failed to start server'))
    expect(content.textContent).toContain('Done (1.2s)!')
  })

  it('lastOutput 为空时显示诚实空态', async () => {
    useUiStore.getState().setLastOutputInstanceId('demo')
    renderDialog()
    await screen.findByText('实例末尾日志')
    await waitFor(() =>
      expect(screen.getByText('暂无日志输出（服务端未上报 lastOutput）')).toBeInTheDocument(),
    )
  })

  it('拉取失败显示错误 + 重试可恢复', async () => {
    let fail = true
    server.use(
      http.get('*/api/v1/instances/:id', () => {
        if (fail) return new HttpResponse(null, { status: 500 })
        return HttpResponse.json({
          status: 'ok',
          data: { ...mockInstanceStatus, lastOutput: 'recovered' },
        })
      }),
    )
    const user = userEvent.setup()
    useUiStore.getState().setLastOutputInstanceId('demo')
    renderDialog()
    expect(await screen.findByText(/获取失败/)).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: /重试/ }))
    await waitFor(() =>
      expect(screen.getByTestId('last-output-content').textContent).toContain('recovered'),
    )
  })

  it('点击关闭按钮复位 ui store', async () => {
    server.use(
      http.get('*/api/v1/instances/:id', () =>
        HttpResponse.json({ status: 'ok', data: { ...mockInstanceStatus, lastOutput: 'x' } }),
      ),
    )
    const user = userEvent.setup()
    useUiStore.getState().setLastOutputInstanceId('demo')
    renderDialog()
    await screen.findByTestId('last-output-content')
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(useUiStore.getState().lastOutputInstanceId).toBeNull()
    expect(screen.queryByText('实例末尾日志')).not.toBeInTheDocument()
  })

  it('长行折行显示：whitespace-pre-wrap + break-all，不横向溢出', async () => {
    server.use(
      http.get('*/api/v1/instances/:id', () =>
        HttpResponse.json({
          status: 'ok',
          // 虚构长 JSON 行（如 /give 附魔 NBT 回显）：不折行即横向滚动、行首滚出视野
          data: {
            ...mockInstanceStatus,
            lastOutput:
              '{"id":"minecraft:diamond_sword","components":{"minecraft:enchantments":{"levels":{"minecraft:sharpness":255}}}}',
          },
        }),
      ),
    )
    useUiStore.getState().setLastOutputInstanceId('demo')
    renderDialog()
    const pre = await screen.findByTestId('last-output-content')
    expect(pre).toHaveClass('whitespace-pre-wrap', 'break-all')
  })
})
