/**
 * API 客户端（设计文档 §5.1 client.ts）
 * fetch 封装：双通道凭据注入、10s 超时、响应信封解析、错误码 → ApiError
 * 凭据优先级（安全主线）：会话 Bearer 令牌 > X-API-Key（自动化/回退通道）；
 * 会话过期（40103）时派发全局事件由路由层跳登录页
 * 连接配置来自 useConnectionStore（onboarding 配置，默认同源 dev proxy）
 */
import type { ApiEnvelope, ApiErrorEnvelope } from './types'
import { getStoredSession, clearSessionAndDispatchExpired } from '@/stores/auth'

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

/** 服务端会话过期错误码（40103 AUTH_SESSION_EXPIRED，触发全局登出） */
const AUTH_SESSION_EXPIRED_CODE = 40103

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

/**
 * 认证头注入（双通道互斥）：
 * - 会话令牌存在 → Authorization: Bearer（浏览器登录主线）
 * - 否则 apiKey 非空 → X-API-Key（自动化 / 高级用户通道，行为兼容）
 * - 两者皆无（公开端点：auth/status|login|setup）→ 不带认证头
 */
function hasSessionToken(): boolean {
  return Boolean(getStoredSession()?.token)
}

function buildAuthHeaders(): Record<string, string> {
  const session = getStoredSession()
  if (session?.token) {
    return { Authorization: `Bearer ${session.token}` }
  }
  return {}
}

/** 会话过期统一处置：清会话 + 派发全局事件（路由层监听跳登录） */
function handleSessionExpired(): void {
  clearSessionAndDispatchExpired()
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
        ...buildAuthHeaders(),
        ...(!hasSessionToken() && config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
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
          if (errPayload.code === AUTH_SESSION_EXPIRED_CODE) handleSessionExpired()
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
      headers: {
        ...buildAuthHeaders(),
        ...(!hasSessionToken() && config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
      },
      signal: signal ?? timeout.signal,
    })

    if (!res.ok && res.status >= 400) {
      try {
        const errPayload = (await res.json()) as ApiErrorEnvelope
        if (errPayload.status === 'error') {
          if (errPayload.code === AUTH_SESSION_EXPIRED_CODE) handleSessionExpired()
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

export interface UploadOptions {
  /** multipart 字段名（默认 'file'） */
  fieldName?: string
  /** 追加到 URL 的查询串（如 'overwrite=true'；勿含 XTransformPort，内部自动处理） */
  query?: string
  /** 上传进度回调（0-100 整数，基于已发送字节） */
  onProgress?: (pct: number) => void
  /** 取消上传（用户主动中止） */
  signal?: AbortSignal
}

/**
 * multipart 文件上传（共享实现，feat-8 插件上传延伸）：
 * - XHR 而非 fetch：fetch 无法观测上传进度（onprogress 仅 fetch stream 读响应侧）
 * - 双通道凭据注入（Bearer 会话优先 / X-API-Key 回退，与 apiRequest 互斥逻辑一致）
 * - withTransformPort 网关适配（此前 files.ts 独立实现遗漏此处理，沙箱下上传必挂）
 * - 超时 10 分钟兜底（大文件慢速网络）；用户取消走 signal
 * - 响应信封解析与错误码语义与 apiRequest 完全一致
 */
export function apiUploadFile<T>(
  path: string,
  config: ConnectionConfig,
  file: File,
  options: UploadOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = buildUrl(config, options.query ? `${path}?${options.query}` : path)
    const form = new FormData()
    form.append(options.fieldName ?? 'file', file, file.name)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.responseType = 'text'

    // 凭据注入（双通道互斥，与 apiRequest 一致）
    const authHeaders = buildAuthHeaders()
    for (const [k, v] of Object.entries(authHeaders)) xhr.setRequestHeader(k, v)
    if (!hasSessionToken() && config.apiKey) {
      xhr.setRequestHeader('X-API-Key', config.apiKey)
    }

    // 10 分钟兜底超时
    xhr.timeout = 600_000

    // 上传进度（xhr.upload 才是请求方向）
    if (options.onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          options.onProgress!(Math.min(100, Math.round((e.loaded / e.total) * 100)))
        }
      })
    }

    // 用户取消
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true })

    xhr.addEventListener('load', () => {
      let payload: ApiEnvelope<T> | ApiErrorEnvelope
      try {
        payload = JSON.parse(xhr.responseText) as ApiEnvelope<T> | ApiErrorEnvelope
      } catch {
        reject(new NetworkError(`响应解析失败（HTTP ${xhr.status}）`))
        return
      }
      if (payload.status === 'ok') {
        resolve((payload as ApiEnvelope<T>).data)
        return
      }
      const err = payload as ApiErrorEnvelope
      if (err.code === AUTH_SESSION_EXPIRED_CODE) handleSessionExpired()
      reject(new ApiError(err.code, xhr.status, err.message, err.details))
    })

    xhr.addEventListener('timeout', () => {
      reject(new NetworkError('上传超时，请检查网络或减小文件体积'))
    })

    xhr.addEventListener('abort', () => {
      reject(new NetworkError('上传已取消'))
    })

    xhr.addEventListener('error', () => {
      reject(new NetworkError('网络连接失败，请检查面板地址与服务器状态'))
    })

    xhr.send(form)
  })
}
