/**
 * client.ts 下载/上传传输层行为级测试（issue 495：api 层三文件覆盖率洼地收口）
 * 补足既有 client.test.ts（信封契约/凭据）未触达的传输分支：
 * - apiDownloadFile：Content-Disposition 三形态解析（RFC5987/引号/无引号）+ 编码异常回退、
 *   流式进度（ReadableStream + Content-Length）、blob 快路径、错误信封/非 JSON 错误、外部取消
 * - apiUploadFile（XHR）：query 拼接、非 JSON 载荷、error 信封（含 40103 会话过期处置）、用户取消
 * 数据均为虚构测试值，不含真实服务器信息
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { apiDownloadFile, apiUploadFile, apiGet, type ConnectionConfig } from '../client'
import { panelAddress } from '@/lib/mc-connection'
import { useAuthStore, SESSION_EXPIRED_EVENT } from '@/stores/auth'

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

const server = setupServer(
  http.get('*/api/v1/dl', () => HttpResponse.text('file-bytes')),
  http.post('*/api/v1/upload', () =>
    ok({
      path: '/x.jar',
      name: 'x.jar',
      size: 10,
      modifiedAt: '2026-01-01T00:00:00Z',
      isDirectory: false,
    }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // 会话是模块级单例：不清会泄漏给同文件后续用例（隐性顺序依赖）
  useAuthStore.getState().clearSession()
  // server.use 的覆盖会留到下一个用例（同上，隐性顺序依赖）
  server.resetHandlers()
})

const config: ConnectionConfig = { baseUrl: 'http://localhost:25566', apiKey: 'test-key' }

describe('apiDownloadFile · Content-Disposition 解析', () => {
  const dl = (header?: string) =>
    server.use(
      http.get('*/api/v1/dl', () =>
        HttpResponse.text('bytes', header ? { headers: { 'Content-Disposition': header } } : {}),
      ),
    )

  it('RFC 5987 filename*（UTF-8 扩展）优先并解码中文文件名', async () => {
    dl(`attachment; filename="fallback.zip"; filename*=UTF-8''%E5%AD%98%E6%A1%A3.zip`)
    const { fileName } = await apiDownloadFile('/api/v1/dl', config)
    expect(fileName).toBe('存档.zip')
  })

  it('filename="引号形式" 回退解析', async () => {
    dl('attachment; filename="world.zip"')
    const { fileName } = await apiDownloadFile('/api/v1/dl', config)
    expect(fileName).toBe('world.zip')
  })

  it('filename=无引号形式 回退解析', async () => {
    dl('attachment; filename=world.zip')
    const { fileName } = await apiDownloadFile('/api/v1/dl', config)
    expect(fileName).toBe('world.zip')
  })

  it('缺失 header 返回 null（由调用方回退 entry.name）', async () => {
    dl(undefined)
    const { fileName } = await apiDownloadFile('/api/v1/dl', config)
    expect(fileName).toBeNull()
  })

  it('filename* 编码异常时回退到 filename= 形式', async () => {
    dl(`attachment; filename="safe.zip"; filename*=UTF-8''%ZZ-broken`)
    const { fileName } = await apiDownloadFile('/api/v1/dl', config)
    expect(fileName).toBe('safe.zip')
  })
})

describe('apiDownloadFile · 流式进度与 blob 快路径', () => {
  it('Content-Length + onProgress：流式读取按已接收字节回调（0-100 收敛）', async () => {
    const payload = 'a'.repeat(10) + 'b'.repeat(10) // 20 字节
    server.use(
      http.get('*/api/v1/dl', () =>
        HttpResponse.text(payload, { headers: { 'Content-Length': '20' } }),
      ),
    )
    const pcts: number[] = []
    const { blob, fileName } = await apiDownloadFile('/api/v1/dl', config, {
      onProgress: (p) => pcts.push(p),
    })
    expect(blob.size).toBe(20)
    expect(fileName).toBeNull()
    expect(pcts.length).toBeGreaterThan(0)
    expect(Math.max(...pcts)).toBe(100)
    for (const p of pcts) {
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThanOrEqual(100)
    }
  })

  it('无 onProgress（或无 Content-Length）走 blob 快路径并回调 100', async () => {
    // 覆盖流式用例残留的 Content-Length handler：无 CL 时不得进入流式分支
    server.use(http.get('*/api/v1/dl', () => HttpResponse.text('file-bytes')))
    const onProgress = vi.fn()
    const { blob } = await apiDownloadFile('/api/v1/dl', config, { onProgress })
    expect(blob.size).toBe('file-bytes'.length)
    expect(onProgress).toHaveBeenCalledWith(100)
  })
})

