/**
 * FilesPage 上传同名冲突确认测试（#328）
 * 验证上传前探测同名文件 → 弹确认对话框（覆盖/跳过）→ 未冲突文件直接上传。
 * Monaco 在 jsdom 不可渲染——沿用 mock 策略（占位组件 + 常量 stub）。
 * 测试路径与文件名均为虚构示例，严禁真实服务器数据
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers } from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { FilesPage } from '../files-page'

// ── Monaco 相关 mock（jsdom 不可渲染，占位即可） ──
vi.mock('@monaco-editor/react', () => ({
  loader: { config: () => {} },
  default: function MockEditor({ value }: { value?: string }) {
    return <textarea aria-label="代码编辑器占位" defaultValue={value} readOnly />
  },
}))
vi.mock('monaco-editor', () => ({
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
}))

// ── FakeXHR：替换全局 XMLHttpRequest，手动编排 upload progress / load 响应 ──
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

const server = setupServer(...handlers)

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

function okUploadEnvelope(name: string, path: string) {
  return {
    status: 'ok',
    code: 0,
    message: 'Success',
    data: { path, name, size: 2048 },
    timestamp: new Date().toISOString(),
  }
}

describe('FilesPage 上传同名冲突确认（#328）', () => {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  afterAll(() => server.close())
  afterEach(() => {
    server.resetHandlers()
    vi.unstubAllGlobals()
  })
  beforeEach(() => {
    sentXHR.length = 0
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    localStorage.clear()
    useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
    useServerStore.setState({ instanceId: 'test-inst' })
  })

  it('同名文件上传：弹出冲突确认对话框（覆盖/跳过）', async () => {
    renderPage()
    // 等待文件列表加载（mockFileListRoot 含 server.properties）
    await waitFor(() => expect(screen.getByText('server.properties')).toBeInTheDocument())

    // 选择同名文件 server.properties 上传
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { files: [new File(['new-data'], 'server.properties')] } })

    // 冲突确认对话框应出现（冲突探测在 change 处理器内同步判定）
    expect(await screen.findByText('同名文件已存在')).toBeInTheDocument()
    // 冲突流程收口后再断言未发请求（冲突弹窗阻断）
    expect(sentXHR).toHaveLength(0)
    expect(screen.getByText('覆盖')).toBeInTheDocument()
    expect(screen.getByText('跳过')).toBeInTheDocument()
  })

  it('确认覆盖：关闭弹窗并发起上传请求', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('server.properties')).toBeInTheDocument())

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['new-data'], 'server.properties')] } })

    // 等待冲突弹窗出现
    expect(await screen.findByText('同名文件已存在')).toBeInTheDocument()

    // 点击「覆盖」
    fireEvent.click(screen.getByText('覆盖'))

    // 弹窗关闭，上传请求已发出
    await waitFor(() => expect(sentXHR).toHaveLength(1))
    // 完成上传
    sentXHR[0]!.emitLoad(okUploadEnvelope('server.properties', '/server.properties'))
    expect(await screen.findByText(/已上传/)).toBeInTheDocument()
  })

  it('点击跳过：关闭弹窗不发起上传', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('server.properties')).toBeInTheDocument())

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['new-data'], 'server.properties')] } })

    expect(await screen.findByText('同名文件已存在')).toBeInTheDocument()

    // 点击「跳过」
    fireEvent.click(screen.getByText('跳过'))

    // 弹窗关闭（跳过流程收口）后，无上传请求；act 让渡微任务，防将来跳过改走
    // mutateAsync 时缺陷性上传晚于断言发出（query-core 的 mutationFn 非同步栈内执行）
    await waitFor(() => expect(screen.queryByText('同名文件已存在')).not.toBeInTheDocument())
    await act(async () => {})
    expect(sentXHR).toHaveLength(0)
  })

  it('无冲突文件：直接上传不弹确认', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('server.properties')).toBeInTheDocument())

    // 上传一个目录中不存在的文件名
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['data'], 'new-config.yml')] } })

    // 应直接发起上传请求（无冲突弹窗）
    await waitFor(() => expect(sentXHR).toHaveLength(1))
    expect(screen.queryByText('同名文件已存在')).not.toBeInTheDocument()

    // 完成上传
    sentXHR[0]!.emitLoad(okUploadEnvelope('new-config.yml', '/new-config.yml'))
    expect(await screen.findByText(/已上传/)).toBeInTheDocument()
  })
})
