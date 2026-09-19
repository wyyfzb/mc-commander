/**
 * PluginsPage 集成测试（issue 432：插件域 0% 覆盖收口）
 * MSW 拦截列表/启停/删除/更新检测端点；上传走 FakeXHR 全局替换
 * （jsdom 不触发真实 upload progress，手动编排，沿用 files-page-upload-progress 先例），覆盖：
 * - 列表渲染：元数据行（版本/作者）+ 启停状态 Chip + 统计口径
 * - 搜索过滤：>5 个插件出现搜索框 → 命中过滤 → 无匹配空态
 * - 上传按钮触发：隐藏 file input click 接线 + FakeXHR 入队（进度直更/进度条/成功收尾）
 * - 空态：暂无插件 + 市场 CTA
 * - 更新检测：check-updates → 行内「可更新」徽章联动
 * - 批量操作条：勾选行出现
 * 文件名与玩家数据均为虚构示例，严禁真实服务器数据
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { Toaster, toast } from 'sonner'
import { PluginsPage } from '../plugins-page'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import type { PluginInfo } from '@/api/types'

// ── FakeXHR：替换全局 XMLHttpRequest，手动编排 upload progress 与 load 响应 ──
type ProgressCb = (e: { lengthComputable: boolean; loaded: number; total: number }) => void

const sentXHR: FakeXHR[] = []

class FakeXHR {
  timeout = 0
  responseType = ''
  responseText = ''
  status = 200
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

  open() {}
  setRequestHeader() {}
  abort() {}

  send() {
    sentXHR.push(this)
  }

  emitProgress(loaded: number, total: number) {
    for (const cb of this.progressCbs) cb({ lengthComputable: true, loaded, total })
  }

  emitLoad(payload: object) {
    this.responseText = JSON.stringify(payload)
    for (const cb of this.listeners.load ?? []) cb()
  }
}

// ── fixture（虚构数据） ──

const ESSENTIALS_META = {
  name: 'EssentialsX',
  version: '2.21.0',
  main: 'com.earth2me.essentials.Essentials',
  apiVersion: '1.21',
  description: 'The essential plugin suite',
  authors: ['EssentialsX Team'],
  depend: ['Vault'],
  softdepend: [],
  website: null,
  load: 'POSTWORLD' as const,
}

const VAULT_META = {
  name: 'Vault',
  version: '1.7.3',
  main: 'net.milkbowl.vault.Vault',
  apiVersion: null,
  description: null,
  authors: ['Sleaker'],
  depend: [],
  softdepend: [],
  website: null,
  load: null,
}

function mkPlugin(
  file: string,
  enabled: boolean,
  meta: typeof ESSENTIALS_META | typeof VAULT_META | null = null,
): PluginInfo {
  return { file, name: file, enabled, sizeBytes: 4605977, mtimeMs: 1760000000000, meta }
}

/** 6 个插件（触发搜索框渲染阈值 plugins.length > 5） */
const PLUGINS_FIXTURE: PluginInfo[] = [
  mkPlugin('EssentialsX-2.21.0.jar', true, ESSENTIALS_META),
  mkPlugin('Vault-1.7.3.jar', false, VAULT_META),
  mkPlugin('DemoA.jar', false),
  mkPlugin('DemoB.jar', false),
  mkPlugin('DemoC.jar', true),
  mkPlugin('DemoD.jar', false),
]

const CHECK_UPDATES_FIXTURE = {
  checkedAt: '2026-01-01T00:00:00Z',
  results: [
    {
      file: 'EssentialsX-2.21.0.jar',
      name: 'EssentialsX',
      installedVersion: '2.21.0',
      enabled: true,
      matched: true,
      slug: 'essentialsx',
      title: 'EssentialsX',
      iconUrl: null,
      latestVersion: '2.22.0',
      updateAvailable: true,
      hasNewer: true,
    },
  ],
}

const server = setupServer(
  http.get('/api/v1/instances/demo/plugins', () =>
    HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: { plugins: PLUGINS_FIXTURE } }),
  ),
  http.put('/api/v1/instances/demo/plugins/:file/enabled', ({ params }) =>
    HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'ok',
      data: { file: String(params.file), enabled: true },
    }),
  ),
  http.delete('/api/v1/instances/demo/plugins/:file', ({ params }) =>
    HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'ok',
      data: { deleted: String(params.file) },
    }),
  ),
  http.post('/api/v1/instances/demo/plugins/check-updates', () =>
    HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'ok',
      data: CHECK_UPDATES_FIXTURE,
    }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/plugins',
        element: (
          <QueryClientProvider client={qc}>
            <PluginsPage />
            <Toaster />
          </QueryClientProvider>
        ),
      },
      // 空态 CTA 的落点（回显 path+search，用于断言深链参数）
      { path: '/instances', element: <ReachedInstances /> },
    ],
    { initialEntries: ['/plugins'] },
  )
  return render(<RouterProvider router={router} />)
}

