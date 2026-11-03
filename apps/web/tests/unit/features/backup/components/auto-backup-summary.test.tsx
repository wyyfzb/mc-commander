/**
 * AutoBackupSummary —— 备份页顶部「自动备份」摘要条
 *
 * 核心防线是**四态互相可区分**，尤其「读取失败」不能显示成「没设置」：
 * 后者是肯定式的假话（我们并不知道有没有），用户会据此去建第二条 cron 任务。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { AutoBackupSummary } from '@/features/backup/components/auto-backup-summary'
import { useConnectionStore } from '@/stores/connection'
import type { ScheduledTask } from '@/api/types'

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function task(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 1,
    instanceId: 'inst-1',
    name: '每日备份',
    type: 'backup',
    cronExpression: '0 0 * * *',
    command: null,
    isEnabled: true,
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunError: null,
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

let tasksStatus = 200
let tasksBody: ScheduledTask[] = []

const server = setupServer(
  http.get('*/api/v1/instances/inst-1/tasks', () => {
    if (tasksStatus !== 200) {
      return HttpResponse.json(
        { status: 'error', code: 50300, message: 'boom', details: null, timestamp: '' },
        { status: tasksStatus },
      )
    }
    return ok(tasksBody)
  }),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())
beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  tasksStatus = 200
  tasksBody = []
})

function renderSummary() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AutoBackupSummary instanceId="inst-1" />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('AutoBackupSummary 四态', () => {
  it('未配置（列表里没有 backup 任务）⇒ 说「还没设置」并给出口', async () => {
    tasksBody = [task({ id: 9, type: 'restart', name: '每日重启' })]
    renderSummary()
    expect(await screen.findByText('还没设置自动备份')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /去调整/ })).toHaveAttribute('href', '/tasks')
  })

  /* 这条是摘要条存在的理由：把「读不到」写成「没设置」是肯定式的假话，
     用户会据此去建第二条 cron 任务，然后两条互相淘汰历史快照。 */
  it('读取失败 ⇒ 说「读不到，无法确认」，绝不说「还没设置」', async () => {
    tasksStatus = 500
    renderSummary()
    expect(await screen.findByText(/自动备份状态读取失败/)).toBeInTheDocument()
    expect(screen.queryByText('还没设置自动备份')).not.toBeInTheDocument()
    // 失败态不能给「去调整」——那会把用户引去改一个我们并不知道存不存在的配置
    expect(screen.queryByRole('link', { name: /去调整/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('有启用任务 ⇒ 显示 cron 与任务名', async () => {
    tasksBody = [task({})]
    renderSummary()
    expect(await screen.findByText(/自动备份：/)).toBeInTheDocument()
    expect(screen.getByText('0 0 * * *')).toBeInTheDocument()
    expect(screen.getByText(/每日备份/)).toBeInTheDocument()
  })

  it('多条启用 ⇒ 如实说「还有 N 条」而不是只显示第一条（重复任务本身是故障信号）', async () => {
    tasksBody = [
      task({ id: 1, name: '每日备份' }),
      task({ id: 2, name: '夜间备份' }),
      task({ id: 3, name: '临时备份' }),
    ]
    renderSummary()
    expect(await screen.findByText(/自动备份：/)).toBeInTheDocument()
    expect(screen.getByText(/还有 1 条/)).toBeInTheDocument()
    expect(screen.getByText('3 条启用中')).toBeInTheDocument()
  })

  it('全部停用 ⇒ 说「已关闭」而不是「没配置」', async () => {
    tasksBody = [task({ id: 1, isEnabled: false })]
    renderSummary()
    expect(await screen.findByText(/自动备份已关闭/)).toBeInTheDocument()
    expect(screen.queryByText('还没设置自动备份')).not.toBeInTheDocument()
  })
})
