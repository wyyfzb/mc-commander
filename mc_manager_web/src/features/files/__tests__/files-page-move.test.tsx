/**
 * 文件页「移动到…」流程测试（组件级）。
 *
 * 缺口由来：本能力经条目 22② 落地时**零测试覆盖**，而两个真实缺陷恰藏在这条链路上——
 * ① 服务端列表出参在 win32 是 `\plugins\Foo\config.yml`，`parentDirOf` 只切 '/' 会让
 *    预填目标退化成 '/'，用户不改预填值一点「移动」就把文件搬到实例根；
 * ② `normalizeDirInput('//')` 曾返回空串（不是 null，调用点放行），拼出 `/名称` 同样搬根。
 * 故这里锁的是**拼给服务端的 newPath**，不是「点了按钮有反应」。
 *
 * Monaco 在 jsdom 不可渲染，沿用 files-page-upload-progress 的 mock 策略。
 * 路径与名称均为虚构示例，严禁真实服务器数据。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { Toaster, toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handlers, mockFileListRoot, mockFileListWorld } from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { FilesPage } from '../files-page'
import type { FileListResponse } from '@/api/types'

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

/** 每次 rename 调用的请求体（断言拼出的 newPath） */
const renameCalls: Array<{ path: string; newPath: string }> = []

