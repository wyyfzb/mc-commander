/**
 * 文件域 API 函数（对照服务端 routes/files.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/players.ts 同模式）。
 * path 均为相对实例根目录的路径（"server.properties" 或 "/world/dat"）。
 */
import {
  apiDelete,
  apiDownloadFile as downloadViaClient,
  apiGet,
  apiPost,
  apiPut,
  apiUploadFile as uploadFileViaClient,
  type ConnectionConfig,
} from './client'
import type {
  FileContentResponse,
  FileInfoResponse,
  FileListResponse,
  FileSaveResponse,
} from './types'

const base = (instanceId: string) => `/api/v1/instances/${instanceId}`

/** 上传体积上限（与服务端 multer 校验一致：50MB）；UI 层在选择文件阶段即用此值前置拦截 */
export const UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024

/** 字节数转人类可读体积（MB 保留 0 位；与 50MB 上限标注共用） */
export function formatUploadLimit(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`
}

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
  return apiPost<{ path: string; name: string }>(`${base(instanceId)}/files/mkdir`, config, {
    path: dirPath,
  })
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
 * 委托 client.ts 共享实现（XHR 进度 + 双通道凭据 + withTransformPort 网关适配）。
 * 体积上限 50MB（服务端 multer 校验）；同名覆盖由服务端保证（MC 用户常上传覆盖配置）。
 * 可选 onProgress（0-100）与 signal（用户取消）。
 */
export function apiUploadFile(
  config: ConnectionConfig,
  instanceId: string,
  file: File,
  opts?: { onProgress?: (pct: number) => void; signal?: AbortSignal; targetDir?: string },
): Promise<{ path: string; name: string; size: number; modifiedAt: string; isDirectory: boolean }> {
  const query = opts?.targetDir ? `targetDir=${encodeURIComponent(opts.targetDir)}` : undefined
  return uploadFileViaClient(`${base(instanceId)}/files/upload`, config, file, {
    fieldName: 'file',
    query,
    onProgress: opts?.onProgress,
    signal: opts?.signal,
  })
}

/**
 * 下载文件到本地（GET /instances/:id/files/download?path=，feat-9）。
 * 委托 client.ts 共享实现（流式进度 + 双通道凭据 + withTransformPort 网关适配）；
 * 取到 blob 后在浏览器侧触发保存（a[download] + ObjectURL，用后即 revoke）。
 * 文件名优先服务端 Content-Disposition（RFC 5987 中文安全），回退 entry.name。
 * 仅单文件：目录下载不支持（服务端 400），由调用方在 UI 层隐藏目录下载入口。
 */
export async function apiDownloadFile(
  config: ConnectionConfig,
  instanceId: string,
  entry: { path: string; name: string },
  opts?: { onProgress?: (pct: number) => void; signal?: AbortSignal },
): Promise<{ fileName: string }> {
  const url = `${base(instanceId)}/files/download?path=${encodeURIComponent(entry.path)}`
  const { blob, fileName } = await downloadViaClient(url, config, {
    onProgress: opts?.onProgress,
    signal: opts?.signal,
  })

  const objectUrl = URL.createObjectURL(blob)
  // a[download] 需挂在 DOM 中触发（Firefox）；点击后同步 revoke 释放内存
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName ?? entry.name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)

  return { fileName: anchor.download }
}
