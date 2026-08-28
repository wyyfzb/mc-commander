/**
 * API 客户端（设计文档 §5.1 client.ts）
 * fetch 封装：X-API-Key 头、10s 超时、响应信封解析、错误码 → ApiError
 * 连接配置来自 useConnectionStore（onboarding/M6 配置，默认同源 dev proxy）
 */
import type { ApiEnvelope, ApiErrorEnvelope } from './types'

export class ApiError extends Error {
  readonly code: number
  readonly httpStatus: number
  readonly details: unknown

  constructor(code: number, httpStatus: number, message: string, details: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
  }
}

export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NetworkError'
  }
}

export interface ConnectionConfig {
  /** 面板地址（空串 = 同源，dev 走 Vite proxy /api） */
  baseUrl: string
  apiKey: string
}

const REQUEST_TIMEOUT_MS = 10_000

interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  signal?: AbortSignal
  /** 超时覆盖（默认 10s；部署等长请求需放大，如 10 分钟） */
  timeoutMs?: number
}

function buildUrl(config: ConnectionConfig, path: string): string {
  const base = config.baseUrl.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${p}`
}

async function parseEnvelope<T>(res: Response): Promise<T> {
  let payload: ApiEnvelope<T> | ApiErrorEnvelope
  try {
    payload = (await res.json()) as ApiEnvelope<T> | ApiErrorEnvelope
  } catch {
    throw new NetworkError(`响应解析失败（HTTP ${res.status}）`)
  }

  if (payload.status === 'ok') {
    return (payload as ApiEnvelope<T>).data
  }

  const err = payload as ApiErrorEnvelope
  throw new ApiError(err.code, res.status, err.message, err.details)
}

/**
 * 核心请求函数：解析统一信封，失败抛 ApiError（携带错误码）或 NetworkError
 */
export async function apiRequest<T>(
  path: string,
  config: ConnectionConfig,
  options: ApiRequestOptions = {},
): Promise<T> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(buildUrl(config, path), {
      method: options.method ?? 'GET',
      headers: {
        'X-API-Key': config.apiKey,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal ?? timeout.signal,
    })

    if (!res.ok && res.status >= 400) {
      // 尽量解析错误信封拿错误码；解析失败退回 HTTP 状态
      try {
        const errPayload = (await res.json()) as ApiErrorEnvelope
        if (errPayload.status === 'error') {
          throw new ApiError(errPayload.code, res.status, errPayload.message, errPayload.details)
        }
      } catch (e) {
        if (e instanceof ApiError) throw e
      }
      throw new NetworkError(`请求失败（HTTP ${res.status}）`)
    }

    return parseEnvelope<T>(res)
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new NetworkError('请求超时，请检查服务器连接')
    }
    if (e instanceof TypeError) {
      throw new NetworkError('网络连接失败，请检查面板地址与服务器状态', { cause: e })
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** GET 便捷方法（解包信封，仅返回 data） */
export function apiGet<T>(path: string, config: ConnectionConfig, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(path, config, { method: 'GET', signal })
}

/** GET 信封级变体：返回完整信封（含 pagination），供分页控件消费 */
export async function apiGetEnvelope<T>(path: string, config: ConnectionConfig, signal?: AbortSignal): Promise<ApiEnvelope<T>> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(buildUrl(config, path), {
      method: 'GET',
      headers: { 'X-API-Key': config.apiKey },
      signal: signal ?? timeout.signal,
    })

    if (!res.ok && res.status >= 400) {
      try {
        const errPayload = (await res.json()) as ApiErrorEnvelope
        if (errPayload.status === 'error') {
          throw new ApiError(errPayload.code, res.status, errPayload.message, errPayload.details)
        }
      } catch (e) {
        if (e instanceof ApiError) throw e
      }
      throw new NetworkError(`请求失败（HTTP ${res.status}`)
    }

    let payload: ApiEnvelope<T> | ApiErrorEnvelope
    try {
      payload = (await res.json()) as ApiEnvelope<T> | ApiErrorEnvelope
    } catch {
      throw new NetworkError(`响应解析失败（HTTP ${res.status}）`)
    }

    if (payload.status === 'ok') {
      return payload as ApiEnvelope<T>
    }

    const err = payload as ApiErrorEnvelope
    throw new ApiError(err.code, res.status, err.message, err.details)
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new NetworkError('请求超时，请检查服务器连接')
    }
    if (e instanceof TypeError) {
      throw new NetworkError('网络连接失败，请检查面板地址与服务器状态', { cause: e })
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** POST 便捷方法 */
export function apiPost<T>(
  path: string,
  config: ConnectionConfig,
  body?: unknown,
  options?: { timeoutMs?: number },
): Promise<T> {
  return apiRequest<T>(path, config, { method: 'POST', body, ...options })
}

/** PUT 便捷方法 */
export function apiPut<T>(path: string, config: ConnectionConfig, body?: unknown): Promise<T> {
  return apiRequest<T>(path, config, { method: 'PUT', body })
}

/** DELETE 便捷方法 */
export function apiDelete<T>(path: string, config: ConnectionConfig): Promise<T> {
  return apiRequest<T>(path, config, { method: 'DELETE' })
}
