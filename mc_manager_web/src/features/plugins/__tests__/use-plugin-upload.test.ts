/**
 * usePluginUpload hook 单元测试（issue 432：插件域 0% 覆盖收口）
 * apiUploadPlugin 以 vi.mock 替换为可控 Promise（gate 手法）精确编排时序；toast 层 mock 断言文案。
 * 覆盖：
 * - 入口过滤：全非 .jar 拒绝 + 混合列表跳过提示
 * - 顺序队列：失败不阻断 + 汇总 toast + 收尾 refreshList
 * - 进度回调：onProgress → uploading.pct 直更
 * - 40912 冲突：暂停弹确认 → overwrite 仅对触发文件生效（后续文件复位）→ skip 两分支 → dismiss 终止
 * - 取消：signal abort + 即时复位
 * - 拖放：嵌套 enter/leave 计数法 + 非 Files 类型早退 + onDrop 入队
 * - 防御：instanceId=null 早退；卸载 abort
 * 文件名均为虚构示例，严禁真实服务器数据
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { DragEvent } from 'react'
import { ApiError } from '@/api/client'
import { usePluginUpload } from '../use-plugin-upload'

vi.mock('@/api/plugins', () => ({ apiUploadPlugin: vi.fn() }))

vi.mock('sonner', async (importOriginal) => {
  const mod = await importOriginal<typeof import('sonner')>()
  return {
    ...mod,
    toast: Object.assign({}, mod.toast, {
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    }),
  }
})

import { apiUploadPlugin } from '@/api/plugins'
import { toast } from 'sonner'
import type { PluginUploadResult } from '@/api/types'

const mockUpload = vi.mocked(apiUploadPlugin)
const refreshList = vi.fn()

function mkJar(name: string): File {
  return new File(['data'], name, { type: 'application/java-archive' })
}

function mkOther(name: string): File {
  return new File(['data'], name, { type: 'application/zip' })
}

function uploadOk(file: string, overwritten = false): PluginUploadResult {
  return { file, sizeBytes: 1024, mtimeMs: 1760000000000, meta: null, overwritten }
}

/** 连续 flush microtask（上传队列 async 链跨多轮 then） */
async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

function dragEvent(types: string[] = ['Files']): DragEvent {
  return {
    dataTransfer: { types, files: [] as unknown as FileList },
    preventDefault: vi.fn(),
  } as unknown as DragEvent
}

function dropEvent(files: File[]): DragEvent {
  return {
    dataTransfer: { types: ['Files'], files } as unknown as DataTransfer,
    preventDefault: vi.fn(),
  } as unknown as DragEvent
}

function renderUpload(instanceId: string | null = 'demo') {
  return renderHook(() => usePluginUpload({ instanceId, refreshList }))
}

beforeEach(() => {
  vi.clearAllMocks()
  refreshList.mockClear()
})

describe('usePluginUpload 入口过滤', () => {
  it('全非 .jar：错误提示且不发起任何请求', async () => {
    const { result } = renderUpload()
    act(() => {
      result.current.handleFilesPicked([mkOther('DemoA.zip'), mkOther('DemoB.exe')])
    })
    await flushMicrotasks()
    expect(toast.error).toHaveBeenCalledWith('仅支持上传 .jar 插件文件')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(result.current.uploading).toBeNull()
  })

  it('混合列表：跳过非 .jar 逐个提示，.jar 正常入队并全部成功', async () => {
    const { result } = renderUpload()
    mockUpload
      .mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('DemoA.jar')))
      .mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('DemoB.jar')))

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar'), mkOther('note.zip'), mkJar('DemoB.jar')])
    })
    await flushMicrotasks()

    expect(toast.warning).toHaveBeenCalledWith('1 个非 .jar 文件已跳过')
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockUpload.mock.calls.map((c) => c[2].name)).toEqual(['DemoA.jar', 'DemoB.jar'])
    expect(result.current.uploading).toBeNull()
    expect(result.current.queueRemaining).toBe(0)
    expect(toast.success).toHaveBeenCalledTimes(2)
    expect(refreshList).toHaveBeenCalledTimes(1)
  })

  it('空列表早退：不发起请求', async () => {
    const { result } = renderUpload()
    act(() => {
      result.current.handleFilesPicked([])
    })
    await flushMicrotasks()
    expect(mockUpload).not.toHaveBeenCalled()
  })
})