describe('apiDownloadFile · 错误传播', () => {
  it('application/json 错误信封：ApiError 携带错误码传播（与 apiRequest 同语义）', async () => {
    server.use(
      http.get('*/api/v1/dl', () =>
        HttpResponse.json(
          { status: 'error', code: 40401, message: 'file not found', details: null, timestamp: '' },
          { status: 404 },
        ),
      ),
    )
    await expect(apiDownloadFile('/api/v1/dl', config)).rejects.toMatchObject({
      name: 'ApiError',
      code: 40401,
      httpStatus: 404,
    })
  })

  it('非 JSON 错误响应：NetworkError（下载失败 HTTP 状态）', async () => {
    server.use(
      http.get('*/api/v1/dl', () => HttpResponse.text('<html>gateway</html>', { status: 502 })),
    )
    await expect(apiDownloadFile('/api/v1/dl', config)).rejects.toMatchObject({
      name: 'NetworkError',
      message: expect.stringContaining('下载失败（HTTP 502）'),
    })
  })

  it('外部 signal 取消：NetworkError「下载已取消」（外部中止转发内部 controller）', async () => {
    // jsdom DOMException 与 undici 内部实现不同构（instanceof 失配），msw 路径下
    // 无法触达 AbortError 分支；stub fetch 用 jsdom 原生 DOMException 注入
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new DOMException('The operation was aborted', 'AbortError'))),
    )
    await expect(
      apiDownloadFile('/api/v1/dl', config, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'NetworkError', message: '下载已取消' })
  })

  it('下载遇 40103 且会话属于本面板：按会话过期处置（清会话 + 派发事件）', async () => {
    useAuthStore.setState({
      session: { token: 'tok-dl', sessionId: 'sess-dl', expiresAt: '2030-01-01T00:00:00.000Z' },
    })
    server.use(
      http.get('*/api/v1/dl', () =>
        HttpResponse.json(
          { status: 'error', code: 40103, message: 'session expired', details: null },
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(apiDownloadFile('/api/v1/dl', config)).rejects.toMatchObject({ code: 40103 })
      expect(useAuthStore.getState().session).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
    }
  })

  it('下载遇 40103 但会话属于别的面板：不清会话、不派发事件', async () => {
    const session = {
      token: 'tok-dl',
      sessionId: 'sess-dl',
      expiresAt: '2030-01-01T00:00:00.000Z',
      issuedFor: 'https://panel-a.example.com',
    }
    useAuthStore.setState({ session })
    server.use(
      http.get('*/api/v1/dl', () =>
        HttpResponse.json(
          { status: 'error', code: 40103, message: 'session expired', details: null },
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    try {
      await expect(
        apiDownloadFile('/api/v1/dl', { baseUrl: 'https://panel-b.example.com', apiKey: 'key-b' }),
      ).rejects.toMatchObject({ code: 40103 })
      expect(useAuthStore.getState().session).toEqual(session)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
    }
  })
})

describe('apiUploadFile（XHR 共享实现）', () => {
  const file = () => new File(['file-bytes'], 'x.jar', { type: 'application/java-archive' })

  it('上传成功：query 拼接 + data 解包', async () => {
    const res = await apiUploadFile<{ name: string }>(
      '/api/v1/upload?targetDir=%2Fplugins',
      config,
      file(),
    )
    expect(res.name).toBe('x.jar')
  })

  it('非 JSON 响应：NetworkError「响应解析失败」（xhr.responseText JSON.parse 失败路径）', async () => {
    server.use(
      http.post('*/api/v1/upload', () =>
        HttpResponse.text('<html>bad gateway</html>', { status: 502 }),
      ),
    )
    await expect(apiUploadFile('/api/v1/upload', config, file())).rejects.toMatchObject({
      name: 'NetworkError',
      message: expect.stringContaining('响应解析失败（HTTP 502）'),
    })
  })

  it('error 信封：ApiError 携带错误码与 xhr.status 传播', async () => {
    server.use(
      http.post('*/api/v1/upload', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40902,
            message: 'file type blocked',
            details: null,
            timestamp: '',
          },
          { status: 400 },
        ),
      ),
    )
    await expect(apiUploadFile('/api/v1/upload', config, file())).rejects.toMatchObject({
      name: 'ApiError',
      code: 40902,
      httpStatus: 400,
    })
  })

  it('上传遇 40103 会话过期：清会话 + 派发全局事件（与 apiRequest 同一处置）', async () => {
    // 会话过期必须先有会话：40103 只在「令牌属于本目标面板」时才算过期（异面板不动本机登录态）
    useAuthStore.getState().setSession({
      token: 'tok-upload',
      sessionId: 'sess-up',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    server.use(
      http.post('*/api/v1/upload', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40103,
            message: 'session expired',
            details: null,
            timestamp: '',
          },
          { status: 401 },
        ),
      ),
    )
    try {
      await expect(apiUploadFile('/api/v1/upload', config, file())).rejects.toMatchObject({
        code: 40103,
      })
      expect(useAuthStore.getState().session).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
    }
  })

  it('上传遇 40103 但会话属于别的面板：不动本机登录态（异面板不得把人踢下线）', async () => {
    const session = {
      token: 'tok-other',
      sessionId: 'sess-other',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedFor: 'https://panel-a.example.com',
    }
    useAuthStore.getState().setSession(session)
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    server.use(
      http.post('*/api/v1/upload', () =>
        HttpResponse.json(
          {
            status: 'error',
            code: 40103,
            message: 'session expired',
            details: null,
            timestamp: '',
          },
          { status: 401 },
        ),
      ),
    )
    try {
      await expect(
        apiUploadFile(
          '/api/v1/upload',
          { baseUrl: 'https://panel-b.example.com', apiKey: 'key-b' },
          file(),
        ),
      ).rejects.toMatchObject({ code: 40103 })
      expect(useAuthStore.getState().session).toEqual(session)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, listener)
      useAuthStore.getState().clearSession()
    }
  })

  it('用户取消：signal abort → XHR abort 事件 → NetworkError「上传已取消」（最小 XHR mock）', async () => {
    // msw 对 XHR abort 模拟不完整（abort 后 load 仍会触发），用最小 mock 精确驱动事件链
    let abortHandler: (() => void) | null = null
    class MockXHR {
      upload = { addEventListener: vi.fn() }
      status = 0
      responseText = ''
      timeout = 0
      addEventListener(type: string, fn: () => void) {
        if (type === 'abort') abortHandler = fn
      }
      setRequestHeader() {}
      open() {}
      send() {}
      abort() {
        abortHandler?.()
      }
    }
    vi.stubGlobal('XMLHttpRequest', MockXHR)
    const controller = new AbortController()
    const promise = apiUploadFile('/api/v1/upload', config, file(), { signal: controller.signal })
    controller.abort() // 外部 signal → xhr.abort() → abort 事件 → reject
    await expect(promise).rejects.toMatchObject({ name: 'NetworkError', message: '上传已取消' })
  })

  it('上传成功后回填旧会话的签发面板（与 fetch / 下载路径同一口径）', async () => {
    useAuthStore.setState({
      session: { token: 'tok-up', sessionId: 'sess-up', expiresAt: '2030-01-01T00:00:00.000Z' },
    })
    await apiUploadFile<{ name: string }>('/api/v1/upload', config, file())
    expect(useAuthStore.getState().session?.issuedFor).toBe(panelAddress(config.baseUrl))
  })

  it('网络层失败：NetworkError「网络连接失败」（XHR error 事件路径）', async () => {
    server.close()
    try {
      await expect(
        apiUploadFile('/api/v1/upload', { baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, file()),
      ).rejects.toMatchObject({ name: 'NetworkError' })
    } finally {
      server.listen({ onUnhandledRequest: 'error' })
    }
  })
})

describe('requestEnvelope · 外部 signal 与超时分支', () => {
  it('外部 signal 中止：AbortError → NetworkError（超时文案为既有行为，如实锁定）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new DOMException('The operation was aborted', 'AbortError'))),
    )
    await expect(apiGet('/api/v1/dl', config, new AbortController().signal)).rejects.toMatchObject({
      name: 'NetworkError',
      message: '请求超时，请检查服务器连接',
    })
  })

  it('非 APIError/AbortError/TypeError 的未知异常原样抛出（finally 清理定时器）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('boom-inside-fetch'))),
    )
    await expect(apiGet('/api/v1/dl', config)).rejects.toThrow('boom-inside-fetch')
  })
})

describe('requestEnvelope（apiRequest 链）· 变体补充', () => {
  it('非 2xx 但响应体非 JSON：NetworkError「请求失败（HTTP 状态）」', async () => {
    server.use(
      http.get('*/api/v1/dl', () => HttpResponse.text('<html>err</html>', { status: 500 })),
    )
    await expect(apiGet('/api/v1/dl', config)).rejects.toMatchObject({
      name: 'NetworkError',
      message: '请求失败（HTTP 500）',
    })
  })

  it('非 2xx 且信封 status≠error（畸形信封）：退回 NetworkError「请求失败」', async () => {
    server.use(
      http.get('*/api/v1/dl', () =>
        HttpResponse.json(
          { status: 'ok', code: 0, message: 'x', data: null, timestamp: '' },
          { status: 500 },
        ),
      ),
    )
    const { apiGet } = await import('../client')
    await expect(apiGet('/api/v1/dl', config)).rejects.toMatchObject({
      name: 'NetworkError',
      message: '请求失败（HTTP 500）',
    })
  })
})
