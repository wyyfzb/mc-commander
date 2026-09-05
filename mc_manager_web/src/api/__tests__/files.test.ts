/**
 * files API 函数行为级测试（issue 495：api 层三文件覆盖率洼地收口）
 * msw 局部拦截真链路：路径/查询串/请求体契约断言 + 解包契约 + 下载浏览器侧保存流程；
 * 错误传播：非 2xx 错误信封 → ApiError
 * 数据均为虚构测试值，不含真实服务器/文件信息
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import {
  apiCreateDirectory,
  apiDeleteFile,
  apiDownloadFile,
  apiGetFileContent,
  apiListFiles,
  apiRenameFile,
  apiSaveFileContent,
  UPLOAD_MAX_FILE_BYTES,
  formatUploadLimit,
} from '../files'
import { ApiError, type ConnectionConfig } from '../client'
import type {
  FileContentResponse,
  FileInfoResponse,
  FileListResponse,
  FileSaveResponse,
} from '../types'

const mockDirList: FileListResponse = {
  path: '/config',
  isDirectory: true,
  files: [
    { name: 'server.properties', path: '/config/server.properties', type: 'file', size: 1024, modifiedAt: '2026-01-01T00:00:00Z', isDirectory: false },
    { name: 'plugins', path: '/config/plugins', type: 'directory', size: 0, modifiedAt: '2026-01-01T00:00:00Z', isDirectory: true },
  ],
}

const mockFileInfo: FileInfoResponse = {
  name: 'server.properties',
  path: '/config/server.properties',
  type: 'file',
  size: 1024,
  modifiedAt: '2026-01-01T00:00:00Z',
  isDirectory: false,
}

const mockContent: FileContentResponse = {
  path: '/config/server.properties',
  name: 'server.properties',
  size: 1024,
  content: 'gamemode=survival\nmax-players=20',
  encoding: 'utf-8',
  modifiedAt: '2026-01-01T00:00:00Z',
}

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok', code: 0, message: 'Success', data,
    timestamp: new Date().toISOString(),
  })
}

let lastBody: unknown

const server = setupServer(
  http.get('*/api/v1/instances/inst1/files', ({ request }) => {
    const path = new URL(request.url).searchParams.get('path')
    if (path === '/config/server.properties') return ok(mockFileInfo)
    return ok(mockDirList)
  }),
  http.get('*/api/v1/instances/inst1/files/content', ({ request }) => {
    const path = new URL(request.url).searchParams.get('path')
    if (path === '/config/server.properties') return ok(mockContent)
    return err404()
  }),
  http.put('*/api/v1/instances/inst1/files/content', async ({ request }) => {
    lastBody = await request.json()
    return ok({ path: (lastBody as { path: string }).path, size: 1024, modifiedAt: '2026-01-02T00:00:00Z' } satisfies FileSaveResponse)
  }),
  http.delete('*/api/v1/instances/inst1/files', ({ request }) => {
    lastBody = new URL(request.url).searchParams.get('path')
    return ok(null)
  }),
  http.post('*/api/v1/instances/inst1/files/mkdir', async ({ request }) => {
    lastBody = await request.json()
    return ok({ path: '/world/backup', name: 'backup' })
  }),
  http.post('*/api/v1/instances/inst1/files/rename', async ({ request }) => {
    lastBody = await request.json()
    return ok({ oldPath: '/a.txt', newPath: '/b.txt', name: 'b.txt' })
  }),
  http.get('*/api/v1/instances/inst1/files/download', () =>
    HttpResponse.text('file-bytes-here', {
      headers: { 'Content-Disposition': `attachment; filename*=UTF-8''%E6%9C%8D%E5%8A%A1%E5%99%A8.zip` },
    }),
  ),
  // 错误传播专用实例（正常用例不可见，仅错误用例命中）
  http.get('*/api/v1/instances/inst-err/files', () =>
    HttpResponse.json(
      { status: 'error', code: 40402, message: 'instance not found', details: null, timestamp: '' },
      { status: 404 },
    ),
  ),
)

