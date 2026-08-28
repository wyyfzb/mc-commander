/**
 * 文件域 API 函数（对照服务端 routes/files.js 契约）
 * config 由调用方从 useConnectionStore 传入（与 src/api/players.ts 同模式）。
 * path 均为相对实例根目录的路径（"server.properties" 或 "/world/dat"）。
 */
import { apiDelete, apiGet, apiPost, apiPut, type ConnectionConfig } from './client'
import type {
  FileContentResponse,
  FileInfoResponse,
  FileListResponse,
  FileSaveResponse,
} from './types'

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
