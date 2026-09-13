/**
 * BackupPanel 测试：
 * - 无实例空态 / 上次备份行（含无 completed 兜底）/ 列表行渲染（zip 旧格式徽章、failed 徽章、tone 类抽查）
 * - 恢复确认与 toast / zip·failed 行恢复禁用 / 任一行 restoring → 全列表恢复禁用
 * - 删除确认与 toast / 进行中（creating）行删除禁用
 * - 立即备份在途禁用 + 成功/失败 toast / 空态引导与「配置定时备份」跳转 /tasks
 * - 下载：completed 快照可下载（文件名含时间戳）→ a[download] 触发 + toast；
 *   zip/failed 禁用 + title 提示；下载中行级转圈禁用；失败错误 toast
 * mock 数据为结构占位（mockBackups 虚构内容），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers, mockBackups } from '@/test/mocks/handlers'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { formatBackupDate, formatBackupSize } from '@/lib/mc-backup'
import type { BackupItem } from '@/api/types'
import { BackupPanel, buildBackupDownloadName } from '../backup-panel'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** 测试注入用统一响应信封（结构占位） */
function okEnvelope<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function renderPanel(instanceId: string | null = 'demo') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/settings/backups',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <BackupPanel instanceId={instanceId} />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
      { path: '/tasks', element: <div>定时任务页</div> },
    ],
    { initialEntries: ['/settings/backups'] },
  )
  render(<RouterProvider router={router} />)
  // 返回 queryClient 供用例等待「数据真正落地」（只断挂载首帧的话任何响应都能蒙对）
  return qc
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
})

