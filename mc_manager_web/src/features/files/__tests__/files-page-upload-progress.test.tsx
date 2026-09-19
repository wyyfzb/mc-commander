/**
 * FilesPage 上传进度反馈测试（#293 toast 文字 → issue 339 进度条改版）
 * Monaco 在 jsdom 不可渲染——沿用 monaco-editor-pane.test 的 mock 策略（占位组件 + 常量 stub）。
 * apiUploadFile 走 XMLHttpRequest：以 FakeXHR 全局替换并手动编排 upload progress / load 响应，
 * 验证 handleUploadChange → useUploadFile → apiUploadFile 的 onProgress 透传链、
 * 可视进度条（progressbar ARIA 三元组 + 直更无节流）、取消中断、50MB 前置拦截与成功/失败/在途保护收尾。
 * 测试路径与文件名均为虚构示例，严禁真实服务器数据
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster, toast } from 'sonner'
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
  // sonner toast store 模块级：清残留防跨测试泄漏干扰反向断言
  toast.dismiss()
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
  // mutateAsync 经 query-core 数个微任务后才执行 mutationFn，XHR 的 send 晚于 fireEvent 同步栈
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
  it('onProgress 接线：进度条 aria-valuenow 直更 + ARIA 三元组齐全 → 完成后进度条消失 + success 收尾', async () => {
    renderPage()
    await pickFile(new File(['data'], '示例整合包.zip', { type: 'application/zip' }))

    // 进度条出现且 ARIA 属性齐全（role/label/min/max）
    const bar = await screen.findByRole('progressbar', { name: '文件上传进度' })
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')

    const xhr = sentXHR[0]!
    xhr.emitProgress(5, 100)
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '5'),
    )
    // 进度条直更（无 toast 文字节流）：5% → 7% 直接反映
    xhr.emitProgress(7, 100)
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '7'),
    )
    xhr.emitProgress(100, 100)
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100'),
    )
    // 完成收尾：进度条消失 + success toast
    xhr.emitLoad(okUploadEnvelope())
    expect(await screen.findByText('已上传 /示例整合包.zip（1.0 KB）')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument())
  })

  it('上传失败：进度条消失 + toast error 收尾（错误码本地化文案）', async () => {
    renderPage()
    await pickFile(new File(['data'], '示例地图.zip', { type: 'application/zip' }))

    expect(await screen.findByRole('progressbar')).toBeInTheDocument()
    const xhr = sentXHR[0]!
    xhr.emitLoad({
      status: 'error',
      code: 40008,
      message: 'file type not allowed',
      details: null,
      timestamp: new Date().toISOString(),
    })
    expect(await screen.findByText(/上传失败：/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument())
  })

  it('在途保护：上传进行中再次选择文件不产生第二个请求', async () => {
    renderPage()
    await pickFile(new File(['a'], '示例A.zip', { type: 'application/zip' }))
    // 第二次选择（第一个请求未放行仍处在途）
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['b'], '示例B.zip')] } })
    // 在途守卫在 change 处理器内同步判定；但缺陷路径经 mutateAsync 要数个微任务后才发出 XHR，
    // 先 act 让渡落定再断言（落定语义，非时长语义）
    await act(async () => {})
    expect(sentXHR).toHaveLength(1)
    // 放行后完成收尾
    sentXHR[0]!.emitLoad(okUploadEnvelope())
    expect(await screen.findByText('已上传 /示例整合包.zip（1.0 KB）')).toBeInTheDocument()
  })

  it('50MB 前置拦截：超限文件选择阶段即拒绝，不发起请求', async () => {
    renderPage()
    // 构造 size 属性覆盖的 File（避免真实分配 51MB 缓冲）
    const oversized = new File(['data'], '超限世界备份.zip', { type: 'application/zip' })
    Object.defineProperty(oversized, 'size', { value: 51 * 1024 * 1024 })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [oversized] } })

    // 体积拦截在 change 处理器内同步判定；上限提示出现即证明拦截分支已执行
    expect(await screen.findByText(/超过单文件上限 50MB/)).toBeInTheDocument()
    expect(sentXHR).toHaveLength(0)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('取消：点击取消按钮 → XHR abort 被调用 + 进度条消失 + 取消提示（无错误 toast）', async () => {
    const abortSpy = vi.spyOn(FakeXHR.prototype, 'abort')
    renderPage()
    await pickFile(new File(['data'], '示例大地图.zip', { type: 'application/zip' }))

    const xhr = sentXHR[0]!
    xhr.emitProgress(30, 100)
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30'),
    )

    fireEvent.click(screen.getByTestId('upload-cancel'))
    expect(abortSpy).toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument())
    // 取消提示出现（info toast；FakeXHR.abort 为空实现不触发 abort 事件，
    // 请求侧 signal.aborted 静默分支由组件逻辑保证，此处验证 UI 即时反馈链）
    expect(await screen.findByText('上传已取消')).toBeInTheDocument()
  })
})
