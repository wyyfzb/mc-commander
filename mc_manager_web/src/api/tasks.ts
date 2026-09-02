/**
 * 定时任务域 API 函数（对照服务端 routes/tasks.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/players.ts 同模式）。
 * 分页信封仅解包 data（pagination 丢失）——前端拉 pageSize=100 全量。
 */
import { apiDelete, apiGet, apiPost, apiPut, type ConnectionConfig } from './client'
import type { ScheduledTask, TaskCreatePayload, TaskRunHistory, TaskUpdatePayload } from './types'

/** 任务列表（GET /instances/:id/tasks；pageSize=100 拉全量） */
export function apiGetTasks(config: ConnectionConfig, instanceId: string) {
  return apiGet<ScheduledTask[]>(
    `/api/v1/instances/${instanceId}/tasks?page=1&pageSize=100`,
    config,
  )
}

/** 创建任务（POST /instances/:id/tasks） */
export function apiCreateTask(
  config: ConnectionConfig,
  instanceId: string,
  payload: TaskCreatePayload,
) {
  return apiPost<ScheduledTask>(`/api/v1/instances/${instanceId}/tasks`, config, payload)
}

/** 更新任务（PUT /tasks/:id；局部更新） */
export function apiUpdateTask(config: ConnectionConfig, taskId: number, payload: TaskUpdatePayload) {
  return apiPut<ScheduledTask>(`/api/v1/tasks/${taskId}`, config, payload)
}

/** 删除任务（DELETE /tasks/:id） */
export function apiDeleteTask(config: ConnectionConfig, taskId: number) {
  return apiDelete<null>(`/api/v1/tasks/${taskId}`, config)
}

/** 立即执行任务（POST /tasks/:id/run） */
export function apiRunTaskNow(config: ConnectionConfig, taskId: number) {
  return apiPost<null>(`/api/v1/tasks/${taskId}/run`, config)
}

/** 任务执行历史（GET /tasks/:id/history；倒序最近 10 条，排障时间线） */
export function apiGetTaskHistory(config: ConnectionConfig, taskId: number) {
  return apiGet<TaskRunHistory[]>(`/api/v1/tasks/${taskId}/history?limit=10`, config)
}