describe('BackupPanel 空态', () => {
  it('instanceId=null 且列表为空：真零实例空态（复用其他页同文案）', async () => {
    server.use(http.get('*/api/v1/instances', () => okEnvelope([])))
    renderPanel(null)
    expect(await screen.findByText('暂无服务器实例')).toBeInTheDocument()
    expect(screen.getByText('使用部署向导创建第一个实例')).toBeInTheDocument()
    expect(screen.queryByText('备份管理')).not.toBeInTheDocument()
  })

  it('instanceId=null 但实例列表非空：过渡占位，不谎报零实例（app-shell 尚未选中首帧）', async () => {
    const qc = renderPanel(null)
    // 默认 handlers 返回 1 个实例：等它真正落地再断言，否则空列表也能对上首帧
    await waitFor(() => expect(qc.getQueryData(queryKeys.instances())).toHaveLength(1))
    expect(screen.getByText('正在载入服务器实例…')).toBeInTheDocument()
    expect(screen.queryByText('暂无服务器实例')).not.toBeInTheDocument()
  })

  it('列表为空：引导文案 +「配置定时备份」跳转 /tasks', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/api/v1/instances/:id/backups', () => okEnvelope([])))
    renderPanel()
    expect(await screen.findByText('点击“立即备份”或配置定时备份任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '配置定时备份' }))
    expect(await screen.findByText('定时任务页')).toBeInTheDocument()
  })
})

describe('BackupPanel 上次备份与列表渲染', () => {
  it('标题 + 快照机制说明 + 上次备份行（最近一条 completed：日期 · 大小）', async () => {
    renderPanel()
    expect(await screen.findByText('备份管理')).toBeInTheDocument()
    expect(
      screen.getByText('快照备份：未修改文件零拷贝增量传输，超出保留策略自动清理（默认保留策略见服务端配置）'),
    ).toBeInTheDocument()
    // 等待列表数据加载完成（标题为静态文案，先于数据渲染）
    await screen.findByText('手动备份')
    const completed = mockBackups.find((b) => b.status === 'completed')!
    const expected = `上次备份：${formatBackupDate(completed.createdAt)} · ${formatBackupSize(completed.size)}`
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it('无 completed 备份：上次备份行显示「尚未创建备份」', async () => {
    const withoutCompleted = mockBackups.filter((b) => b.status !== 'completed')
    server.use(http.get('*/api/v1/instances/:id/backups', () => okEnvelope(withoutCompleted)))
    renderPanel()
    expect(await screen.findByText('尚未创建备份')).toBeInTheDocument()
  })

  it('列表行渲染：名称 / 状态徽章 / 时间·大小 / 旧格式徽章（zip）', async () => {
    renderPanel()
    await screen.findByText('手动备份')
    expect(screen.getByText('旧格式压缩包')).toBeInTheDocument()
    expect(screen.getByText('失败的备份')).toBeInTheDocument()

    // 状态徽章：completed ×2（已就绪）+ failed ×1（失败）
    expect(screen.getAllByText('已就绪')).toHaveLength(2)
    expect(screen.getByText('失败')).toBeInTheDocument()

    // 旧格式徽章仅 zip 行
    expect(screen.getByText('旧格式')).toBeInTheDocument()

    // 时间 · 大小行（zip：日期 · 大小；failed size=0 → 仅日期）
    const zip = mockBackups[1]!
    expect(
      screen.getByText(`${formatBackupDate(zip.createdAt)} · ${formatBackupSize(zip.size)}`),
    ).toBeInTheDocument()
    const failed = mockBackups[2]!
    expect(screen.getByText(formatBackupDate(failed.createdAt))).toBeInTheDocument()

    // 状态徽章 tone token 类抽查（token 纪律：禁硬编码色值）
    const successBadge = screen.getAllByText('已就绪')[0]!
    expect(successBadge.className).toContain('bg-mcs-success-bg-subtle')
    expect(successBadge.className).toContain('text-mcs-success-fg')
    expect(successBadge.className).toContain('border-mcs-success-border')
    const errorBadge = screen.getByText('失败')
    expect(errorBadge.className).toContain('bg-mcs-error-bg-subtle')
    expect(errorBadge.className).toContain('text-mcs-error-fg')
    const legacyBadge = screen.getByText('旧格式')
    expect(legacyBadge.className).toContain('bg-mcs-warning-bg-subtle')
    expect(legacyBadge.className).toContain('text-mcs-warning-fg')
  })
})

describe('BackupPanel 恢复', () => {
  it('恢复危险确认（标题/影响说明/实例名输入）：不匹配禁用 → 输入匹配 → 确认 → 成功 toast', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('手动备份')
    await user.click(screen.getByRole('button', { name: '手动备份 恢复' }))
    // 红色警示标题 + 影响说明
    expect(screen.getByText('恢复备份（危险操作）')).toBeInTheDocument()
    expect(
      screen.getByText(/将用备份 “手动备份” 覆盖当前世界数据，且不可撤销/),
    ).toBeInTheDocument()
    // 输入不匹配 → 确认禁用
    const confirmBtn = screen.getByRole('button', { name: '确认恢复' })
    expect(confirmBtn).toBeDisabled()
    await user.type(screen.getByLabelText(/输入实例名/), '错误实例名')
    expect(confirmBtn).toBeDisabled()
    // 输入匹配实例名（mock handlers 实例名「演示实例」）→ 启用
    await user.clear(screen.getByLabelText(/输入实例名/))
    await user.type(screen.getByLabelText(/输入实例名/), '演示实例')
    expect(confirmBtn).toBeEnabled()
    await user.click(confirmBtn)
    expect(await screen.findByText('恢复已开始，完成后请启动服务器生效')).toBeInTheDocument()
  })

  it('zip 旧格式与 failed 备份：恢复按钮禁用，completed 快照可恢复', async () => {
    renderPanel()
    await screen.findByText('手动备份')
    expect(screen.getByRole('button', { name: '旧格式压缩包 恢复' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '失败的备份 恢复' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '手动备份 恢复' })).toBeEnabled()
  })

  it('任一行 restoring → 全列表恢复按钮禁用（含其余 completed 行）', async () => {
    const restoringList: BackupItem[] = [
      { ...mockBackups[0]!, id: 20, status: 'restoring', name: '恢复中的备份' },
      { ...mockBackups[0]!, id: 21, status: 'completed', name: '可恢复的备份' },
    ]
    server.use(http.get('*/api/v1/instances/:id/backups', () => okEnvelope(restoringList)))
    renderPanel()
    await screen.findByText('恢复中的备份')
    // 状态徽章「恢复中」
    expect(screen.getByText('恢复中')).toBeInTheDocument()
    // 恢复中行本身 + 其余 completed 行恢复全部禁用
    expect(screen.getByRole('button', { name: '恢复中的备份 恢复' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '可恢复的备份 恢复' })).toBeDisabled()
    // 恢复中行删除禁用；completed 行删除可用
    expect(screen.getByRole('button', { name: '恢复中的备份 删除' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '可恢复的备份 删除' })).toBeEnabled()
  })
})

describe('BackupPanel 删除', () => {
  it('删除确认对话框 → 确认 → 成功 toast（含备份名）', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('手动备份')
    await user.click(screen.getByRole('button', { name: '手动备份 删除' }))
    expect(screen.getByText('删除备份 “手动备份”？')).toBeInTheDocument()
    expect(screen.getByText('确定要删除备份 “手动备份” 吗？')).toBeInTheDocument()
    // 不可逆提示以 warning 色小字独立呈现（全站删除确认统一规范）
    expect(screen.getByText('此操作不可撤销')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText('备份已删除')).toBeInTheDocument()
  })

  it('进行中（creating）行：删除按钮禁用 + 状态徽章「备份中」', async () => {
    const creatingList: BackupItem[] = [
      { ...mockBackups[0]!, id: 30, status: 'creating', name: '创建中的备份' },
    ]
    server.use(http.get('*/api/v1/instances/:id/backups', () => okEnvelope(creatingList)))
    renderPanel()
    await screen.findByText('创建中的备份')
    expect(screen.getByText('备份中')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建中的备份 删除' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '创建中的备份 恢复' })).toBeDisabled()
  })
})

describe('BackupPanel 立即备份', () => {
  it('在途：按钮禁用 + 文案「备份中...」；完成后成功 toast', async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post('*/api/v1/instances/:id/backups', async () => {
        await gate
        return okEnvelope({ ...mockBackups[0]!, id: 40, status: 'creating' })
      }),
    )
    renderPanel()
    await screen.findByText('手动备份')
    await user.click(screen.getByRole('button', { name: '立即备份' }))
    // 在途：禁用 + 备份中...（gate 未放行，状态稳定可断言）
    await waitFor(() => {
      const inFlight = screen.getByRole('button', { name: '备份中...' })
      expect(inFlight).toBeDisabled()
    })
    release()
    expect(await screen.findByText('备份任务已启动')).toBeInTheDocument()
  })

  it('创建失败 → 错误 toast（错误码 40901 本地化映射）', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('*/api/v1/instances/:id/backups', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40901,
            message: 'backup in progress',
            details: null,
            timestamp: new Date().toISOString(),
          },
          { status: 409 },
        ),
      ),
    )
    renderPanel()
    await screen.findByText('手动备份')
    await user.click(screen.getByRole('button', { name: '立即备份' }))
    expect(await screen.findByText('操作失败：已有备份任务进行中')).toBeInTheDocument()
  })
})

