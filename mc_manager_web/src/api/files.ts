/**
 * 文件域 API 函数（对照服务端 routes/files.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/players.ts 同模式）。
 * path 均为相对实例根目录的路径（"server.properties" 或 "/world/dat"）。
 */
import {
  ApiError,
  NetworkError,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  type ConnectionConfig,
} from './client'
import type {
  ApiEnvelope,
  ApiErrorEnvelope,
  FileContentResponse,
  FileInfoResponse,
  FileListResponse,
  FileSaveResponse,
} from './types'

/** 上传响应 data 结构（与服务端 routes/files.js 上传端点契约一致） */
interface UploadResult {
  path: string
  name: string
  size: number
  modifiedAt: string
  isDirectory: boolean
}

const base = (instanceId: string) => `/api/v1/instances/${instanceId}`

/** 列出目录（GET /instances/:id/files?path=；目录返回 files 数组，文件返回单文件信息） */
export function apiListFiles(config: ConnectionConfig, instanceId: string, path: string) {
  return apiGet<FileListResponse | FileInfoResponse>(
    `${base(instanceId)}/files?path=${encodeURIComponent(path)}`,
    config,
  )
}

/** 读取文件内容（GET /instances/:id/files/content?path=；>10MB 或二进制拒绝） */
export function apiGetFileContent(config: ConnectionConfig, instanceId: string, path: string) {
  return apiGet<FileContentResponse>(
    `${base(instanceId)}/files/content?path=${encodeURIComponent(path)}`,
    config,
  )
}

/** 写入文件内容（PUT /instances/:id/files/content；已存在文件按原编码写回，新文件默认 utf-8） */
export function apiSaveFileContent(
  config: ConnectionConfig,
  instanceId: string,
  path: string,
  content: string,
) {
  return apiPut<FileSaveResponse>(`${base(instanceId)}/files/content`, config, { path, content })
}

/** 删除文件/目录（DELETE /instances/:id/files?path=；目录递归删除） */
export function apiDeleteFile(config: ConnectionConfig, instanceId: string, path: string) {
  return apiDelete<null>(`${base(instanceId)}/files?path=${encodeURIComponent(path)}`, config)
}

/** 新建目录（POST /instances/:id/files/mkdir） */
export function apiCreateDirectory(config: ConnectionConfig, instanceId: string, dirPath: string) {
  return apiPost<{ path: string; name: string }>(
    `${base(instanceId)}/files/mkdir`,
    config,
    { path: dirPath },
  )
}

/** 重命名文件/目录（POST /instances/:id/files/rename） */
export function apiRenameFile(
  config: ConnectionConfig,
  instanceId: string,
  oldPath: string,
  newPath: string,
) {
  return apiPost<{ oldPath: string; newPath: string; name: string }>(
    `${base(instanceId)}/files/rename`,
    config,
    { path: oldPath, newPath },
  )
}

/**
 * 上传文件（POST /instances/:id/files/upload，multipart/form-data 字段名 file）。
 * multipart 不能走 apiRequest（其固定 JSON 序列化 body），独立 fetch 实现；
 * 体积上限 50MB（服务端 multer 校验），超时放宽至 120s（大文件上传）。
 * 同名覆盖由服务端保证（MC 用户常上传覆盖配置）。
 */
export async function apiUploadFile(
  config: ConnectionConfig,
  instanceId: string,
  file: File,
  signal?: AbortSignal,
): Promise<{ path: string; name: string; size: number; modifiedAt: string; isDirectory: boolean }> {
  const form = new FormData()
  form.append('file', file, file.name)

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 120_000)

  const url = `${config.baseUrl.replace(/\/+$/, '')}${base(instanceId)}/files/upload`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': config.apiKey },
      body: form,
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
      throw new NetworkError(`请求失败（HTTP ${res.status}）`)
    }

    let payload: ApiEnvelope<UploadResult> | ApiErrorEnvelope
    try {
      payload = (await res.json()) as ApiEnvelope<UploadResult> | ApiErrorEnvelope
    } catch {
      throw new NetworkError(`响应解析失败（HTTP ${res.status}）`)
    }
    if (payload.status === 'ok') return (payload as ApiEnvelope<UploadResult>).data
    const err = payload as ApiErrorEnvelope
    throw new ApiError(err.code, res.status, err.message, err.details)
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new NetworkError('上传超时，请检查网络或减小文件体积')
    }
    if (e instanceof TypeError) {
      throw new NetworkError('网络连接失败，请检查面板地址与服务器状态', { cause: e })
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}
