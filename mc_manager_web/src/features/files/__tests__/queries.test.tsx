/**
 * files 域 TanStack Query hooks 行为级测试（issue 507：数据层 hooks 覆盖收口）
 * 真链路取向：msw 拦截真实请求（不 mock api 层），mutation 失效联动经 msw 命中计数验证；
 * 上传走 XMLHttpRequest——沿用仓库 FakeXHR 全局替换范式手动编排响应（与 upload-conflict 同款）
 * parentDirOf 三分支（无斜杠 / 根斜杠 / 嵌套）经失效目录断言覆盖
 * 数据均为虚构测试值，不含真实服务器信息
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import {
  useFileList,
  useFileContent,
  useSaveFile,
  useDeleteFile,
  useCreateDirectory,
  useRenameFile,
  useUploadFile,
} from '../queries'
import { useConnectionStore } from '@/stores/connection'
import { ApiError } from '@/api/client'
import type { FileEntry, FileListResponse, FileContentResponse, FileSaveResponse } from '@/api/types'

const entry: FileEntry = {
  name: 'server.properties',
  path: '/server.properties',
  type: 'file',
  size: 1024,
  modifiedAt: '2026-01-01T00:00:00Z',
  isDirectory: false,
}

const listBody = (dir: string): FileListResponse => ({
  path: dir,
  isDirectory: true,
  files: [entry],
})

const contentBody = (path: string): FileContentResponse => ({
  path,
  name: 'a.txt',
  size: 24,
  content: 'hello-world',
  encoding: 'utf-8',
  modifiedAt: '2026-01-01T00:00:00Z',
})

const saveBody = (path: string): FileSaveResponse => ({
  path,
  size: 24,
  modifiedAt: '2026-01-01T00:00:00Z',
})

// msw 命中计数（key = 请求路径参数），失效联动经计数变化验证
let listHits: Record<string, number> = {}
let contentHits: Record<string, number> = {}
let saveHits = 0
let deleteHits = 0
let mkdirHits = 0
let renameHits = 0

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok', code: 0, message: 'Success', data,
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
  http.get('*/api/v1/instances/inst1/files', ({ request }) => {
    const dir = new URL(request.url).searchParams.get('path') ?? '?'
    listHits[dir] = (listHits[dir] ?? 0) + 1
    return ok(listBody(dir))
  }),
  http.get('*/api/v1/instances/inst1/files/content', ({ request }) => {
    const p = new URL(request.url).searchParams.get('path') ?? '?'
    contentHits[p] = (contentHits[p] ?? 0) + 1
    return ok(contentBody(p))
  }),
  http.put('*/api/v1/instances/inst1/files/content', () => {
    saveHits++
    return ok(saveBody('/world/a.txt'))
  }),
  http.delete('*/api/v1/instances/inst1/files', () => {
    deleteHits++
    return ok(null)
  }),
  http.post('*/api/v1/instances/inst1/files/mkdir', () => {
    mkdirHits++
    return ok({ path: '/world', name: 'world' })
  }),
  http.post('*/api/v1/instances/inst1/files/rename', () => {
    renameHits++
    return ok({ oldPath: '/world/a.txt', newPath: '/backups/a.txt', name: 'a.txt' })
  }),
  // 错误传播专用（正常用例不可见，仅错误用例命中）
  http.get('*/api/v1/instances/inst-err/files', () => err(50000, 'internal error', 500)),
  http.get('*/api/v1/instances/inst-err/files/content', () => err(50000, 'internal error', 500)),
  http.put('*/api/v1/instances/inst-err/files/content', () => err(40030, 'write denied', 400)),
  http.delete('*/api/v1/instances/inst-err/files', () => err(40031, 'delete denied', 400)),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

// ── FakeXHR：替换全局 XMLHttpRequest，手动编排 upload load 响应（apiUploadFile 走 XHR 非 fetch） ──
type ProgressCb = (e: { lengthComputable: boolean; loaded: number; total: number }) => void

const sentXHR: FakeXHR[] = []

class FakeXHR {
  timeout = 0
  responseType = ''
  responseText = ''
  status = 200
  private progressCbs: ProgressCb[] = []
  private listeners: Record<string, (() => void)[]> = {}

  upload = {
    addEventListener: (_: string, cb: ProgressCb) => {
      this.progressCbs.push(cb)
    },
  }

  addEventListener(ev: string, cb: () => void) {
    ;(this.listeners[ev] ??= []).push(cb)
  }

  open() {}
  setRequestHeader() {}
  abort() {}

  send() {
    sentXHR.push(this)
  }

  emitProgress(loaded: number, total: number) {
    for (const cb of this.progressCbs) cb({ lengthComputable: true, loaded, total })
  }

  emitLoad(payload: object) {
    this.responseText = JSON.stringify(payload)
    for (const cb of this.listeners.load ?? []) cb()
  }
}

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
  listHits = {}
  contentHits = {}
  saveHits = deleteHits = mkdirHits = renameHits = 0
  sentXHR.length = 0
})

afterEach(() => {
  server.resetHandlers()
  vi.unstubAllGlobals()
})

