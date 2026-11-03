/**
 * ArchivedSnapshotsCard 测试（面板级资产，与当前实例无关）
 * - 无可挂载项：不渲染区块（空态不出入口）
 * - 清点失败：说「读不到」，不静默当作「没有归档」——两者用户会做出相反判断
 * - 有可挂载项：来源/可挂载份数/最近时间；生命周期说明收进信息入口
 * - 挂载：二次确认 → 提交 → 成功/失败/全跳过三种结局各自如实
 * - **无实例**：仍要清点（卸载最后一台后这里是唯一入口），只不给挂载按钮并说明原因
 * mock 数据为结构占位（虚构内容），严禁真实服务器信息
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@tests/support/handlers'
import { queryKeys } from '@/api/queries'
import { useConnectionStore } from '@/stores/connection'
import { ArchivedSnapshotsCard } from '@/features/backup/components/archived-snapshots-card'

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  localStorage.clear()
  // 清点端点的 enabled 判据是连接就绪：不置 ready 时 query 根本不发，用例会误判成「没数据」
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
})

function okEnvelope<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function renderCard(instanceId: string | null = 'demo', instanceName = '演示服') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ArchivedSnapshotsCard instanceId={instanceId} instanceName={instanceName} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return qc
}

const archivedGroup = {
  archiveId: 'paper-1a2b3c4d',
  instanceExists: false,
  snapshotCount: 3,
  usableCount: 2,
  latestMtime: '2026-09-01T00:00:00.000Z',
}

describe('ArchivedSnapshotsCard（面板级归档快照）', () => {
  it('无可挂载项：不渲染归档区块（空态不出入口）', async () => {
    server.use(http.get('*/api/v1/backups/archived', () => okEnvelope([])))
    const qc = renderCard()
    await waitFor(() => expect(qc.getQueryData(queryKeys.archivedSnapshots())).toEqual([]))

    expect(screen.queryByText('归档快照（未建立索引）')).not.toBeInTheDocument()
  })

  it('清点接口失败（如 503 索引不可读）：显示一句诚实的错误行，不静默当作「没有归档」', async () => {
    server.use(
      http.get('*/api/v1/backups/archived', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 50303,
            message: '备份索引不可读，请稍后重试',
            details: null,
            timestamp: new Date().toISOString(),
          },
          { status: 503 },
        ),
      ),
    )
    const qc = renderCard()
    // 等查询真的失败（不是首帧的「还没请求」）：错误行只在 query 出错后渲染
    await waitFor(() => expect(qc.getQueryState(queryKeys.archivedSnapshots())?.error).toBeTruthy())

    expect(await screen.findByText(/归档快照清点失败/)).toBeInTheDocument()
    expect(screen.queryByText('归档快照（未建立索引）')).not.toBeInTheDocument()
  })

  it('有可挂载项：展示来源/可挂载份数/最近时间；生命周期说明收进信息入口', async () => {
    const user = userEvent.setup()
    server.use(http.get('*/api/v1/backups/archived', () => okEnvelope([archivedGroup])))
    const qc = renderCard()
    await waitFor(() => expect(qc.getQueryData(queryKeys.archivedSnapshots())).toBeDefined())

    expect(await screen.findByText('归档快照（未建立索引）')).toBeInTheDocument()
    expect(screen.getByText('paper-1a2b3c4d')).toBeInTheDocument()
    expect(screen.getByText(/来自已卸载实例/)).toBeInTheDocument()
    // 计数口径 = 未建立索引的份数中可挂载的那部分（已挂载的不计入）
    expect(screen.getByText(/可挂载 2\/3 份/)).toBeInTheDocument()
    // 机制说明不常驻
    expect(screen.queryByText(/不复制、不移动\s*磁盘内容/)).not.toBeInTheDocument()
    // 点开入口即读到全文：「挂载只建索引」+ 后续生命周期（计入配额、按最旧优先清理、删条目＝删唯一副本）
    await user.click(screen.getByRole('button', { name: '归档快照说明' }))
    const hint = await screen.findByRole('dialog', { name: '归档快照说明' })
    expect(hint).toHaveTextContent('不复制、不移动磁盘内容')
    expect(hint).toHaveTextContent('计入该实例的备份配额')
    expect(hint).toHaveTextContent('按创建时间最旧优先')
    expect(hint).toHaveTextContent('删除条目会连带删除磁盘上的原归档快照')
  })

  it('现存实例的未索引快照：文案据实（不误称「已卸载」）', async () => {
    server.use(
      http.get('*/api/v1/backups/archived', () =>
        okEnvelope([{ ...archivedGroup, instanceExists: true }]),
      ),
    )
    const qc = renderCard()
    await waitFor(() => expect(qc.getQueryData(queryKeys.archivedSnapshots())).toBeDefined())

    expect(await screen.findByText(/现存实例的未索引快照/)).toBeInTheDocument()
    expect(screen.queryByText(/来自已卸载实例/)).not.toBeInTheDocument()
  })

  it('挂载：二次确认后提交，成功 toast 报挂载与跳过份数并刷新归档清点', async () => {
    const user = userEvent.setup()
    let posted: Record<string, unknown> | null = null
    let archivedCalls = 0
    server.use(
      http.get('*/api/v1/backups/archived', () => {
        archivedCalls += 1
        // 第一次返回可挂载项，挂载后（失效重取）返回空 —— 模拟服务端真实收敛
        return okEnvelope(archivedCalls === 1 ? [archivedGroup] : [])
      }),
      http.post('*/api/v1/instances/:id/backups/attach', async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>
        return okEnvelope({ attached: 2, skipped: 1 })
      }),
    )
    renderCard()
    await screen.findByText('归档快照（未建立索引）')

    await user.click(screen.getByRole('button', { name: /挂载到本实例/ }))
    const dialog = await screen.findByRole('dialog')
    // 确认弹窗讲清后果与「不动磁盘」的性质
    expect(dialog).toHaveTextContent('paper-1a2b3c4d')
    expect(dialog).toHaveTextContent('原归档目录不会被复制或移动')
    await user.click(screen.getByRole('button', { name: '挂载' }))

    expect(await screen.findByText(/已挂载 2 份归档快照（跳过 1 份）/)).toBeInTheDocument()
    expect(posted).toEqual({ archiveId: 'paper-1a2b3c4d' })
    // 挂载后失效重取 → 区块消失（已无未索引项）
    await waitFor(() =>
      expect(screen.queryByText('归档快照（未建立索引）')).not.toBeInTheDocument(),
    )
  })

  it('挂载失败（归档已被清理 404）：错误 toast，弹窗保持打开可重试', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/api/v1/backups/archived', () => okEnvelope([archivedGroup])),
      http.post('*/api/v1/instances/:id/backups/attach', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40402,
            message: '归档目录不存在（可能已被清理）',
            details: null,
            timestamp: '',
          },
          { status: 404 },
        ),
      ),
    )
    renderCard()
    await screen.findByText('归档快照（未建立索引）')

    await user.click(screen.getByRole('button', { name: /挂载到本实例/ }))
    await user.click(await screen.findByRole('button', { name: '挂载' }))

    expect(await screen.findByText(/挂载失败/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('全部份数都被跳过（重复挂载）：提示据实，不谎报挂载成功', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/api/v1/backups/archived', () => okEnvelope([archivedGroup])),
      http.post('*/api/v1/instances/:id/backups/attach', () =>
        okEnvelope({ attached: 0, skipped: 3 }),
      ),
    )
    renderCard()
    await screen.findByText('归档快照（未建立索引）')

    await user.click(screen.getByRole('button', { name: /挂载到本实例/ }))
    await user.click(await screen.findByRole('button', { name: '挂载' }))

    expect(await screen.findByText(/没有可挂载的快照/)).toBeInTheDocument()
  })
})

describe('无实例时仍然是唯一入口（卸载最后一台之后）', () => {
  /* 归档快照是面板级资产：清点端点不带实例参数。它若被实例空态一起挡住，
     卸载最后一台实例后「已保留 N 份备份」就成了一句用户无法验证的话 */
  it('instanceId=null 仍然清点并列出，只是不给挂载按钮并说明原因', async () => {
    server.use(http.get('*/api/v1/backups/archived', () => okEnvelope([archivedGroup])))
    renderCard(null, '')

    expect(await screen.findByText('归档快照（未建立索引）')).toBeInTheDocument()
    expect(screen.getByText('paper-1a2b3c4d')).toBeInTheDocument()
    // 挂载要登记到某台实例名下——没有实例时不能给一个点了必然失败的按钮
    expect(screen.queryByRole('button', { name: /挂载到本实例/ })).not.toBeInTheDocument()
    expect(screen.getByText(/挂载需要先有一台实例/)).toBeInTheDocument()
  })
})
