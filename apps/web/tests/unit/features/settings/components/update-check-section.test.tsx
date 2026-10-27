/**
 * UpdateCheckSection 测试（走 MSW，四态各自可辨）：
 * - 加载中：spinner + 文案
 * - 已是最新：绿色勾 + 当前版本
 * - 有更新：黄色提示 + 版本号 + releases 外链 + 「立即更新」
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

/* 面板内自更新：更新由 root 单元在面板进程之外执行，前端只负责把 tag 交上去。
   面板此刻会被停掉，故前端不等结果——点完给「已开始」并锁住按钮即可。 */
describe('UpdateCheckSection · 立即更新', () => {
  function updateFlow({ status = 200 } = {}) {
    let payload: unknown = null
    server.use(
      http.get('*/api/v1/check-update', () =>
        ok({ current: '0.9.0', latest: '0.9.1', hasUpdate: true }),
      ),
      http.post('*/api/v1/panel/update', async ({ request }) => {
        payload = await request.json()
        if (status !== 200) {
          return HttpResponse.json(
            { status: 'error', code: 50000, message: '面板没有自更新的权限' },
            { status },
          )
        }
        return ok(null)
      }),
    )
    return () => payload
  }

  it('有更新时给出「立即更新」按钮', async () => {
    updateFlow()
    renderSection()
    expect(await screen.findByRole('button', { name: '立即更新' })).toBeInTheDocument()
  })

  it('点更新提交带 v 前缀的 tag（服务端只接受这个形态）', async () => {
    const user = userEvent.setup()
    const getPayload = updateFlow()
    renderSection()
    await user.click(await screen.findByRole('button', { name: '立即更新' }))
    await waitFor(() => expect(getPayload()).toEqual({ tag: 'v0.9.1' }))
  })

  it('提交成功后按钮锁住并说「正在更新」，避免重复触发', async () => {
    const user = userEvent.setup()
    updateFlow()
    renderSection()
    await user.click(await screen.findByRole('button', { name: '立即更新' }))
    expect(await screen.findByRole('button', { name: '正在更新…' })).toBeDisabled()
  })

  it('提交失败时按钮解锁，用户可以重试', async () => {
    const user = userEvent.setup()
    updateFlow({ status: 500 })
    renderSection()
    await user.click(await screen.findByRole('button', { name: '立即更新' }))
    // 失败不该把按钮永久锁死：权限缺失时要能补完权限再点一次
    await waitFor(() => expect(screen.getByRole('button', { name: '立即更新' })).not.toBeDisabled())
  })

  it('已是最新时不出现更新按钮', async () => {
    server.use(
      http.get('*/api/v1/check-update', () =>
        ok({ current: '0.9.1', latest: '0.9.1', hasUpdate: false }),
      ),
    )
    renderSection()
    expect(await screen.findByText('已是最新版本')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '立即更新' })).not.toBeInTheDocument()
  })
})
