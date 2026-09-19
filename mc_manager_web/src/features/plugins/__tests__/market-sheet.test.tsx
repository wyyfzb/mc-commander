/**
 * 插件市场侧滑面板集成测试（feat-8 延伸：Modrinth 一键安装）
 * MSW 拦截市场三端点（搜索/版本/安装），覆盖：
 * - 打开即浏览热门（空关键词默认请求）+ 结果渲染
 * - 版本过滤预填实例 mcVersion
 * - 展开版本面板 + 通道徽章 + 安装成功 toast
 * - 40912 同名冲突 → 覆盖确认弹窗 → 覆盖安装成功
 * - 搜索失败错误态 + 重试按钮
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Toaster } from 'sonner'
import { MarketSheet } from '../market-sheet'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'

const SEARCH_FIXTURE = {
  totalHits: 2,
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
      categories: ['paper', 'economy'],
      serverSide: 'required',
      clientSide: 'unsupported',
    },
    {
      projectId: 'vault',
      slug: 'vault',
      title: 'Vault',
      description: 'Vault is a Permissions API',
      author: 'Sleaker',
      downloads: 1000,
      follows: 1,
      iconUrl: null,
      dateModified: null,
      categories: [],
      serverSide: null,
      clientSide: null,
    },
  ],
  cached: false,
}

const VERSIONS_FIXTURE = {
  projectSlug: 'essentialsx',
  versions: [
    {
      versionNumber: '2.21.0',
      versionType: 'release',
      name: 'EssentialsX 2.21.0',
      changelog: null,
      datePublished: '2026-01-01T00:00:00Z',
      downloads: 100,
      gameVersions: ['1.21.4', '1.21.3'],
      loaders: ['paper'],
      file: {
        url: 'https://cdn.modrinth.com/data/x/versions/a/EssentialsX-2.21.0.jar',
        filename: 'EssentialsX-2.21.0.jar',
        size: 4605977,
      },
    },
  ],
  cached: false,
}

let installStatus: number
let installBody: { slug?: string; versionNumber?: string } | undefined

const server = setupServer(
  http.get('/api/v1/instances/demo/plugins', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: { plugins: [] } }),
  ),
  http.get('/api/v1/instances/demo/plugins/market/search', ({ request }) => {
    const url = new URL(request.url)
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'ok',
      data: {
        ...SEARCH_FIXTURE,
        requestedQ: url.searchParams.get('q'),
        gameVersion: url.searchParams.get('game_version'),
      },
    })
  }),
  http.get('/api/v1/instances/demo/plugins/market/projects/:slug/versions', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: VERSIONS_FIXTURE }),
  ),
  http.post('/api/v1/instances/demo/plugins/market/install', async ({ request }) => {
    installBody = (await request.json()) as { slug?: string; versionNumber?: string }
    if (installStatus === 409) {
      return HttpResponse.json(
        { status: 'error', code: 40912, message: 'Plugin file already exists' },
        { status: 409 },
      )
    }
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'ok',
      data: {
        file: 'EssentialsX-2.21.0.jar',
        sizeBytes: 4605977,
        mtimeMs: Date.now(),
        meta: null,
        overwritten: false,
        slug: 'essentialsx',
        versionNumber: '2.21.0',
        source: 'modrinth',
        originalFileName: 'EssentialsX-2.21.0.jar',
      },
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function renderSheet() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MarketSheet open onOpenChange={() => {}} instanceId="demo" />
      <Toaster />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  installStatus = 200
  installBody = undefined
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

describe('MarketSheet', () => {
  it('打开即浏览热门插件并渲染结果卡片', async () => {
    renderSheet()
    expect(await screen.findByText('EssentialsX')).toBeInTheDocument()
    expect(screen.getByText('Vault')).toBeInTheDocument()
    expect(screen.getByText(/757k/)).toBeInTheDocument() // formatCompact（chip 内含 ↓ 前缀）
    expect(screen.getByText(/共 2 个结果/)).toBeInTheDocument()
  })

  it('版本过滤预填实例 mcVersion', async () => {
    useServerStore.setState({
      status: { mcVersion: '1.21.4' } as never,
      systemStats: null,
      instanceId: 'demo',
      socketConnected: true,
      lastStatusEvent: null,
    })
    renderSheet()
    await screen.findByText('EssentialsX')
    const gv = screen.getByTestId('market-game-version') as HTMLInputElement
    expect(gv.value).toBe('1.21.4')
  })

  it('点击卡片展开版本面板并显示通道徽章与安装按钮', async () => {
    renderSheet()
    fireEvent.click(await screen.findByRole('button', { name: /展开 EssentialsX 的版本列表/ }))
    expect(await screen.findByText('2.21.0')).toBeInTheDocument()
    expect(screen.getByText('正式')).toBeInTheDocument()
    expect(screen.getByText(/4\.4 MB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '安装 EssentialsX 2.21.0' })).toBeInTheDocument()
  })

  it('安装成功：toast 提示生效；请求体携带 slug 与 versionNumber', async () => {
    const user = userEvent.setup()
    renderSheet()
    fireEvent.click(await screen.findByRole('button', { name: /展开 EssentialsX 的版本列表/ }))
    const btn = await screen.findByRole('button', { name: '安装 EssentialsX 2.21.0' })
    await user.click(btn)
    await waitFor(() =>
      expect(screen.getByText(/已安装 EssentialsX-2.21.0.jar/)).toBeInTheDocument(),
    )
    expect(installBody).toMatchObject({ slug: 'essentialsx', versionNumber: '2.21.0' })
  })

  it('同名冲突：默认安装返回 40912 → 弹覆盖确认 → 确认后覆盖安装成功', async () => {
    installStatus = 409
    const user = userEvent.setup()
    renderSheet()
    fireEvent.click(await screen.findByRole('button', { name: /展开 EssentialsX 的版本列表/ }))
    const btn = await screen.findByRole('button', { name: '安装 EssentialsX 2.21.0' })
    await user.click(btn)
    expect(await screen.findByText('同名插件文件已存在')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '覆盖安装' }))
    await waitFor(() =>
      expect(screen.getByText(/已安装 EssentialsX-2.21.0.jar/)).toBeInTheDocument(),
    )
  })

  it('搜索失败展示错误态与重试按钮', async () => {
    server.use(
      http.get('/api/v1/instances/demo/plugins/market/search', () =>
        HttpResponse.json(
          { status: 'error', code: 50301, message: 'Modrinth upstream error' },
          { status: 502 },
        ),
      ),
    )
    renderSheet()
    expect(await screen.findByText('搜索失败')).toBeInTheDocument()
    expect(screen.getAllByText(/Modrinth 服务暂时不可用|Modrinth upstream/).length).toBeGreaterThan(
      0,
    )
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('无匹配空态提供「清空过滤」CTA：清关键词+过滤后回到热门浏览（issue 343）', async () => {
    const user = userEvent.setup()
    let lastQ = ''
    server.use(
      http.get('/api/v1/instances/demo/plugins/market/search', ({ request }) => {
        const url = new URL(request.url)
        const q = url.searchParams.get('q') ?? ''
        // 关键词 nonexist 时返回空结果；清空后恢复热门
        if (q === 'nonexist') {
          lastQ = q
          return HttpResponse.json({
            status: 'ok',
            code: 0,
            message: 'ok',
            data: { totalHits: 0, hits: [], cached: false },
          })
        }
        lastQ = q
        return HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'ok',
          data: SEARCH_FIXTURE,
        })
      }),
    )
    renderSheet()
    await screen.findByText('EssentialsX')
    // 输入无匹配关键词
    const input = screen.getByPlaceholderText(/搜索插件/) as HTMLInputElement
    await user.type(input, 'nonexist')
    await user.click(screen.getByRole('button', { name: '重新搜索' }))
    // 空态出现 + CTA
    expect(await screen.findByText('没有找到匹配的插件')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清空过滤' }))
    // 清空后恢复热门浏览（输入框也被清空）
    expect(await screen.findByText('EssentialsX')).toBeInTheDocument()
    expect(lastQ).toBe('')
    expect((screen.getByPlaceholderText(/搜索插件/) as HTMLInputElement).value).toBe('')
  })
})