describe('useFileList', () => {
  it('连接就绪：拉取目录列表并解包 data', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useFileList('inst1', '/'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({
      isDirectory: true,
      files: [{ name: 'server.properties', isDirectory: false }],
    })
    expect(listHits['/']).toBe(1)
  })

  it('enabled 门控：连接未就绪不发请求（idle pending）', async () => {
    useConnectionStore.setState({ apiKey: '', status: 'unconfigured' })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useFileList('inst1', '/'), { wrapper })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.fetchStatus).toBe('idle')
    expect(listHits['/']).toBeUndefined()
  })

  it('enabled 门控：instanceId=null 不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useFileList(null, '/'), { wrapper })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.fetchStatus).toBe('idle')
    expect(listHits['/']).toBeUndefined()
  })

  it('查询失败：error state 携带 ApiError（错误码真实传播）', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useFileList('inst-err', '/'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).code).toBe(50000)
  })
})

describe('useFileContent', () => {
  it('默认启用：拉取文件内容并解包（content/encoding）', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useFileContent('inst1', '/world/a.txt'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({ content: 'hello-world', encoding: 'utf-8' })
    expect(contentHits['/world/a.txt']).toBe(1)
  })

  it('enabled=false 参数：不查询（编辑器关闭场景）', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useFileContent('inst1', '/world/a.txt', false), { wrapper })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.fetchStatus).toBe('idle')
    expect(contentHits['/world/a.txt']).toBeUndefined()
  })

  it('未就绪或未选实例：不查询（enabled 短路）', async () => {
    useConnectionStore.setState({ apiKey: '', status: 'unconfigured' })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useFileContent(null, null), { wrapper })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.fetchStatus).toBe('idle')
    expect(contentHits).toEqual({})
  })

  it('查询失败：error state 携带 ApiError', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useFileContent('inst-err', '/x.txt'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).code).toBe(50000)
  })
})