function err404() {
  return HttpResponse.json(
    { status: 'error', code: 40401, message: 'file not found', details: null, timestamp: '' },
    { status: 404 },
  )
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

afterEach(() => {
  vi.restoreAllMocks()
})

const config: ConnectionConfig = { baseUrl: 'http://localhost:25566', apiKey: 'test-key' }

describe('files API · 目录与文件读取', () => {
  it('apiListFiles：path 查询串 encodeURIComponent + 目录形态解包（files 数组）', async () => {
    const res = await apiListFiles(config, 'inst1', '/config')
    expect(res).toMatchObject({ path: '/config', isDirectory: true })
    expect((res as FileListResponse).files).toHaveLength(2)
  })

  it('apiListFiles：文件路径返回单文件信息形态（非 files 数组）', async () => {
    const res = await apiListFiles(config, 'inst1', '/config/server.properties')
    expect((res as FileInfoResponse).type).toBe('file')
    expect((res as FileInfoResponse).size).toBe(1024)
  })

  it('apiListFiles：特殊字符路径正确编码（空格/斜杠透传语义保留）', async () => {
    const captured: { url: string | null } = { url: null }
    server.events.on('request:start', ({ request }) => {
      captured.url = request.url
    })
    await apiListFiles(config, 'inst1', '/my world/data')
    expect(captured.url).toContain('path=%2Fmy%20world%2Fdata')
  })

  it('apiGetFileContent：内容与编码解包', async () => {
    const res = await apiGetFileContent(config, 'inst1', '/config/server.properties')
    expect(res).toEqual(mockContent)
    expect(res.encoding).toBe('utf-8')
  })
})

describe('files API · 写入与结构操作', () => {
  it('apiSaveFileContent：PUT body {path, content} 透传，保存结果解包', async () => {
    const res = await apiSaveFileContent(config, 'inst1', '/config/server.properties', 'max-players=30')
    expect(res).toMatchObject({ path: '/config/server.properties', size: 1024 })
    expect(lastBody).toEqual({ path: '/config/server.properties', content: 'max-players=30' })
  })

  it('apiDeleteFile：DELETE 查询串携带 path', async () => {
    const res = await apiDeleteFile(config, 'inst1', '/world/old.dat_old')
    expect(res).toBeNull()
    expect(lastBody).toBe('/world/old.dat_old')
  })

  it('apiCreateDirectory：mkdir body {path} 透传', async () => {
    const res = await apiCreateDirectory(config, 'inst1', '/world/backup')
    expect(res).toMatchObject({ path: '/world/backup', name: 'backup' })
    expect(lastBody).toEqual({ path: '/world/backup' })
  })

  it('apiRenameFile：rename body {path, newPath} 透传', async () => {
    const res = await apiRenameFile(config, 'inst1', '/a.txt', '/b.txt')
    expect(res).toMatchObject({ oldPath: '/a.txt', newPath: '/b.txt' })
    expect(lastBody).toEqual({ path: '/a.txt', newPath: '/b.txt' })
  })
})

describe('files API · 下载浏览器侧保存流程', () => {
  it('apiDownloadFile：Content-Disposition 文件名优先 + a[download] 触发 + ObjectURL 用后即回收', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-object-url')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const { fileName } = await apiDownloadFile(config, 'inst1', { path: '/world/world.zip', name: 'world.zip' })

    // 服务端 RFC 5987 文件名（UTF-8''%E6%9C%8D... = 服务器.zip）优先于 entry.name
    expect(fileName).toBe('服务器.zip')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-object-url')
  })

  it('apiDownloadFile：无 Content-Disposition 时回退 entry.name（msw 局部覆盖）', async () => {
    server.use(
      http.get('*/api/v1/instances/inst1/files/download', () => HttpResponse.text('bytes')),
    )
    const createObjectURL = vi.fn(() => 'blob:mock')
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const { fileName } = await apiDownloadFile(config, 'inst1', { path: '/world/world.zip', name: 'fallback.zip' })
    expect(fileName).toBe('fallback.zip')
  })
})

describe('files API · 常量与错误传播', () => {
  it('UPLOAD_MAX_FILE_BYTES = 50MB（与服务端 multer 一致）+ formatUploadLimit 人类可读', () => {
    expect(UPLOAD_MAX_FILE_BYTES).toBe(50 * 1024 * 1024)
    expect(formatUploadLimit(UPLOAD_MAX_FILE_BYTES)).toBe('50MB')
    expect(formatUploadLimit(9 * 1024 * 1024 + 500 * 1024)).toBe('9MB') // 四舍五入
  })

  it('非 2xx 错误信封：ApiError 携带错误码与 HTTP 状态传播', async () => {
    await expect(apiListFiles(config, 'inst-err', '/config')).rejects.toMatchObject({
      name: 'ApiError',
      code: 40402,
      httpStatus: 404,
    })
  })

  it('读取不存在文件：404 → ApiError 40401', async () => {
    await expect(apiGetFileContent(config, 'inst1', '/ghost.txt')).rejects.toBeInstanceOf(ApiError)
    await expect(apiGetFileContent(config, 'inst1', '/ghost.txt')).rejects.toMatchObject({ code: 40401 })
  })
})