describe('usePluginUpload 顺序队列与进度', () => {
  it('上传成功：进度回调直更 uploading.pct，完成复位 + success toast + refreshList', async () => {
    const { result } = renderUpload()
    let capturedOpts: { onProgress?: (pct: number) => void } | undefined
    let release!: (value: PluginUploadResult) => void
    const gate = new Promise<PluginUploadResult>((resolve) => {
      release = resolve
    })
    mockUpload.mockImplementationOnce((_c, _i, _f, opts) => {
      capturedOpts = opts
      opts?.onProgress?.(0)
      return gate
    })

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar')])
    })
    expect(result.current.uploading).toEqual({ name: 'DemoA.jar', pct: 0 })
    expect(result.current.queueRemaining).toBe(1)

    await act(async () => {
      capturedOpts?.onProgress?.(50)
    })
    expect(result.current.uploading).toEqual({ name: 'DemoA.jar', pct: 50 })

    await act(async () => {
      release(uploadOk('DemoA.jar'))
      await flushMicrotasks()
    })
    expect(result.current.uploading).toBeNull()
    expect(result.current.queueRemaining).toBe(0)
    expect(toast.success).toHaveBeenCalledWith('已上传 DemoA.jar，落入 plugins/，重启实例后生效')
    expect(refreshList).toHaveBeenCalledTimes(1)
  })

  it('失败不阻断：第一个失败 toast 后第二个继续，收尾汇总 warning', async () => {
    const { result } = renderUpload()
    mockUpload
      .mockImplementationOnce((_c, _i, _f) =>
        Promise.reject(new ApiError(50000, 500, 'internal error', null)),
      )
      .mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('DemoB.jar')))

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar'), mkJar('DemoB.jar')])
    })
    await flushMicrotasks()

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('上传 DemoA.jar 失败'))
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(toast.warning).toHaveBeenCalledWith('上传完成：成功 1 个，失败 1 个')
    expect(refreshList).toHaveBeenCalledTimes(1)
  })
})

describe('usePluginUpload 40912 同名冲突', () => {
  it('冲突暂停队列弹确认；确认覆盖仅对触发文件生效，后续文件复位为默认防覆盖', async () => {
    const { result } = renderUpload()
    mockUpload.mockImplementationOnce((_c, _i, _f) =>
      Promise.reject(new ApiError(40912, 409, 'Plugin file already exists', null)),
    )

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar'), mkJar('DemoB.jar')])
    })
    await flushMicrotasks()

    expect(result.current.conflict).not.toBeNull()
    expect(result.current.conflict?.file.name).toBe('DemoA.jar')
    expect(result.current.conflict?.rest).toHaveLength(1)
    expect(result.current.conflict?.rest[0]?.name).toBe('DemoB.jar')
    expect(result.current.conflict?.succeeded).toBe(0)
    expect(result.current.uploading).toBeNull()
    expect(result.current.queueRemaining).toBe(0)

    // 确认覆盖：当前文件以 overwrite=true 重传，后续文件恢复默认
    mockUpload
      .mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('DemoA.jar', true)))
      .mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('DemoB.jar')))
    await act(async () => {
      result.current.confirmOverwrite()
      await flushMicrotasks()
    })

    expect(mockUpload).toHaveBeenCalledTimes(3)
    expect(mockUpload.mock.calls[1]?.[3]?.overwrite).toBe(true)
    expect(mockUpload.mock.calls[1]?.[2].name).toBe('DemoA.jar')
    expect(mockUpload.mock.calls[2]?.[3]?.overwrite).toBe(false)
    expect(mockUpload.mock.calls[2]?.[2].name).toBe('DemoB.jar')
    expect(result.current.conflict).toBeNull()
    expect(result.current.uploading).toBeNull()
    expect(refreshList).toHaveBeenCalledTimes(1)
    // 覆盖分支的落地目录提示（与普通分支同款形状）
    expect(toast.success).toHaveBeenCalledWith('已覆盖上传 DemoA.jar，落入 plugins/，重启实例后生效')
  })

  it('skipConflictFile：跳过触发文件后剩余文件继续', async () => {
    const { result } = renderUpload()
    mockUpload.mockImplementationOnce((_c, _i, _f) =>
      Promise.reject(new ApiError(40912, 409, 'Plugin file already exists', null)),
    )

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar'), mkJar('DemoB.jar')])
    })
    await flushMicrotasks()
    expect(result.current.conflict).not.toBeNull()

    mockUpload.mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('DemoB.jar')))
    await act(async () => {
      result.current.skipConflictFile()
      await flushMicrotasks()
    })

    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockUpload.mock.calls[1]?.[2].name).toBe('DemoB.jar')
    // 边界语义（现状行为锁定）：skipConflictFile 的 failed+1 会被续传批次
    // runUploadQueue 开头的 failedRef=0 重置——跳过项不计入续传汇总，
    // 续传批全成功时走无汇总 toast 的静默收尾
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(refreshList).toHaveBeenCalledTimes(1)
  })

  it('skipConflictFile：无剩余文件直接收尾（跳过提示 + refreshList，不再发请求）', async () => {
    const { result } = renderUpload()
    mockUpload.mockImplementationOnce((_c, _i, _f) =>
      Promise.reject(new ApiError(40912, 409, 'Plugin file already exists', null)),
    )

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar')])
    })
    await flushMicrotasks()

    await act(async () => {
      result.current.skipConflictFile()
      await flushMicrotasks()
    })

    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith(
      '上传完成：成功 0 个，跳过 1 个（同名冲突），失败 0 个',
    )
    expect(refreshList).toHaveBeenCalledTimes(1)
    expect(result.current.conflict).toBeNull()
  })

  it('dismissConflict：关闭确认框终止队列，剩余文件不续传', async () => {
    const { result } = renderUpload()
    mockUpload.mockImplementationOnce((_c, _i, _f) =>
      Promise.reject(new ApiError(40912, 409, 'Plugin file already exists', null)),
    )

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar'), mkJar('DemoB.jar')])
    })
    await flushMicrotasks()
    expect(result.current.conflict).not.toBeNull()

    act(() => {
      result.current.dismissConflict()
    })
    expect(result.current.conflict).toBeNull()
    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(refreshList).not.toHaveBeenCalled()
  })

  it('冲突时已成功计数保留：确认覆盖后 succeeded 基线延续（汇总不重复计）', async () => {
    const { result } = renderUpload()
    // 第一批：Demo0 成功，DemoA 冲突
    mockUpload
      .mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('Demo0.jar')))
      .mockImplementationOnce((_c, _i, _f) =>
        Promise.reject(new ApiError(40912, 409, 'Plugin file already exists', null)),
      )

    act(() => {
      result.current.handleFilesPicked([mkJar('Demo0.jar'), mkJar('DemoA.jar')])
    })
    await flushMicrotasks()
    expect(result.current.conflict?.succeeded).toBe(1)

    mockUpload.mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('DemoA.jar', true)))
    await act(async () => {
      result.current.confirmOverwrite()
      await flushMicrotasks()
    })
    expect(toast.success).toHaveBeenCalledTimes(2)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('usePluginUpload 取消与防御', () => {
  it('cancelUpload：abort 信号触发 + 状态即时复位 + info toast', async () => {
    const { result } = renderUpload()
    const signals: AbortSignal[] = []
    mockUpload.mockImplementationOnce((_c, _i, _f, opts) => {
      if (opts?.signal) signals.push(opts.signal)
      return new Promise(() => {}) // 永不 settle
    })

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar')])
    })
    expect(result.current.uploading).not.toBeNull()

    act(() => {
      result.current.cancelUpload()
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(result.current.uploading).toBeNull()
    expect(result.current.queueRemaining).toBe(0)
    expect(toast.info).toHaveBeenCalledWith('上传已取消')
  })

  it('instanceId=null 早退：入口直通不发请求', async () => {
    const { result } = renderUpload(null)
    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar')])
    })
    await flushMicrotasks()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('卸载取消：进行中的上传在 unmount 时 abort', async () => {
    const { result, unmount } = renderUpload()
    const signals: AbortSignal[] = []
    mockUpload.mockImplementationOnce((_c, _i, _f, opts) => {
      if (opts?.signal) signals.push(opts.signal)
      return new Promise(() => {})
    })

    act(() => {
      result.current.handleFilesPicked([mkJar('DemoA.jar')])
    })
    unmount()
    expect(signals[0]?.aborted).toBe(true)
  })
})