describe('BackupPanel 列表截断与展开', () => {
  /** 生成 12 条虚构备份（超出 10 条截断阈值） */
  function makeManyBackups(count: number): BackupItem[] {
    return Array.from({ length: count }, (_, i) => ({
      ...mockBackups[0]!,
      id: 100 + i,
      name: `批量备份 ${String(i + 1).padStart(2, '0')}`,
      createdAt: new Date(Date.now() - i * 86_400_000).toISOString(),
    }))
  }

  it('不超过 10 条：显示总数但不显示展开按钮', async () => {
    const few = makeManyBackups(5)
    server.use(http.get('*/api/v1/instances/:id/backups', () => okEnvelope(few)))
    renderPanel()
    await screen.findByText('批量备份 01')
    expect(screen.queryByText(/显示全部/)).not.toBeInTheDocument()
    // 总数始终显示
    expect(screen.getByText('共 5 条备份')).toBeInTheDocument()
  })

  it('超过 10 条：显示「共 N 条备份，已显示 10 条」+「显示全部」按钮', async () => {
    const many = makeManyBackups(12)
    server.use(http.get('*/api/v1/instances/:id/backups', () => okEnvelope(many)))
    renderPanel()
    await screen.findByText('批量备份 01')
    // 截断提示
    expect(screen.getByText(/共 12 条备份，已显示 10 条/)).toBeInTheDocument()
    const expandBtn = screen.getByRole('button', { name: '显示全部' })
    expect(expandBtn).toBeInTheDocument()
    // 默认只渲染 10 条
    expect(screen.queryByText('批量备份 11')).not.toBeInTheDocument()
  })

  it('点击「显示全部」→ 展开全部 → 提示变为「共 N 条备份」+「收起」按钮', async () => {
    const user = userEvent.setup()
    const many = makeManyBackups(12)
    server.use(http.get('*/api/v1/instances/:id/backups', () => okEnvelope(many)))
    renderPanel()
    await screen.findByText('批量备份 01')
    // 展开
    await user.click(screen.getByRole('button', { name: '显示全部' }))
    // 全部 12 条可见
    expect(screen.getByText('批量备份 12')).toBeInTheDocument()
    // 提示文案变更
    expect(screen.getByText(/共 12 条备份/)).toBeInTheDocument()
    expect(screen.queryByText(/已显示 10 条/)).not.toBeInTheDocument()
    // 收起按钮
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
  })

  it('展开后点击「收起」→ 恢复截断显示', async () => {
    const user = userEvent.setup()
    const many = makeManyBackups(12)
    server.use(http.get('*/api/v1/instances/:id/backups', () => okEnvelope(many)))
    renderPanel()
    await screen.findByText('批量备份 01')
    // 展开
    await user.click(screen.getByRole('button', { name: '显示全部' }))
    expect(screen.getByText('批量备份 12')).toBeInTheDocument()
    // 收起
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByText('批量备份 11')).not.toBeInTheDocument()
    expect(screen.getByText(/共 12 条备份，已显示 10 条/)).toBeInTheDocument()
  })
})

