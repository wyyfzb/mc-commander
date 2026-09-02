/**
 * FilesPage 上传进度反馈测试（#293）
 * Monaco 在 jsdom 不可渲染——沿用 monaco-editor-pane.test 的 mock 策略（占位组件 + 常量 stub）。
 * apiUploadFile 走 XMLHttpRequest：以 FakeXHR 全局替换并手动编排 upload progress / load 响应，
 * 验证 handleUploadChange → useUploadFile → apiUploadFile 的 onProgress 透传链、
 * toast 进度（5% 步进同 id 复用）与成功/失败/在途保护收尾。
 * 测试路径与文件名均为虚构示例，严禁真实服务器数据
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { FilesPage } from '../files-page'

// ── Monaco 相关 mock（jsdom 不可渲染，占位即可；FilesPage 内不触发编辑断言） ──
vi.mock('@monaco-editor/react', () => ({
  loader: { config: () => {} },
  // 函数名大写开头：满足 rules-of-hooks 的组件识别
  default: function MockEditor({ value }: { value?: string }) {
    return <textarea aria-label="代码编辑器占位" defaultValue={value} readOnly />
  },
}))
vi.mock('monaco-editor', () => ({
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
}))

// ── FakeXHR：替换全局 XMLHttpRequest，手动编排 upload progress 与 load 响应 ──
type ProgressCb = (e: { lengthComputable: boolean; loaded: number; total: number }) => void

/** 记录测试期间所有被 send 的 FakeXHR（按序编排响应） */
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

  /** 触发 load（responseText 按 ok/error envelope 预置） */
  emitLoad(payload: object) {
    this.responseText = JSON.stringify(payload)
    for (const cb of this.listeners.load ?? []) cb()
  }
}

const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  sentXHR.length = 0
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ instanceId: 'test-inst' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        path: '/files',
        element: (
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <FilesPage />
              <Toaster />
            </TooltipProvider>
          </QueryClientProvider>
        ),
      },
    ],
    { initialEntries: ['/files?dir=/'] },
  )
  return render(<RouterProvider router={router} />)
}

/** 触发隐藏上传 input 的文件选择（handleUploadChange 入口） */
async function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).not.toBeNull()
  fireEvent.change(input, { target: { files: [file] } })
  // mutateAsync 同步启动 → XHR 已 send
  await waitFor(() => expect(sentXHR).toHaveLength(1))
}

function okUploadEnvelope() {
  return {
    status: 'ok',
    code: 0,
    message: 'Success',
    data: { path: '/示例整合包.zip', name: '示例整合包.zip', size: 1024 },
    timestamp: new Date().toISOString(),
  }
}

describe('FilesPage 上传进度反馈', () => {
  it('onProgress 接线：进度 toast 按 5% 步进更新（同 id）→ 完成后 success 收尾', async () => {
    renderPage()
    await pickFile(new File(['data'], '示例整合包.zip', { type: 'application/zip' }))

    const xhr = sentXHR[0]!
    xhr.emitProgress(5, 100)
    expect(await screen.findByText('正在上传 示例整合包.zip 5%')).toBeInTheDocument()
    // 步进不足 5%：不刷新文案（节流与下载一致）
    xhr.emitProgress(7, 100)
    expect(screen.queryByText('正在上传 示例整合包.zip 7%')).not.toBeInTheDocument()
    xhr.emitProgress(100, 100)
    expect(await screen.findByText('正在上传 示例整合包.zip 100%')).toBeInTheDocument()
    // 同 id 收尾：loading → success
    xhr.emitLoad(okUploadEnvelope())
    expect(await screen.findByText('已上传 /示例整合包.zip（1.0 KB）')).toBeInTheDocument()
  })

  it('上传失败：toast error 同 id 收尾（错误码本地化文案）', async () => {
    renderPage()
    await pickFile(new File(['data'], '示例地图.zip', { type: 'application/zip' }))

    const xhr = sentXHR[0]!
    xhr.emitLoad({
      status: 'error',
      code: 40008,
      message: 'file type not allowed',
      details: null,
      timestamp: new Date().toISOString(),
    })
    expect(await screen.findByText(/上传失败：/)).toBeInTheDocument()
  })

  it('在途保护：上传进行中再次选择文件不产生第二个请求', async () => {
    renderPage()
    await pickFile(new File(['a'], '示例A.zip', { type: 'application/zip' }))
    // 第二次选择（第一个请求未放行仍处在途）
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['b'], '示例B.zip')] } })
    await new Promise((r) => setTimeout(r, 20))
    expect(sentXHR).toHaveLength(1)
    // 放行后完成收尾
    sentXHR[0]!.emitLoad(okUploadEnvelope())
    expect(await screen.findByText('已上传 /示例整合包.zip（1.0 KB）')).toBeInTheDocument()
  })
})