describe('useSaveFile', () => {
  it('保存成功：返回响应并失效父目录列表与该文件内容缓存（嵌套路径）', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useFileList('inst1', '/world'), { wrapper })
    const content = renderHook(() => useFileContent('inst1', '/world/a.txt'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(content.result.current.isSuccess).toBe(true))
    expect(listHits['/world']).toBe(1)
    expect(contentHits['/world/a.txt']).toBe(1)

    const { result } = renderHook(() => useSaveFile('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate({ path: '/world/a.txt', content: 'hello' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(saveBody('/world/a.txt'))
    expect(saveHits).toBe(1)
    // onSuccess 失效 → 活跃 observer refetch（命中计数 +1）
    await waitFor(() => expect(listHits['/world']).toBe(2))
    await waitFor(() => expect(contentHits['/world/a.txt']).toBe(2))
  })

  it('保存根目录文件：parentDirOf 归一为根目录失效（无斜杠路径）', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useFileList('inst1', '/'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits['/']).toBe(1)

    const { result } = renderHook(() => useSaveFile('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate({ path: 'server.properties', content: 'x' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await waitFor(() => expect(listHits['/']).toBe(2))
  })

  it('instanceId=null：mutate 前置拒绝「未选择实例」，不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useSaveFile(null), { wrapper })
    await act(async () => {
      result.current.mutate({ path: '/a.txt', content: 'x' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).not.toBeInstanceOf(ApiError)
    expect((result.current.error as Error).message).toBe('未选择实例')
    expect(saveHits).toBe(0)
  })

  it('请求失败：mutation error 携带 ApiError，不触发列表失效', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useFileList('inst1', '/world'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits['/world']).toBe(1)

    const { result } = renderHook(() => useSaveFile('inst-err'), { wrapper })
    await act(async () => {
      result.current.mutate({ path: '/world/a.txt', content: 'x' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).code).toBe(40030)
    await act(async () => {
      await Promise.resolve()
    })
    expect(listHits['/world']).toBe(1)
  })
})

describe('useDeleteFile', () => {
  it('删除成功：data=null 并失效父目录列表与文件内容缓存', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useFileList('inst1', '/world'), { wrapper })
    const content = renderHook(() => useFileContent('inst1', '/world/a.txt'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(content.result.current.isSuccess).toBe(true))
    expect(listHits['/world']).toBe(1)

    const { result } = renderHook(() => useDeleteFile('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate({ path: '/world/a.txt' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
    expect(deleteHits).toBe(1)
    await waitFor(() => expect(listHits['/world']).toBe(2))
    await waitFor(() => expect(contentHits['/world/a.txt']).toBe(2))
  })

  it('instanceId=null：前置拒绝「未选择实例」，不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useDeleteFile(null), { wrapper })
    await act(async () => {
      result.current.mutate({ path: '/a.txt' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as Error).message).toBe('未选择实例')
    expect(deleteHits).toBe(0)
  })

  it('请求失败：mutation error 携带 ApiError，不触发列表失效', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useFileList('inst1', '/world'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits['/world']).toBe(1)

    const { result } = renderHook(() => useDeleteFile('inst-err'), { wrapper })
    await act(async () => {
      result.current.mutate({ path: '/world/a.txt' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).code).toBe(40031)
    await act(async () => {
      await Promise.resolve()
    })
    expect(listHits['/world']).toBe(1)
  })
})

describe('useCreateDirectory', () => {
  it('新建成功：父目录与目标目录列表一并失效（mkdir recursive 多级语义）', async () => {
    const { wrapper } = makeWrapper()
    const parent = renderHook(() => useFileList('inst1', '/'), { wrapper })
    const target = renderHook(() => useFileList('inst1', '/world'), { wrapper })
    await waitFor(() => expect(parent.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(target.result.current.isSuccess).toBe(true))
    expect(listHits['/']).toBe(1)
    expect(listHits['/world']).toBe(1)

    const { result } = renderHook(() => useCreateDirectory('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate({ dirPath: '/world' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mkdirHits).toBe(1)
    await waitFor(() => expect(listHits['/']).toBe(2))
    await waitFor(() => expect(listHits['/world']).toBe(2))
  })

  it('instanceId=null：前置拒绝「未选择实例」，不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateDirectory(null), { wrapper })
    await act(async () => {
      result.current.mutate({ dirPath: '/world' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as Error).message).toBe('未选择实例')
    expect(mkdirHits).toBe(0)
  })
})

describe('useRenameFile', () => {
  it('重命名成功：新旧两侧目录列表与旧路径内容缓存一并失效', async () => {
    const { wrapper } = makeWrapper()
    const oldParent = renderHook(() => useFileList('inst1', '/world'), { wrapper })
    const newParent = renderHook(() => useFileList('inst1', '/backups'), { wrapper })
    const content = renderHook(() => useFileContent('inst1', '/world/a.txt'), { wrapper })
    await waitFor(() => expect(oldParent.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(newParent.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(content.result.current.isSuccess).toBe(true))
    expect(listHits['/world']).toBe(1)
    expect(listHits['/backups']).toBe(1)
    expect(contentHits['/world/a.txt']).toBe(1)

    const { result } = renderHook(() => useRenameFile('inst1'), { wrapper })
    await act(async () => {
      result.current.mutate({ oldPath: '/world/a.txt', newPath: '/backups/a.txt' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(renameHits).toBe(1)
    await waitFor(() => expect(listHits['/world']).toBe(2))
    await waitFor(() => expect(listHits['/backups']).toBe(2))
    await waitFor(() => expect(contentHits['/world/a.txt']).toBe(2))
  })

  it('instanceId=null：前置拒绝「未选择实例」，不发请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useRenameFile(null), { wrapper })
    await act(async () => {
      result.current.mutate({ oldPath: '/a.txt', newPath: '/b.txt' })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as Error).message).toBe('未选择实例')
    expect(renameHits).toBe(0)
  })
})

describe('useUploadFile', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
  })

  const uploadOk = {
    status: 'ok', code: 0, message: 'Success',
    data: { path: '/plugins/config.txt', name: 'config.txt', size: 2048, modifiedAt: '2026-01-01T00:00:00Z', isDirectory: false },
    timestamp: '',
  }

  it('上传成功：返回响应并失效目标目录列表', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useFileList('inst1', '/plugins'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits['/plugins']).toBe(1)

    const { result } = renderHook(() => useUploadFile('inst1'), { wrapper })
    const file = new File(['hello'], 'config.txt', { type: 'text/plain' })
    await act(async () => {
      result.current.mutate({ file, targetDir: '/plugins' })
    })
    expect(sentXHR).toHaveLength(1)
    act(() => {
      sentXHR[0]!.emitLoad(uploadOk)
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({ name: 'config.txt', path: '/plugins/config.txt' })
    await waitFor(() => expect(listHits['/plugins']).toBe(2))
  })

  it('缺省 targetDir：失效根目录列表；onProgress 透传 XHR 进度', async () => {
    const { wrapper } = makeWrapper()
    const list = renderHook(() => useFileList('inst1', '/'), { wrapper })
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true))
    expect(listHits['/']).toBe(1)

    const { result } = renderHook(() => useUploadFile('inst1'), { wrapper })
    const file = new File(['hello'], 'config.txt', { type: 'text/plain' })
    const onProgress = vi.fn()
    await act(async () => {
      result.current.mutate({ file, onProgress })
    })
    expect(sentXHR).toHaveLength(1)
    act(() => {
      sentXHR[0]!.emitProgress(50, 100)
      sentXHR[0]!.emitLoad({ ...uploadOk, data: { ...uploadOk.data, path: '/config.txt' } })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(onProgress).toHaveBeenCalledWith(50)
    await waitFor(() => expect(listHits['/']).toBe(2))
  })

  it('instanceId=null：前置拒绝「未选择实例」，不发 XHR 请求', async () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useUploadFile(null), { wrapper })
    const file = new File(['hello'], 'config.txt', { type: 'text/plain' })
    await act(async () => {
      result.current.mutate({ file })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as Error).message).toBe('未选择实例')
    expect(sentXHR).toHaveLength(0)
  })
})