const server = setupServer(
  ...handlers,
  http.post('*/api/v1/instances/:id/files/rename', async ({ request }) => {
    const body = (await request.json()) as { path: string; newPath: string }
    renameCalls.push(body)
    return HttpResponse.json({
      status: 'ok',
      code: 0,
      message: 'Renamed successfully',
      data: { oldPath: body.path, newPath: body.newPath, name: 'x' },
      timestamp: new Date().toISOString(),
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  renameCalls.length = 0
  toast.dismiss()
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
  useServerStore.setState({ instanceId: 'test-inst' })
})

/**
 * /world 下一层目录的列表：目录 `config` + 文件 `level.dat`。
 * 覆盖「嵌套目录里的条目」这一形态——预填值必须是 /world 而不是 /。
 */
const worldWithNestedFile: FileListResponse = {
  path: '/world',
  isDirectory: true,
  files: [
    ...mockFileListWorld.files,
    {
      name: 'level.dat_old',
      path: '/world/level.dat_old',
      type: 'file',
      size: 512,
      modifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
      isDirectory: false,
    },
  ],
}

function renderPage(initialEntry = '/files?dir=/') {
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
    { initialEntries: [initialEntry] },
  )
  return render(<RouterProvider router={router} />)
}

/** 打开某一行的「移动」对话框并返回输入框 */
async function openMoveDialog(rowLabel: string, initialEntry = '/files?dir=/') {
  renderPage(initialEntry)
  const moveBtn = await screen.findByRole('button', { name: `移动 ${rowLabel}`, hidden: true })
  fireEvent.click(moveBtn)
  return (await screen.findByLabelText('目标目录')) as HTMLInputElement
}

describe('文件页「移动到…」', () => {
  beforeEach(() => {
    server.use(
      http.get('*/api/v1/instances/:id/files', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: worldWithNestedFile,
          timestamp: new Date().toISOString(),
        }),
      ),
    )
  })

  /**
   * 核心回归锁：嵌套目录里的条目，预填目标必须是它**当前的父目录**。
   * 预填成 '/' 时用户不改就点移动 = 把文件从 /world 搬到实例根（静默搬家）。
   */
  it('预填目标目录 = 该条目的当前父目录（不是根）', async () => {
    const input = await openMoveDialog('level.dat_old', '/files?dir=/world')
    expect(input.value).toBe('/world')
  })

  it('不改预填值直接移动 → newPath 与原地一致，不发请求（不是搬家）', async () => {
    const input = await openMoveDialog('level.dat_old', '/files?dir=/world')
    expect(input.value).toBe('/world')

    const submit = screen.getByRole('button', { name: '移动' })
    fireEvent.click(submit)

    // 原地移动无意义：应当静默收尾，且**不得**发出把文件搬去别处的请求
    await waitFor(() => expect(screen.queryByLabelText('目标目录')).toBeNull())
    expect(renameCalls).toHaveLength(0)
  })

  it('改成合法目标 → 请求体是「目标目录 + 原文件名」', async () => {
    const input = await openMoveDialog('level.dat_old', '/files?dir=/world')
    fireEvent.change(input, { target: { value: '/plugins' } })
    fireEvent.click(screen.getByRole('button', { name: '移动' }))

    await waitFor(() => expect(renameCalls).toHaveLength(1))
    expect(renameCalls[0]).toEqual({
      path: '/world/level.dat_old',
      newPath: '/plugins/level.dat_old',
    })
  })

  /**
   * `//` 曾被归一成**空串**（既非 null 被放行、又不以 / 开头），拼出 `/名称` 把文件
   * 搬到实例根，toast 还显示成「已移动到 」。全斜杠输入的意图只能是根，故归一为 '/'。
   *
   * 注意断言面：修好与没修好拼出的 newPath **相同**（`/level.dat_old`），唯一可分辨的是
   * toast 文案——没修好时目标为空串，文案是「已移动到 」。故这里必须断言文案，
   * 只断言请求体会让这条用例变成空转。
   */
  it('输入 // 视为根目录（归一为 /，而不是空串）', async () => {
    const input = await openMoveDialog('level.dat_old', '/files?dir=/world')
    fireEvent.change(input, { target: { value: '//' } })
    fireEvent.click(screen.getByRole('button', { name: '移动' }))

    await waitFor(() => expect(renameCalls).toHaveLength(1))
    expect(renameCalls[0]).toEqual({
      path: '/world/level.dat_old',
      newPath: '/level.dat_old',
    })
    // 目标不是空串：文案必须带出 '/'（空串时渲染为「已移动到 」）
    expect(await screen.findByText('已移动到 /')).toBeInTheDocument()
  })

  /**
   * 非法形态必须在**前端**就被拦下（连请求都不发）：服务端虽然也会拒（403/404），
   * 但那是往返一次之后的事，且错误码文案不如本地提示具体。两类非法各测一次。
   */
  it('相对路径目标被前端拦下：不发请求、对话框保持打开', async () => {
    const input = await openMoveDialog('level.dat_old', '/files?dir=/world')
    fireEvent.change(input, { target: { value: 'plugins' } })
    fireEvent.click(screen.getByRole('button', { name: '移动' }))

    await waitFor(() =>
      expect(screen.getByText('目标目录必须以 / 开头，且不含 . 或 .. 段')).toBeInTheDocument(),
    )
    expect(renameCalls).toHaveLength(0)
    // 对话框保持打开，用户可改正
    expect(screen.getByLabelText('目标目录')).toBeInTheDocument()
  })

  it('含 .. 段的目标被前端拦下：不发请求', async () => {
    const input = await openMoveDialog('level.dat_old', '/files?dir=/world')
    fireEvent.change(input, { target: { value: '/a/../b' } })
    fireEvent.click(screen.getByRole('button', { name: '移动' }))

    await waitFor(() =>
      expect(screen.getByText('目标目录必须以 / 开头，且不含 . 或 .. 段')).toBeInTheDocument(),
    )
    expect(renameCalls).toHaveLength(0)
  })

  it('目录行与文件行都提供「移动」入口', async () => {
    renderPage('/files?dir=/world')
    // region 是目录、level.dat 是文件——两族都要有入口（此前目录只能靠重命名绕）
    expect(await screen.findByRole('button', { name: '移动 region' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移动 level.dat' })).toBeInTheDocument()
  })

  it('根目录下的条目预填为 /（回退分支正确，不是空串）', async () => {
    server.use(
      http.get('*/api/v1/instances/:id/files', () =>
        HttpResponse.json({
          status: 'ok',
          code: 0,
          message: 'Success',
          data: mockFileListRoot,
          timestamp: new Date().toISOString(),
        }),
      ),
    )
    const input = await openMoveDialog('server.properties')
    expect(input.value).toBe('/')
  })
})
