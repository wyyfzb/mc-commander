/**
 * useFileDownload —— 文件下载逻辑外提（自 files-page.tsx 迁出，纯移动零行为变更）
 * - blob → a[download] 触发保存（feat-9；apiDownloadFile 内部封装 ObjectURL 生命周期）
 * - toast 复用同一 id 展示进度（>5% 才刷新，避免大文件高频重渲染）
 * - downloadingPath 行内 spinner 状态 + 防重复点击
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { apiDownloadFile } from '@/api/files'
import { useConnectionStore } from '@/stores/connection'
import type { FileEntry } from '@/api/types'

/** 下载逻辑 hook：进度 toast 编排与行内 spinner 状态 */
export function useFileDownload(instanceId: string | null) {
  /** 正在下载的文件路径（行内 spinner + 防重复点击） */
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null)

  /**
   * 下载文件到本地（feat-9）：blob → a[download] 触发保存。
   * toast 复用同一 id 展示进度（>5% 才刷新，避免大文件高频重渲染）；
   * 二进制/大文件是下载能力的主要受益者（编辑器对二进制不可用）。
   */
  const downloadFile = async (entry: FileEntry) => {
    if (!instanceId || downloadingPath) return
    setDownloadingPath(entry.path)
    const toastId = `download-${entry.path}`
    let lastPct = 0
    try {
      toast.loading(`正在下载 ${entry.name}…`, { id: toastId })
      const { fileName } = await apiDownloadFile(useConnectionStore.getState(), instanceId, entry, {
        onProgress: (pct) => {
          if (pct - lastPct >= 5 || pct === 100) {
            lastPct = pct
            toast.loading(`正在下载 ${entry.name} ${pct}%`, { id: toastId })
          }
        },
      })
      // 时长与「一次性回执」家族统一（success 回执显式声明 duration: 1500）
      toast.success(`已下载 ${fileName}`, { id: toastId, duration: 1500 })
    } catch (err) {
      toast.error(`下载失败：${getFriendlyErrorText(err)}`, { id: toastId })
    } finally {
      setDownloadingPath(null)
    }
  }

  return { downloadingPath, downloadFile }
}