function ReachedInstances() {
  const location = useLocation()
  return <div>{`reached:${location.pathname}${location.search}`}</div>
}

beforeEach(() => {
  sentXHR.length = 0
  // sonner toast store 模块级：清残留防跨测试泄漏
  toast.dismiss()
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
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

function okUploadEnvelope(file: string) {
  return {
    status: 'ok',
    code: 0,
    message: 'Success',
    data: { file, sizeBytes: 4605977, mtimeMs: 1760000000000, meta: null, overwritten: false },
  }
}

describe('PluginsPage 列表渲染', () => {
  it('渲染插件卡片：元数据（名称/版本/API/作者/依赖）+ 状态 Chip + 统计口径', async () => {
    renderPage()
    expect(await screen.findByText('EssentialsX')).toBeInTheDocument()
    expect(screen.getByText('Vault')).toBeInTheDocument()
    expect(screen.getByText('v2.21.0')).toBeInTheDocument()
    expect(screen.getByText('API 1.21')).toBeInTheDocument()
    expect(screen.getByText(/作者 EssentialsX Team/)).toBeInTheDocument()
    expect(screen.getByText(/依赖：Vault/)).toBeInTheDocument()
    // 状态 Chip：启用 2（EssentialsX + DemoC）/ 禁用 4
    expect(screen.getAllByText('已启用')).toHaveLength(2)
    expect(screen.getAllByText('已禁用')).toHaveLength(4)
    // 统计口径（PageHeader 描述内嵌）
    expect(screen.getByText(/共 6 个（启用 2 \/ 禁用 4）/)).toBeInTheDocument()
  })

  it('无实例时空态引导：暂无服务器实例 CTA 直达部署向导', async () => {
    const user = userEvent.setup()
    // 本地 server 不含 /instances（onUnhandledRequest: error）：显式覆写为「确实零实例」
    server.use(
      http.get('/api/v1/instances', () =>
        HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: [] }),
      ),
    )
    useServerStore.setState({ instanceId: null })
    renderPage()
    expect(await screen.findByText('暂无服务器实例')).toBeInTheDocument()
    // 零实例场景唯一有用的动作是建实例 → 深链直达部署向导（此前只跳 /instances 列表页）
    await user.click(screen.getByRole('button', { name: '部署新实例' }))
    expect(screen.getByText('reached:/instances?tab=deploy')).toBeInTheDocument()
  })
})

describe('PluginsPage 页头说明载体', () => {
  it('说明不常驻：描述行只留计数，全文挂在信息入口里', async () => {
    renderPage()
    await screen.findByText('EssentialsX')

    // 常驻说明句会把标题列挤成一个字宽（实测 433px 下 40px），故只保留入口
    expect(screen.queryByText(/管理 Bukkit 系插件（Paper\/Spigot）/)).not.toBeInTheDocument()
    expect(screen.getByText(/共 6 个（启用 2 \/ 禁用 4）/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '插件管理说明' })).toBeInTheDocument()
  })

  it('信息不丢：点按入口可读到完整说明（含生效时机）', async () => {
    const user = userEvent.setup()
    renderPage()
    const trigger = await screen.findByRole('button', { name: '插件管理说明' })

    await user.click(trigger)

    const hint = await screen.findByRole('dialog', { name: '插件管理说明' })
    expect(hint).toHaveTextContent('管理 Bukkit 系插件（Paper/Spigot）')
    expect(hint).toHaveTextContent('启停与增删在重启实例后生效')
  })
})

describe('PluginsPage 搜索过滤', () => {
  it('多于 5 个插件出现搜索框；关键词命中后其余行消失', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('EssentialsX')
    const input = screen.getByPlaceholderText('搜索插件名或文件名…')
    await user.type(input, 'vault')
    expect(screen.getByText('Vault')).toBeInTheDocument()
    expect(screen.queryByText('EssentialsX')).not.toBeInTheDocument()
    expect(screen.queryByText('DemoA.jar')).not.toBeInTheDocument()
  })

  it('无匹配关键词展示空态提示', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('EssentialsX')
    const input = screen.getByPlaceholderText('搜索插件名或文件名…')
    await user.type(input, 'nonexist')
    expect(await screen.findByText('无匹配插件')).toBeInTheDocument()
    expect(screen.getByText('换个关键词试试')).toBeInTheDocument()
  })
})

