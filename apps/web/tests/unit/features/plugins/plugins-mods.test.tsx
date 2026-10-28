/**
 * PluginsPage 模组模式（Fabric/Forge 实例）
 *
 * 装载目标只认服务端的 market/profile：页面据此把同一套列表/市场切到 mods/，
 * 不再出现「Fabric 实例只能上传插件」的死路。覆盖：
 * - 标题/按钮/文案切换为模组，且不再读 plugins/ 列表
 * - 模组没有文件层启停：行内不出现启停状态与启停按钮
 * - 插件专属的「检查更新」在模组模式消失（它读的是 plugin.yml）
 * - 上传/删除走 mods/ 端点（装载目标决定端点前缀，不只是展示措辞）
 * - 市场面板：标题/落盘目录/前置依赖提示，loader 只给实例自身那一个
 *
 * 文件名与项目均为虚构示例（Modrinth 上真实项目仅出现在 market 用例的只读样本里，
 * 本文件统一用 Demo 系列名，避免把真实数据当断言依赖）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { Toaster, toast } from 'sonner'
import { PluginsPage } from '@/features/plugins/plugins-page'
import { MarketSheet } from '@/features/plugins/market-sheet'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import type { InstanceStatus, PluginInfo } from '@/api/types'

// ── FakeXHR：替换全局 XMLHttpRequest，记录上传 URL 并手动回包（jsdom 不跑真实上传）──
type ProgressCb = (e: { lengthComputable: boolean; loaded: number; total: number }) => void

const sentXHR: FakeXHR[] = []

class FakeXHR {
  timeout = 0
  responseType = ''
  responseText = ''
  status = 200
  url = ''
  private progressCbs: ProgressCb[] = []
  private listeners: Record<string, (() => void)[]> = {}

  upload = {
    addEventListener: (_: string, cb: ProgressCb) => {
      this.progressCbs.push(cb)
    },
  }

  addEventListener(ev: string, cb: () => void) {
    ;(this.listeners[ev] ??= []).push(cb)
  }
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader() {}
  abort() {}
  send() {
    sentXHR.push(this)
  }
  emitLoad(payload: object) {
    this.responseText = JSON.stringify(payload)
    for (const cb of this.listeners.load ?? []) cb()
  }
}

const MOD_META_NULL = null

function mkMod(file: string): PluginInfo {
  return {
    file,
    name: file.replace(/\.jar$/, ''),
    // 模组没有 .disabled 约定：列表给 enabled=true，展示层不该据此显示「已启用」
    enabled: true,
    sizeBytes: 354095,
    mtimeMs: 1760000000000,
    meta: MOD_META_NULL,
  }
}

const MODS_FIXTURE: PluginInfo[] = [mkMod('DemoModA.jar'), mkMod('DemoModB.jar')]

const PROFILE_FIXTURE = {
  kind: 'mod',
  loader: 'fabric',
  loaders: ['fabric', 'forge', 'neoforge', 'quilt'],
}

const SEARCH_FIXTURE = {
  totalHits: 1,
  cached: false,
  hits: [
    {
      projectId: 'demoProject',
      slug: 'demomod',
      title: 'DemoMod',
      description: '服务端可用的演示模组',
      author: 'demoAuthor',
      downloads: 10,
      follows: 1,
      iconUrl: null,
      dateModified: '2026-01-01T00:00:00Z',
      categories: ['fabric'],
      serverSide: 'optional',
      clientSide: 'optional',
    },
  ],
}

const VERSIONS_FIXTURE = {
  projectSlug: 'demomod',
  cached: false,
  versions: [
    {
      versionNumber: '1.0.0',
      versionType: 'release',
      name: 'DemoMod 1.0.0',
      changelog: null,
      datePublished: '2026-01-01T00:00:00Z',
      downloads: 10,
      gameVersions: ['1.21.4'],
      loaders: ['fabric'],
      dependencies: [{ projectId: 'demoApi', dependencyType: 'required' }],
      file: {
        url: 'https://cdn.modrinth.com/data/demo/versions/a/DemoMod-1.0.0.jar',
        filename: 'DemoMod-1.0.0.jar',
        size: 100,
        sha512: null,
      },
    },
  ],
}

const INSTALL_RESULT = {
  file: 'DemoMod-1.0.0.jar',
  sizeBytes: 100,
  mtimeMs: 1760000000000,
  meta: null,
  overwritten: false,
  slug: 'demomod',
  versionNumber: '1.0.0',
  source: 'modrinth',
  originalFileName: 'DemoMod-1.0.0.jar',
  kind: 'mod',
  installedTo: 'mods',
  requiredDependencies: [{ projectId: 'demoApi', slug: 'demoapi', title: 'Demo API' }],
}

let pluginsListCalls = 0
let deletedMods: string[] = []
let marketSearchUrls: string[] = []

const server = setupServer(
  http.get('/api/v1/instances/demo/plugins/market/profile', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: PROFILE_FIXTURE }),
  ),
  http.get('/api/v1/instances/demo/mods', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: { plugins: MODS_FIXTURE } }),
  ),
  http.get('/api/v1/instances/demo/plugins', () => {
    pluginsListCalls += 1
    // 模组实例读 plugins/ 是把路径当成了寻址手段：这张表不该被拉到
    return HttpResponse.json(
      { status: 'ok', code: 0, message: 'ok', data: { plugins: [] } },
      { status: 500 },
    )
  }),
  http.delete('/api/v1/instances/demo/mods/:file', ({ params }) => {
    deletedMods.push(String(params.file))
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'ok',
      data: { deleted: String(params.file) },
    })
  }),
  http.get('/api/v1/instances/demo/plugins/market/search', ({ request }) => {
    marketSearchUrls.push(request.url)
    return HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: SEARCH_FIXTURE })
  }),
  http.get('/api/v1/instances/demo/plugins/market/projects/:slug/versions', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: VERSIONS_FIXTURE }),
  ),
  http.post('/api/v1/instances/demo/plugins/market/install', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: INSTALL_RESULT }),
  ),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  pluginsListCalls = 0
  deletedMods = []
  marketSearchUrls = []
  sentXHR.length = 0
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  toast.dismiss()
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

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PluginsPage />
      <Toaster />
    </QueryClientProvider>,
  )
}

describe('PluginsPage 模组模式', () => {
  it('标题/按钮切换为模组，且不读 plugins/ 目录', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { level: 2, name: '模组管理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上传模组' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开模组市场' })).toBeInTheDocument()
    expect(await screen.findByText('DemoModA.jar')).toBeInTheDocument()
    expect(pluginsListCalls).toBe(0)
  })

  it('模组没有文件层启停：不出现启停状态、启停按钮与批量启停', async () => {
    renderPage()
    await screen.findByText('DemoModA.jar')

    expect(screen.queryByText('已启用')).not.toBeInTheDocument()
    expect(screen.queryByText('已禁用')).not.toBeInTheDocument()
    // 行内只有删除按钮，没有启停
    expect(screen.queryByRole('button', { name: /禁用 DemoModA/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除 DemoModA' })).toBeInTheDocument()
  })

  it('插件专属的「检查更新」在模组模式不出现（它读 plugin.yml 元数据）', async () => {
    renderPage()
    await screen.findByText('DemoModA.jar')
    expect(screen.queryByTestId('check-updates')).not.toBeInTheDocument()
  })

  it('上传走 mods/upload 端点，成功提示落入 mods/', async () => {
    renderPage()
    await screen.findByText('DemoModA.jar')

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { files: [new File(['x'], 'DemoX.jar')] } })
    await waitFor(() => expect(sentXHR).toHaveLength(1))
    expect(sentXHR[0]!.url).toBe('/api/v1/instances/demo/mods/upload')

    sentXHR[0]!.emitLoad({
      status: 'ok',
      code: 0,
      message: 'Success',
      data: {
        file: 'DemoX.jar',
        sizeBytes: 1,
        mtimeMs: 1760000000000,
        meta: null,
        overwritten: false,
      },
    })
    expect(await screen.findByText(/落入 mods\//)).toBeInTheDocument()
  })

  it('删除走 mods/:file 端点', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('DemoModA.jar')

    await user.click(screen.getByRole('button', { name: '删除 DemoModA' }))
    await user.click(await screen.findByRole('button', { name: '删除' }))

    await waitFor(() => expect(deletedMods).toContain('DemoModA.jar'))
  })

  it('装载目标只认服务端 profile：status 里写 Fabric 也不能把页面拉回插件模式', async () => {
    // 旧路径若按 status.modLoader 判档，这里会渲染成「插件管理」
    useServerStore.setState({ status: { modLoader: 'Fabric' } as unknown as InstanceStatus })
    server.use(
      http.get('/api/v1/instances/demo/plugins/market/profile', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'ok',
          data: { kind: 'plugin', loader: null },
        }),
      ),
      http.get('/api/v1/instances/demo/plugins', () =>
        HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: { plugins: [] } }),
      ),
    )
    renderPage()

    expect(await screen.findByRole('heading', { level: 2, name: '插件管理' })).toBeInTheDocument()
  })
})

describe('MarketSheet 模组模式', () => {
  function renderSheet() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <MarketSheet
          open
          onOpenChange={() => {}}
          instanceId="demo"
          kind="mod"
          lockedLoader="fabric"
        />
        <Toaster />
      </QueryClientProvider>,
    )
  }

  it('搜索只发实例自身 loader；安装成功提示落盘到 mods/ 并点名必需前置', async () => {
    const user = userEvent.setup()
    renderSheet()

    // 打开即搜索：loader 只能是实例的 fabric
    await waitFor(() => expect(marketSearchUrls.length).toBeGreaterThan(0))
    const first = new URL(marketSearchUrls[0]!)
    expect(first.searchParams.get('loader')).toBe('fabric')

    fireEvent.click(await screen.findByRole('button', { name: /展开 DemoMod 的版本列表/ }))
    const install = await screen.findByRole('button', { name: '安装 DemoMod 1.0.0' })
    await user.click(install)

    expect(await screen.findByText(/已装入 mods\//)).toBeInTheDocument()
    expect(await screen.findByText(/声明了 1 个必需前置/)).toBeInTheDocument()
    expect(screen.getByText(/Demo API（不会自动安装/)).toBeInTheDocument()
  })

  it('同名冲突文案按装载目标说「模组」，不说「插件」', async () => {
    server.use(
      http.post('/api/v1/instances/demo/plugins/market/install', () =>
        HttpResponse.json(
          { status: 'error', code: 40912, message: 'Mod file already exists' },
          { status: 409 },
        ),
      ),
    )
    const user = userEvent.setup()
    renderSheet()

    fireEvent.click(await screen.findByRole('button', { name: /展开 DemoMod 的版本列表/ }))
    await user.click(await screen.findByRole('button', { name: '安装 DemoMod 1.0.0' }))

    expect(await screen.findByText('同名模组文件已存在')).toBeInTheDocument()
    expect(screen.getByText(/mods\/ 目录已存在 DemoMod-1\.0\.0\.jar/)).toBeInTheDocument()
  })
})
