import { describe, it, expect, beforeEach, afterAll, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { FileList, type FileListProps } from '../file-list'
import { fileIconName, formatFileSize, formatModifiedAt } from '@/lib/mc-files'
import { handlers } from '@/test/mocks/handlers'
import { useConnectionStore } from '@/stores/connection'
import type { FileEntry } from '@/api/types'

/**
 * FileList 组件测试
 * 覆盖：列表渲染（目录在前/图标映射/大小格式化）/ 行交互（onOpenDir/onSelectFile/onDelete）/
 *      面包屑渲染与点击 / 空态双文案 / 加载 Skeleton / 选中高亮
 * mock 数据为结构占位虚构（world/logs/region 等），严禁真实服务器信息
 */

function ok<T>(data: T) {
  return HttpResponse.json({
    status: 'ok',
    code: 0,
    message: 'Success',
    data,
    timestamp: new Date().toISOString(),
  })
}

/** 结构占位文件项工厂（虚构路径与时间） */
function fakeEntry(overrides: Partial<FileEntry>): FileEntry {
  return {
    name: 'file.xyz',
    path: '/file.xyz',
    type: 'file',
    size: 0,
    modifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
    isDirectory: false,
    ...overrides,
  }
}

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeEach(() => {
  localStorage.clear()
  useConnectionStore.setState({ baseUrl: '', apiKey: 'test-key', status: 'ready' })
})

function renderWithClient(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return render(<>{ui}</>, { wrapper })
}

const baseFileListProps: FileListProps = {
  instanceId: 'demo',
  dir: '/',
  selectedPath: null,
  onSelectFile: vi.fn(),
  onOpenDir: vi.fn(),
  onDelete: vi.fn(),
}

describe('格式化函数（组件内）', () => {
  it('formatFileSize：B / KB / MB 一位小数', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(64)).toBe('64 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(Math.round(3.5 * 1024 * 1024))).toBe('3.5 MB')
  })

  it('formatModifiedAt：MM-DD HH:mm 格式', () => {
    expect(formatModifiedAt('2026-08-14T03:05:00Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatModifiedAt('not-a-date')).toBe('-')
  })

  it('fileIconName：目录恒为 folder，文件按扩展名映射', () => {
    expect(fileIconName(fakeEntry({ name: 'world', isDirectory: true, type: 'directory' }))).toBe(
      'folder',
    )
    expect(fileIconName(fakeEntry({ name: 'server.properties' }))).toBe('file-text')
    expect(fileIconName(fakeEntry({ name: 'readme.txt' }))).toBe('file-text')
    expect(fileIconName(fakeEntry({ name: 'latest.log' }))).toBe('file-text')
    expect(fileIconName(fakeEntry({ name: 'whitelist.json' }))).toBe('braces')
    expect(fileIconName(fakeEntry({ name: 'config.yml' }))).toBe('settings')
    expect(fileIconName(fakeEntry({ name: 'plugin.yaml' }))).toBe('settings')
    expect(fileIconName(fakeEntry({ name: 'server.jar' }))).toBe('archive')
    expect(fileIconName(fakeEntry({ name: 'screenshot.png' }))).toBe('image')
    expect(fileIconName(fakeEntry({ name: 'photo.JPG' }))).toBe('image')
    expect(fileIconName(fakeEntry({ name: 'unknown.dat' }))).toBe('file')
    expect(fileIconName(fakeEntry({ name: 'noext' }))).toBe('file')
  })
})

describe('FileList', () => {
  it('加载中显示 Skeleton 行', () => {
    renderWithClient(<FileList {...baseFileListProps} />)
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it('渲染根目录 5 项：目录在前 + 图标色 + 副行（大小/文件夹）', async () => {
    renderWithClient(<FileList {...baseFileListProps} />)
    // 5 行全部渲染，目录排在最前（world/logs → server.properties/whitelist.json/ops.json）
    const rows = await screen.findAllByRole('button', { name: /^(打开目录|选择文件) / })
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveAccessibleName('打开目录 world')
    expect(rows[1]).toHaveAccessibleName('打开目录 logs')
    expect(rows[2]).toHaveAccessibleName('选择文件 server.properties')
    expect(rows[3]).toHaveAccessibleName('选择文件 whitelist.json')
    expect(rows[4]).toHaveAccessibleName('选择文件 ops.json')
    // 文件名
    expect(screen.getByText('server.properties')).toBeInTheDocument()
    // 副行：文件「大小 · MM-DD HH:mm」（1.0 KB / 128 B / 64 B）
    expect(screen.getByText(/^1\.0 KB · \d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument()
    expect(screen.getByText(/^128 B · \d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument()
    expect(screen.getByText(/^64 B · \d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument()
    // 副行：目录「文件夹 · MM-DD HH:mm」（两条）
    expect(screen.getAllByText(/^文件夹 · \d{2}-\d{2} \d{2}:\d{2}$/)).toHaveLength(2)
    // 图标色：目录 folder 黄（--mcs-warning-fg），文件 muted
    expect(screen.getByTestId('file-icon-world')).toHaveClass('text-mcs-warning-fg')
    expect(screen.getByTestId('file-icon-server.properties')).toHaveClass('text-mcs-text-muted')
  })

  it('目录行单击 onOpenDir；文件行/编辑按钮 onSelectFile；删除按钮 onDelete（含目录）', async () => {
    const onSelectFile = vi.fn()
    const onOpenDir = vi.fn()
    const onDelete = vi.fn()
    renderWithClient(
      <FileList
        {...baseFileListProps}
        onSelectFile={onSelectFile}
        onOpenDir={onOpenDir}
        onDelete={onDelete}
      />,
    )
    // 目录行单击 → 进入目录
    fireEvent.click(await screen.findByRole('button', { name: '打开目录 world' }))
    expect(onOpenDir).toHaveBeenCalledTimes(1)
    expect(onOpenDir).toHaveBeenCalledWith('/world')
    // 文件行单击 → 选中/打开文件
    fireEvent.click(screen.getByRole('button', { name: '选择文件 server.properties' }))
    expect(onSelectFile).toHaveBeenCalledWith('/server.properties')
    // 编辑按钮 → 打开编辑器（同 onSelectFile，且不触发行单击）
    fireEvent.click(screen.getByRole('button', { name: '编辑 server.properties' }))
    expect(onSelectFile).toHaveBeenCalledTimes(2)
    expect(onSelectFile).toHaveBeenLastCalledWith('/server.properties')
    expect(onOpenDir).toHaveBeenCalledTimes(1)
    // 删除按钮：文件与目录均可，且不触发行单击
    fireEvent.click(screen.getByRole('button', { name: '删除 whitelist.json' }))
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'whitelist.json',
        path: '/whitelist.json',
        isDirectory: false,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '删除 world' }))
    expect(onDelete).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'world', path: '/world', isDirectory: true }),
    )
    expect(onOpenDir).toHaveBeenCalledTimes(1)
  })

  it('选中文件行高亮（bg-accent-bg-subtle）', async () => {
    renderWithClient(<FileList {...baseFileListProps} selectedPath="/server.properties" />)
    const row = await screen.findByRole('button', { name: '选择文件 server.properties' })
    expect(row.className).toContain('bg-mcs-accent-bg-subtle')
  })

  it('当前预览文件行以 aria-current 暴露（底色只是视觉线索，读屏拿不到）', async () => {
    renderWithClient(<FileList {...baseFileListProps} selectedPath="/server.properties" />)
    const current = await screen.findByRole('button', { name: '选择文件 server.properties' })
    expect(current).toHaveAttribute('aria-current', 'true')
    // 未选中的行不设该属性（否则「当前项」在语义上等于每行都是）
    expect(screen.getByRole('button', { name: '选择文件 ops.json' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  // ── ：二进制编辑保护 + 行级下载 ──

  /** 含二进制文件的列表项（server.jar / level.dat 混入常规文本文件） */
  const binaryFiles = [
    {
      name: 'server.jar',
      path: '/server.jar',
      type: 'file',
      size: 4096,
      modifiedAt: '2026-08-01T00:00:00Z',
      isDirectory: false,
    },
    {
      name: 'level.dat',
      path: '/level.dat',
      type: 'file',
      size: 8192,
      modifiedAt: '2026-08-01T00:00:00Z',
      isDirectory: false,
    },
    {
      name: 'server.properties',
      path: '/server.properties',
      type: 'file',
      size: 100,
      modifiedAt: '2026-08-01T00:00:00Z',
      isDirectory: false,
    },
  ] as const

  function useBinaryList() {
    server.use(
      http.get('*/api/v1/instances/:id/files', () =>
        ok({ path: '/', isDirectory: true, files: [...binaryFiles] }),
      ),
    )
  }

  it('二进制文件不渲染编辑按钮（编辑保护），文本文件正常', async () => {
    useBinaryList()
    renderWithClient(<FileList {...baseFileListProps} />)
    await screen.findByRole('button', { name: '文件 server.jar（二进制，可下载）' })
    expect(screen.queryByRole('button', { name: '编辑 server.jar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '编辑 level.dat' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑 server.properties' })).toBeInTheDocument()
  })

  it('二进制文件行单击不触发 onSelectFile（仅可下载）', async () => {
    useBinaryList()
    const onSelectFile = vi.fn()
    renderWithClient(<FileList {...baseFileListProps} onSelectFile={onSelectFile} />)
    fireEvent.click(
      await screen.findByRole('button', { name: '文件 server.jar（二进制，可下载）' }),
    )
    expect(onSelectFile).not.toHaveBeenCalled()
    // 文本文件行单击不受影响
    fireEvent.click(screen.getByRole('button', { name: '选择文件 server.properties' }))
    expect(onSelectFile).toHaveBeenCalledWith('/server.properties')
  })

  it('下载按钮：文件行渲染、目录行不渲染、点击回调 onDownload', async () => {
    useBinaryList()
    const onDownload = vi.fn()
    // 混入一个目录验证目录无下载按钮
    server.use(
      http.get('*/api/v1/instances/:id/files', () =>
        ok({
          path: '/',
          isDirectory: true,
          files: [
            {
              name: 'world',
              path: '/world',
              type: 'directory',
              size: 0,
              modifiedAt: '2026-08-01T00:00:00Z',
              isDirectory: true,
            },
            ...binaryFiles,
          ],
        }),
      ),
    )
    renderWithClient(<FileList {...baseFileListProps} onDownload={onDownload} />)
    await screen.findByRole('button', { name: '下载 server.jar' })
    expect(screen.getByRole('button', { name: '下载 level.dat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载 server.properties' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '下载 world' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下载 server.jar' }))
    expect(onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'server.jar', path: '/server.jar' }),
    )
  })

  it('未提供 onDownload 时不渲染下载按钮（向后兼容）', async () => {
    useBinaryList()
    renderWithClient(<FileList {...baseFileListProps} />)
    await screen.findByRole('button', { name: '文件 server.jar（二进制，可下载）' })
    expect(screen.queryByRole('button', { name: '下载 server.jar' })).not.toBeInTheDocument()
  })

  it('下载中（downloadingPath 命中）→ 按钮 disabled + spinner 图标', async () => {
    useBinaryList()
    renderWithClient(
      <FileList {...baseFileListProps} onDownload={vi.fn()} downloadingPath="/server.jar" />,
    )
    const btn = await screen.findByRole('button', { name: '下载 server.jar' })
    expect(btn).toBeDisabled()
    expect(btn.querySelector('.animate-spin')).not.toBeNull()
    // 其他行不受影响
    expect(screen.getByRole('button', { name: '下载 level.dat' })).toBeEnabled()
  })

  it('面包屑：根 Home + 逐级可点，末级加粗 aria-current', async () => {
    const onOpenDir = vi.fn()
    renderWithClient(<FileList {...baseFileListProps} dir="/world/region" onOpenDir={onOpenDir} />)
    // 面包屑三段：根 Home / world（可点）/ region（末级加粗）
    const home = await screen.findByRole('button', { name: '根目录' })
    fireEvent.click(home)
    expect(onOpenDir).toHaveBeenCalledWith('/')
    const worldCrumb = screen.getByRole('button', { name: 'world' })
    fireEvent.click(worldCrumb)
    expect(onOpenDir).toHaveBeenCalledWith('/world')
    const regionCrumb = screen.getByText('region')
    expect(regionCrumb).toHaveAttribute('aria-current', 'page')
    expect(regionCrumb.className).toContain('font-semibold')
  })

  it('空态双文案：根目录 / 子目录', async () => {
    // 覆盖 files 端点：任何目录均返回空列表
    server.use(
      http.get('*/api/v1/instances/:id/files', ({ request }) => {
        const dir = new URL(request.url).searchParams.get('path') ?? '/'
        return ok({ path: dir, isDirectory: true, files: [] })
      }),
    )
    const view = renderWithClient(<FileList {...baseFileListProps} dir="/" />)
    expect(await screen.findByText('该实例根目录下没有文件')).toBeInTheDocument()
    // 切到子目录：重挂载组件但保留 QueryClient 包装
    view.rerender(<FileList {...baseFileListProps} dir="/world" />)
    expect(await screen.findByText('此文件夹为空')).toBeInTheDocument()
  })

  it('错误状态显示失败原因 + 重试按钮，重试成功后显示文件列表', async () => {
    let callCount = 0
    server.use(
      http.get('*/api/v1/instances/:id/files', () => {
        callCount++
        if (callCount === 1) {
          return HttpResponse.json(
            {
              status: 'error',
              code: 500,
              message: '目录不存在',
              data: null,
              timestamp: new Date().toISOString(),
            },
            { status: 500 },
          )
        }
        return ok({ path: '/', isDirectory: true, files: [fakeEntry({ name: 'recovered.txt' })] })
      }),
    )
    renderWithClient(<FileList {...baseFileListProps} />)
    // 错误状态：显示失败原因 + 重试按钮
    expect(await screen.findByText(/^加载失败：/)).toBeInTheDocument()
    const retryBtn = screen.getByRole('button', { name: '重试' })
    expect(retryBtn).toBeEnabled()
    // 点击重试 → 第二次请求成功 → 文件列表出现
    fireEvent.click(retryBtn)
    expect(await screen.findByText('recovered.txt')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })
})