describe('PluginsPage 上传入口', () => {
  it('点击「上传插件」按钮触发隐藏 file input', async () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    renderPage()
    await screen.findByText('EssentialsX')
    fireEvent.click(screen.getByRole('button', { name: '上传插件' }))
    expect(clickSpy).toHaveBeenCalledTimes(1)
    clickSpy.mockRestore()
  })

  it('file input 选择 .jar：FakeXHR 入队 → 进度条直更 → 完成收尾（进度条消失 + success toast）', async () => {
    renderPage()
    await screen.findByText('EssentialsX')

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { files: [new File(['data'], 'DemoX.jar')] } })
    await waitFor(() => expect(sentXHR).toHaveLength(1))

    // 进度条出现 + ARIA 三元组 + 进度直更
    const bar = await screen.findByRole('progressbar', { name: '上传进度' })
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    const xhr = sentXHR[0]!
    xhr.emitProgress(40, 100)
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40'),
    )

    // 完成收尾
    xhr.emitLoad(okUploadEnvelope('DemoX.jar'))
    expect(
      await screen.findByText('已上传 DemoX.jar，落入 plugins/，重启实例后生效'),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument())
  })

  it('file input 选择非 .jar：错误提示且不发起请求', async () => {
    renderPage()
    await screen.findByText('EssentialsX')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['data'], 'note.zip')] } })
    // .jar 过滤在选择处理器内同步判定；提示出现即证明过滤分支已执行
    expect(await screen.findByText('仅支持上传 .jar 插件文件')).toBeInTheDocument()
    expect(sentXHR).toHaveLength(0)
  })
})

describe('PluginsPage 空态与更新检测', () => {
  it('列表为空展示空态：暂无插件 + 市场一键安装 CTA', async () => {
    server.use(
      http.get('/api/v1/instances/demo/plugins', () =>
        HttpResponse.json({ status: 'ok', code: 0, message: 'ok', data: { plugins: [] } }),
      ),
    )
    renderPage()
    expect(await screen.findByText('暂无插件')).toBeInTheDocument()
    expect(screen.getByTestId('open-market-empty')).toBeInTheDocument()
  })

  it('加载失败展示错误空态与重试按钮', async () => {
    server.use(
      http.get('/api/v1/instances/demo/plugins', () =>
        HttpResponse.json(
          { status: 'error', code: 50000, message: 'internal error' },
          { status: 500 },
        ),
      ),
    )
    renderPage()
    expect(await screen.findByText('加载失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('检查更新：POST check-updates → 行内「可更新」徽章出现', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('EssentialsX')
    expect(screen.queryByTestId('update-badge')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('check-updates'))
    expect(await screen.findByTestId('update-badge')).toBeInTheDocument()
    expect(screen.getByText(/可更新 → 2\.22\.0/)).toBeInTheDocument()
    expect(screen.getByText(/检测到 1 个插件有新版本/)).toBeInTheDocument()
  })
})

describe('PluginsPage 启停与删除', () => {
  it('行内禁用：PUT enabled 成功 → toast 提示重启生效', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('EssentialsX')
    await user.click(screen.getByRole('button', { name: '禁用 EssentialsX' }))
    // toast 文案用 plugin.name（此处等于文件名），非 meta.name
    expect(
      await screen.findByText(/已禁用 EssentialsX-2\.21\.0\.jar，重启实例后生效/),
    ).toBeInTheDocument()
  })

  it('行删除：确认弹窗 → DELETE 成功 → toast 提示', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('EssentialsX')
    await user.click(screen.getByRole('button', { name: '删除 DemoA.jar' }))
    // 确认弹窗（标题含文件名 + 不可撤销警告）
    expect(await screen.findByText('删除插件 DemoA.jar？')).toBeInTheDocument()
    expect(screen.getByText('此操作不可撤销')).toBeInTheDocument()
    // 弹窗内确认按钮（文本「删除」，与行内 aria-label 区分：在 dialog role 内查询）
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '删除' }))
    expect(await screen.findByText(/插件 DemoA\.jar 已删除/)).toBeInTheDocument()
  })
})

describe('PluginsPage 批量操作', () => {
  it('勾选行出现批量操作条并显示已选数量', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('EssentialsX')
    expect(screen.queryByTestId('batch-bar')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('选择 EssentialsX'))
    expect(screen.getByTestId('batch-bar')).toBeInTheDocument()
    expect(screen.getByText(/已选/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消选择' }))
    expect(screen.queryByTestId('batch-bar')).not.toBeInTheDocument()
  })
})
