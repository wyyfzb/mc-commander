/**
 * 插件更新检测前端测试（feat-8 延伸）
 * - apiCheckPluginUpdates：MSW 拦截 POST check-updates（信封解包 + 超时参数）
 * - MarketSheet initialQuery：打开时预填搜索词（更新徽章 → 市场直达），关闭后清预填
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { MarketSheet } from '../market-sheet'
import { apiCheckPluginUpdates } from '@/api/plugins'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const UPDATE_FIXTURE = {
  checkedAt: '2026-08-29T12:00:00Z',
  results: [
    {
      file: 'EssentialsX-2.20.0.jar',
      name: 'EssentialsX',
      installedVersion: '2.20.0',
      enabled: true,
      matched: true,
      slug: 'essentialsx',
      title: 'EssentialsX',
      iconUrl: null,
      latestVersion: '2.21.0',
      updateAvailable: true,
      hasNewer: true,
    },
    {
      file: 'Obscure-1.0.0.jar',
      name: 'Obscure',
      installedVersion: '1.0.0',
      enabled: true,
      matched: false,
      slug: null,
      title: null,
      iconUrl: null,
      latestVersion: null,
      updateAvailable: false,
      hasNewer: false,
    },
  ],
}

let updateStatus = 200
const server = setupServer(
  http.post('/api/v1/instances/demo/plugins/check-updates', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: UPDATE_FIXTURE }, { status: updateStatus }),
  ),
  http.get('/api/v1/instances/demo/plugins', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: { plugins: [] } }),
  ),
)

const SEARCH_FIXTURE = {
  totalHits: 1,
  hits: [
    {
      projectId: 'hXiIvTyT',
      slug: 'essentialsx',
      title: 'EssentialsX',
      description: 'The essential plugin suite',
      author: 'EssentialsX Team',
      downloads: 757014,
      follows: 10,
      iconUrl: null,
      dateModified: '2026-01-01T00:00:00Z',
      categories: ['paper'],
      serverSide: 'required',
      clientSide: 'unsupported',
    },
  ],
  cached: false,
}

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  updateStatus = 200
})
afterAll(() => server.close())

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ status: { mcVersion: '1.21.4' } as never })
})

describe('apiCheckPluginUpdates', () => {
  it('POST check-updates：信封解包返回 results', async () => {
    const result = await apiCheckPluginUpdates(useConnectionStore.getState(), 'demo')
    expect(result.checkedAt).toBe('2026-08-29T12:00:00Z')
    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toMatchObject({
      file: 'EssentialsX-2.20.0.jar',
      matched: true,
      hasNewer: true,
    })
    expect(result.results[1]).toMatchObject({ matched: false })
  })

  it('服务端 500 → 抛 ApiError（含错误码）', async () => {
    server.use(
      http.post('/api/v1/instances/demo/plugins/check-updates', () =>
        HttpResponse.json(
          { status: 'error', code: 50301, message: 'Modrinth upstream error' },
          { status: 502 },
        ),
      ),
    )
    await expect(apiCheckPluginUpdates(useConnectionStore.getState(), 'demo')).rejects.toMatchObject({
      code: 50301,
    })
  })
})

describe('MarketSheet initialQuery（更新徽章直达搜索）', () => {
  function renderSheet(overrides: { initialQuery?: string | null } = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const utils = render(
      <QueryClientProvider client={qc}>
        <MarketSheet open onOpenChange={() => {}} instanceId="demo" {...overrides} />
      </QueryClientProvider>,
    )
    return utils
  }

  it('打开时带 initialQuery → 搜索框预填并按该词搜索', async () => {
    let requestedQ: string | null = ''
    server.use(
      http.get('/api/v1/instances/demo/plugins/market/search', ({ request }) => {
        requestedQ = new URL(request.url).searchParams.get('q')
        return HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: SEARCH_FIXTURE })
      }),
    )
    renderSheet({ initialQuery: 'EssentialsX' })
    const input = await screen.findByPlaceholderText(/搜索/i)
    expect(input).toHaveValue('EssentialsX')
    await waitFor(() => expect(requestedQ).toBe('EssentialsX'))
    expect(await screen.findByText('EssentialsX')).toBeInTheDocument()
  })

  it('未带 initialQuery（手动打开）→ 空关键词浏览模式', async () => {
    let requestedQ: string | null = null
    server.use(
      http.get('/api/v1/instances/demo/plugins/market/search', ({ request }) => {
        requestedQ = new URL(request.url).searchParams.get('q')
        return HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: SEARCH_FIXTURE })
      }),
    )
    renderSheet()
    await screen.findByPlaceholderText(/搜索/i)
    await waitFor(() => expect(requestedQ).toBe(''))
  })

  it('initialQuery 变化（先 null 后有值）→ 重新预填并触发搜索', async () => {
    let requestedQ: string | null = null
    server.use(
      http.get('/api/v1/instances/demo/plugins/market/search', ({ request }) => {
        requestedQ = new URL(request.url).searchParams.get('q')
        return HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: SEARCH_FIXTURE })
      }),
    )
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={qc}>
        <MarketSheet open onOpenChange={() => {}} instanceId="demo" initialQuery={null} />
      </QueryClientProvider>,
    )
    await screen.findByPlaceholderText(/搜索/i)
    await waitFor(() => expect(requestedQ).toBe(''))

    view.rerender(
      <QueryClientProvider client={qc}>
        <MarketSheet open onOpenChange={() => {}} instanceId="demo" initialQuery="Vault" />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(requestedQ).toBe('Vault'))
  })
})
