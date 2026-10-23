/**
 * UpdateCheckSection 测试（走 MSW，四态各自可辨）：
 * - 加载中：spinner + 文案
 * - 已是最新：绿色勾 + 当前版本
 * - 有更新：黄色提示 + 版本号 + releases 外链
 * - 检查失败：不留白，给「没查到最新版本」+ 重试（点重试会重新发请求）
 * 版本数据为虚构值，与真实发布版本无关。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { handlers } from '@tests/support/handlers'
import { UpdateCheckSection } from '@/features/settings/components/update-check-section'
import { useConnectionStore } from '@/stores/connection'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  // 查询以 status === 'ready' 为前提：不置位就永远停在未发起状态
  useConnectionStore.setState({
    baseUrl: 'https://192.168.1.100:25566',
    apiKey: 'demo-key-123',
    status: 'ready',
  })
})

function ok(data: unknown) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'ok',
    timestamp: new Date().toISOString(),
    data,
  })
}

function renderSection() {
  // 每个用例一份新 client：共享实例会把上一个用例的缓存带进来
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <UpdateCheckSection />
    </QueryClientProvider>,
  )
}

describe('UpdateCheckSection', () => {
  it('已是最新：显示当前版本，不显示「发现新版本」', async () => {
    server.use(
      http.get('*/api/v1/check-update', () =>
        ok({ current: '0.9.0', latest: '0.9.0', hasUpdate: false }),
      ),
    )
    renderSection()
    expect(await screen.findByText('已是最新版本')).toBeInTheDocument()
    expect(screen.getByText('当前 v0.9.0')).toBeInTheDocument()
    expect(screen.queryByText(/发现新版本/)).not.toBeInTheDocument()
  })

  it('有更新：给版本号与 releases 外链', async () => {
    server.use(
      http.get('*/api/v1/check-update', () =>
        ok({
          current: '0.9.0',
          latest: '0.9.1',
          hasUpdate: true,
          url: 'https://gitee.com/wyyfzb/mc-commander/releases/tag/v0.9.1',
        }),
      ),
    )
    renderSection()
    expect(await screen.findByText('发现新版本 v0.9.1')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /查看/ })
    expect(link).toHaveAttribute(
      'href',
      'https://gitee.com/wyyfzb/mc-commander/releases/tag/v0.9.1',
    )
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('检查失败：不留白，说明连不上更新源并给重试', async () => {
    server.use(http.get('*/api/v1/check-update', () => new HttpResponse(null, { status: 500 })))
    renderSection()
    expect(await screen.findByText(/没查到最新版本/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('点重试重新发请求：先失败后成功，成功态顶掉失败态', async () => {
    const user = userEvent.setup()
    let calls = 0
    server.use(
      http.get('*/api/v1/check-update', () => {
        calls += 1
        if (calls === 1) return new HttpResponse(null, { status: 500 })
        return ok({ current: '0.9.0', latest: '0.9.0', hasUpdate: false })
      }),
    )
    renderSection()
    const retry = await screen.findByRole('button', { name: '重试' })
    await user.click(retry)
    await waitFor(() => expect(screen.getByText('已是最新版本')).toBeInTheDocument())
    expect(calls).toBe(2)
  })

  it('离线：已是最新态但标注离线', async () => {
    server.use(
      http.get('*/api/v1/check-update', () =>
        ok({ current: '0.9.0', latest: null, hasUpdate: false, offline: true }),
      ),
    )
    renderSection()
    expect(await screen.findByText('已是最新版本')).toBeInTheDocument()
    expect(screen.getByText('无法连接更新服务器（离线）')).toBeInTheDocument()
  })
})