describe('BackupPanel 下载', () => {
  /** jsdom 无真实下载：捕获 a[download] click 时的文件名 */
  let downloads: string[]

  beforeEach(() => {
    downloads = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-download')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('completed 快照行可下载：点击 → a[download] 触发（文件名含时间戳）+ ObjectURL 用后即 revoke + 成功 toast', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText('手动备份')
    await user.click(screen.getByRole('button', { name: '手动备份 下载' }))
    expect(await screen.findByText('备份已开始下载')).toBeInTheDocument()
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).toBe(buildBackupDownloadName(mockBackups[0]!))
    // 文件名含备份创建时间戳（紧凑 yyyyMMdd-HHmm）+ tar.gz 扩展名
    expect(downloads[0]).toMatch(/_\d{8}-\d{4}\.tar\.gz$/)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('zip 旧格式/failed 行下载禁用 + title 提示；completed 快照可用', async () => {
    renderPanel()
    await screen.findByText('手动备份')
    const zipBtn = screen.getByRole('button', { name: '旧格式压缩包 下载' })
    expect(zipBtn).toBeDisabled()
    expect(zipBtn).toHaveAttribute('title', '旧格式备份不支持下载')
    expect(screen.getByRole('button', { name: '失败的备份 下载' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '手动备份 下载' })).toBeEnabled()
  })

  it('下载中：按钮转圈禁用（title=正在下载...）→ 完成后恢复 + 成功 toast', async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('*/api/v1/backups/:id/download', async () => {
        await gate
        return new HttpResponse(new Uint8Array([0x1f, 0x8b]), {
          status: 200,
          headers: { 'Content-Type': 'application/gzip' },
        })
      }),
    )
    renderPanel()
    await screen.findByText('手动备份')
    await user.click(screen.getByRole('button', { name: '手动备份 下载' }))
    // 在途：禁用 + 转圈图标（gate 未放行，状态稳定可断言）
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: '手动备份 下载' })
      expect(btn).toBeDisabled()
      expect(btn.querySelector('.animate-spin')).not.toBeNull()
    })
    release()
    expect(await screen.findByText('备份已开始下载')).toBeInTheDocument()
    // 完成后按钮恢复可用
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '手动备份 下载' })).toBeEnabled()
    })
  })

  it('下载失败 → 错误 toast（40904 服务端中文文案透传）', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/api/v1/backups/:id/download', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40904,
            message: '旧格式备份不支持下载',
            details: null,
            timestamp: new Date().toISOString(),
          },
          { status: 409 },
        ),
      ),
    )
    renderPanel()
    await screen.findByText('手动备份')
    await user.click(screen.getByRole('button', { name: '手动备份 下载' }))
    expect(await screen.findByText('下载失败：旧格式备份不支持下载')).toBeInTheDocument()
    // 失败不触发浏览器下载
    expect(downloads).toHaveLength(0)
  })

  it('buildBackupDownloadName：非法 createdAt 不抛错（无时间戳后缀）', () => {
    expect(buildBackupDownloadName({ name: '坏时间备份', createdAt: 'not-a-date' })).toBe(
      '坏时间备份.tar.gz',
    )
  })
})
