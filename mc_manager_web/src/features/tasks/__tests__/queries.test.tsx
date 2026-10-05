/**
 * tasks 域 TanStack Query hooks 行为级测试（issue 476：数据访问层零防护收口）
 * 真链路取向：msw 拦截真实请求（不 mock api 层），mutation 失效联动经 msw 命中计数验证，
 * 错误传播断言 error state 携带 ApiError（请求失败）与 mutationFn 前置校验（未选择实例）两类
 * 数据均为虚构测试值，不含真实服务器信息
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import {
  useCreateTask,
  useDeleteTask,
  useRunTaskNow,
  useTaskHistory,
  useTasks,
  useUpdateTask,
} from '../queries'
import { useConnectionStore } from '@/stores/connection'
import { ApiError } from '@/api/client'
import type { ScheduledTask, TaskRunHistory } from '@/api/types'

const taskA: ScheduledTask = {
  id: 7,
  instanceId: 'inst1',
  name: '每日重启',
  type: 'restart',
  cronExpression: '0 4 * * *',
  command: null,
  isEnabled: true,
  lastRunAt: null,
  lastRunStatus: 'never',
  lastRunError: null,
  nextRunAt: '2026-01-01T04:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const createdTask: ScheduledTask = { ...taskA, id: 8, name: '每日备份', type: 'backup' }

const mockHistory: TaskRunHistory[] = [
  {
    id: 1,
    taskId: 7,
    runAt: '2026-01-01T04:00:00Z',
    status: 'success',
    error: null,
    durationMs: 3200,
  },
]

let listHits = 0
let createHits = 0
let updateHits = 0
let deleteHits = 0
let runHits = 0
let historyHits = 0

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

function err(code: number, message: string, httpStatus: number) {
  return HttpResponse.json(
    { status: 'error', code, message, details: null, timestamp: '' },
    { status: httpStatus },
  )
}

const server = setupServer(
  http.get('*/api/v1/instances/inst1/tasks', () => {
    listHits++
    return ok([taskA])
  }),
  http.post('*/api/v1/instances/inst1/tasks', () => {
    createHits++
    return ok(createdTask)
  }),
  http.put('*/api/v1/tasks/7', () => {
    updateHits++
    return ok({ ...taskA, isEnabled: false })
  }),
  http.delete('*/api/v1/tasks/7', () => {
    deleteHits++
    return ok(null)
  }),
  http.post('*/api/v1/tasks/7/run', () => {
    runHits++
    return ok(null)
  }),
  http.get('*/api/v1/tasks/7/history', () => {
    historyHits++
    return ok(mockHistory)
  }),
  // 错误传播专用（正常用例不可见，仅错误用例命中）
  http.get('*/api/v1/instances/inst-err/tasks', () => err(50000, 'internal error', 500)),
  http.post('*/api/v1/instances/inst-err/tasks', () => err(40022, 'invalid cron', 400)),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    qc,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  }
}

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  listHits = createHits = updateHits = deleteHits = runHits = historyHits = 0
})

describe('useTasks', () => {
  it('连接就绪：拉取列表并解包 data', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useTasks('inst1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
    expect(result.current.data?.[0]).toMatchObject({ id: 7, name: '每日重启' })
    expect(listHits).toBe(1)
  })

  it('enabled 门控：连接未就绪不发请求（idle pending）', async () => {
    useConnectionStore.setState({ apiKey: '', status: 'unconfigured' })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useTasks('inst1'), { wrapper })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.fetchStatus).toBe('idle')
    expect(listHits).toBe(0)
  })

  it('enabled 门控：instanceId=null 不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useTasks(null), { wrapper })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.fetchStatus).toBe('idle')
    expect(listHits).toBe(0)
  })

  it('查询失败：error state 携带 ApiError（错误码真实传播）', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useTasks('inst-err'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).code).toBe(50000)
  })
})

describe('useCreateTask', () => {
  it('创建成功：返回结果并失效列表（列表 refetch 经命中计数验证）', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useTasks('inst1'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits).toBe(1)

    const { result } = renderHook(() => useCreateTask('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate({ name: '每日备份', type: 'backup', cronExpression: '0 5 * * *' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({ id: 8, name: '每日备份' })
    // onSuccess invalidateQueries → 活跃 observer 列表 refetch（msw 返回固定列表，仅验证 refetch 发生）
    await waitFor(() => expect(listHits).toBe(2))
    expect(list.result.current.data?.some((t) => t.id === 8)).toBe(false)
  })

  it('instanceId=null：mutate 前置拒绝「未选择实例」，不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateTask(null), { wrapper })
    await act(async () => {
      result.current.mutate({ name: '每日备份', type: 'backup', cronExpression: '0 5 * * *' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).not.toBeInstanceOf(ApiError)
    expect((result.current.error as Error).message).toBe('未选择实例')
    expect(createHits).toBe(0)
  })

  it('请求失败：mutation error 携带 ApiError，不触发列表失效', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useTasks('inst1'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits).toBe(1)

    const { result } = renderHook(() => useCreateTask('inst-err'), { wrapper })
    await act(async () => {
      result.current.mutate({ name: '每日备份', type: 'backup', cronExpression: '0 5 * * *' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).code).toBe(40022)
    await act(async () => {
      await Promise.resolve()
    })
    expect(listHits).toBe(1)
  })
})

describe('useUpdateTask', () => {
  it('更新成功：返回合并结果并失效列表', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useTasks('inst1'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits).toBe(1)

    const { result } = renderHook(() => useUpdateTask('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate({ taskId: 7, payload: { isEnabled: false } })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({ id: 7, isEnabled: false })
    expect(updateHits).toBe(1)
    await waitFor(() => expect(listHits).toBe(2))
  })
})

describe('useDeleteTask', () => {
  it('删除成功：data=null 并失效列表', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useTasks('inst1'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits).toBe(1)

    const { result } = renderHook(() => useDeleteTask('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate(7)
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
    expect(deleteHits).toBe(1)
    await waitFor(() => expect(listHits).toBe(2))
  })
})

describe('useRunTaskNow', () => {
  it('立即执行成功：data=null 并失效列表（lastRunAt 轮询前即时反映）', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useTasks('inst1'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits).toBe(1)

    const { result } = renderHook(() => useRunTaskNow('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate(7)
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
    expect(runHits).toBe(1)
    await waitFor(() => expect(listHits).toBe(2))
  })
})

describe('useTaskHistory', () => {
  it('taskId=null（新建模式）：不查询', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useTaskHistory(null), { wrapper })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.fetchStatus).toBe('idle')
    expect(historyHits).toBe(0)
  })

  it('taskId 给定：拉取执行历史（倒序时间线解包）', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useTaskHistory(7), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
    expect(result.current.data?.[0]).toMatchObject({ taskId: 7, status: 'success' })
    expect(historyHits).toBe(1)
  })
})