describe('usePluginUpload 拖放', () => {
  it('嵌套 dragenter/dragleave 计数法：子元素离开不误关遮罩', () => {
    const { result } = renderUpload()
    act(() => {
      result.current.onDragEnter(dragEvent())
      result.current.onDragEnter(dragEvent())
    })
    expect(result.current.dragActive).toBe(true)

    act(() => {
      result.current.onDragLeave(dragEvent())
    })
    expect(result.current.dragActive).toBe(true) // 计数 2→1，仍活跃

    act(() => {
      result.current.onDragLeave(dragEvent())
    })
    expect(result.current.dragActive).toBe(false) // 1→0 关闭
  })

  it('非 Files 类型事件早退：不 preventDefault、不影响遮罩', () => {
    const { result } = renderUpload()
    const ev = dragEvent(['text/plain'])
    act(() => {
      result.current.onDragEnter(ev)
    })
    expect(result.current.dragActive).toBe(false)
    expect(ev.preventDefault).not.toHaveBeenCalled()
  })

  it('onDragOver 允许 drop（preventDefault），onDrop 复位遮罩并接续入口过滤队列', async () => {
    const { result } = renderUpload()
    const overEv = dragEvent()
    act(() => {
      result.current.onDragEnter(dragEvent())
      result.current.onDragOver(overEv)
    })
    expect(overEv.preventDefault).toHaveBeenCalled()

    mockUpload.mockImplementationOnce((_c, _i, _f) => Promise.resolve(uploadOk('DemoA.jar')))
    const drop = dropEvent([mkJar('DemoA.jar')])
    act(() => {
      result.current.onDrop(drop)
    })
    expect(drop.preventDefault).toHaveBeenCalled()
    expect(result.current.dragActive).toBe(false)
    await flushMicrotasks()
    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(refreshList).toHaveBeenCalledTimes(1)
  })
})
