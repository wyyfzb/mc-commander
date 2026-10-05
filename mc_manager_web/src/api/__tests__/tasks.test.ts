/**
 * tasks API 函数行为级测试（issue 476：tasks/world 数据访问层零防护收口）
 * msw 局部拦截真链路：路径/查询串/请求体透传断言 + 解包契约；
 * 错误传播三向覆盖：非 2xx 错误信封 → ApiError / 200 异常载荷（error 信封与非 JSON）→ NetworkError/ApiError / 网络层失败 → NetworkError
 * 数据均为虚构测试值，不含真实服务器信息
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import {
  apiCreateTask,
  apiDeleteTask,
  apiGetTaskHistory,
  apiGetTasks,
  apiRunTaskNow,
  apiUpdateTask,
} from '../tasks'
import { ApiError, NetworkError, type ConnectionConfig } from '../client'
import type { ScheduledTask, TaskRunHistory } from '../types'

const mockTask: ScheduledTask = {
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

const createdTask: ScheduledTask = { ...mockTask, id: 8, name: '每日备份', type: 'backup' }

const mockHistory: TaskRunHistory[] = [
  {
    id: 1,
    taskId: 7,
    runAt: '2026-01-01T04:00:00Z',
    status: 'success',
    error: null,
    durationMs: 3200,
  },
  {
    id: 2,
    taskId: 7,
    runAt: '2025-12-31T04:00:00Z',
    status: 'failed',
    error: 'restart timed out',
    durationMs: 60000,
  },
]

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

let lastListUrl = ''
let lastCreateBody: unknown

const server = setupServer(
  http.get('*/api/v1/instances/inst1/tasks', ({ request }) => {
    lastListUrl = request.url
    return ok([mockTask])
  }),
  http.post('*/api/v1/instances/inst1/tasks', async ({ request }) => {
    lastCreateBody = await request.json()
    return ok(createdTask)
  }),
  http.put('*/api/v1/tasks/7', async ({ request }) => {
    const body = (await request.json()) as { isEnabled?: boolean }
    return ok({ ...mockTask, isEnabled: body.isEnabled ?? mockTask.isEnabled })
  }),
  http.delete('*/api/v1/tasks/7', () => ok(null)),
  http.post('*/api/v1/tasks/7/run', () => ok(null)),
  http.get('*/api/v1/tasks/7/history', () => ok(mockHistory)),
  // 错误传播专用实例/任务（正常用例不可见，仅错误用例命中）
  http.get('*/api/v1/instances/inst-err/tasks', () => err(40402, 'instance not found', 404)),
  http.post('*/api/v1/tasks/999/run', () =>
    HttpResponse.json(
      { status: 'error', code: 50000, message: 'scheduler offline', details: null, timestamp: '' },
      { status: 200 },
    ),
  ),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterAll(() => server.close())

const config: ConnectionConfig = { baseUrl: 'http://localhost:25566', apiKey: 'test-key' }

describe('tasks API', () => {
  it('GET 列表：pageSize=100 全量拉取约定 + 数组解包', async () => {
    const res = await apiGetTasks(config, 'inst1')
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ id: 7, type: 'restart', lastRunStatus: 'never' })
    const url = new URL(lastListUrl)
    expect(url.pathname).toBe('/api/v1/instances/inst1/tasks')
    expect(url.searchParams.get('page')).toBe('1')
    expect(url.searchParams.get('pageSize')).toBe('100')
  })

  it('POST 创建：payload 透传请求体，返回创建结果', async () => {
    const payload = { name: '每日备份', type: 'backup' as const, cronExpression: '0 5 * * *' }
    const res = await apiCreateTask(config, 'inst1', payload)
    expect(res).toMatchObject({ id: 8, name: '每日备份', type: 'backup' })
    expect(lastCreateBody).toEqual(payload)
  })

  it('PUT 更新：局部 payload 打到 /tasks/:id，返回合并结果', async () => {
    const res = await apiUpdateTask(config, 7, { isEnabled: false })
    expect(res.isEnabled).toBe(false)
    expect(res.id).toBe(7)
  })

  it('DELETE 删除：data=null 解包', async () => {
    const res = await apiDeleteTask(config, 7)
    expect(res).toBeNull()
  })

  it('POST 立即执行：/tasks/:id/run，data=null 解包', async () => {
    const res = await apiRunTaskNow(config, 7)
    expect(res).toBeNull()
  })

  it('GET 执行历史：limit=10 倒序约定 + 数组解包', async () => {
    const res = await apiGetTaskHistory(config, 7)
    expect(res).toHaveLength(2)
    expect(res[0]).toMatchObject({ status: 'success', durationMs: 3200 })
    expect(res[1]).toMatchObject({ status: 'failed', error: 'restart timed out' })
  })

  it('非 2xx 错误信封：ApiError 携带错误码与 HTTP 状态传播', async () => {
    await expect(apiGetTasks(config, 'inst-err')).rejects.toMatchObject({
      name: 'ApiError',
      code: 40402,
      httpStatus: 404,
    })
  })

  it('200 异常载荷（error 信封）：ApiError 传播（信封级错误不受 HTTP 200 误导）', async () => {
    await expect(apiRunTaskNow(config, 999)).rejects.toMatchObject({
      name: 'ApiError',
      code: 50000,
    })
  })

  it('200 非 JSON 载荷：NetworkError（响应解析失败）', async () => {
    server.use(
      http.get('*/api/v1/tasks/7/history', () => HttpResponse.text('<html>gateway</html>')),
    )
    await expect(apiGetTaskHistory(config, 7)).rejects.toMatchObject({
      name: 'NetworkError',
      message: expect.stringContaining('响应解析失败'),
    })
  })

  it('网络层失败：NetworkError（fetch TypeError 归一）', async () => {
    server.use(http.get('*/api/v1/instances/inst1/tasks', () => HttpResponse.error()))
    await expect(apiGetTasks(config, 'inst1')).rejects.toBeInstanceOf(NetworkError)
    await expect(apiGetTasks(config, 'inst1')).rejects.toMatchObject({
      message: '网络连接失败，请检查面板地址与服务器状态',
    })
  })

  it('错误类型边界：ApiError 不是 NetworkError（页面按类型分流 toast 依赖此语义）', async () => {
    await expect(apiGetTasks(config, 'inst-err')).rejects.toBeInstanceOf(ApiError)
    await expect(apiGetTasks(config, 'inst-err')).rejects.not.toBeInstanceOf(NetworkError)
  })
})
