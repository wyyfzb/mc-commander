/**
 * usePluginUpload —— 插件上传逻辑外提（自 plugins-page.tsx 迁出，纯移动零行为变更）
 * - 顺序上传队列：XHR 进度（可取消）+ 失败不阻断 + 40912 同名冲突暂停弹确认
 * - 选择/拖放入口：过滤非 .jar（逐个提示）
 * - 全页拖放：dragover 高亮遮罩（嵌套 dragleave 用计数法防误触发）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { getFriendlyErrorText, ErrorCode } from '@/api/errors'
import { apiUploadPlugin } from '@/api/plugins'
import { useConnectionStore } from '@/stores/connection'

/** 同名冲突上下文：触发冲突的文件 + 上传队列剩余文件（确认覆盖后继续） */
export interface UploadConflict {
  file: File
  rest: File[]
  /** 已成功数量（toast 汇总用） */
  succeeded: number
}

interface UsePluginUploadOptions {
  /** 当前实例 id（null 时上传早退，防御性 guard） */
  instanceId: string | null
  /** 队列结束/中止后刷新插件列表（消费方传 pluginsQuery.refetch） */
  refreshList: () => void
}

export function usePluginUpload({ instanceId, refreshList }: UsePluginUploadOptions) {
  /** 上传中条目（顺序队列同一时刻仅一个活跃） */
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null)
  /** 上传队列剩余数量（含活跃项） */
  const [queueRemaining, setQueueRemaining] = useState(0)
  /** 同名覆盖确认 */
  const [conflict, setConflict] = useState<UploadConflict | null>(null)
  /** 拖放悬停高亮 */
  const [dragActive, setDragActive] = useState(false)

  const uploadAbortRef = useRef<AbortController | null>(null)
  /** 拖放嵌套计数（子元素 dragleave 会误触发，用计数法） */
  const dragDepthRef = useRef(0)
  /** 上传成功数（覆盖确认后续传时累计） */
  const uploadSucceededRef = useRef(0)
  /** 上传失败数 */
  const uploadFailedRef = useRef(0)

  // 卸载时取消进行中的上传
  useEffect(() => () => uploadAbortRef.current?.abort(), [])

  /** 上传单个文件；40912 同名冲突时抛给调用方处理 */
  const uploadOne = useCallback(async (file: File, overwrite: boolean) => {
    if (!instanceId) return // 早退分支语义（此处尚未渲染，防御性 guard）
    setUploading({ name: file.name, pct: 0 })
    const controller = new AbortController()
    uploadAbortRef.current = controller
    try {
      const result = await apiUploadPlugin(useConnectionStore.getState(), instanceId, file, {
        overwrite,
        onProgress: (pct) => setUploading({ name: file.name, pct }),
        signal: controller.signal,
      })
      uploadSucceededRef.current += 1
      toast.success(
        result.overwritten
          ? `已覆盖上传 ${file.name}，重启实例后生效`
          : `已上传 ${file.name}${result.meta?.name ? `（${result.meta.name}）` : ''}，重启实例后生效`,
      )
    } finally {
      uploadAbortRef.current = null
    }
  }, [instanceId])

  /** 顺序上传队列：冲突时暂停并弹确认；取消/失败不阻断其余文件 */
  const runUploadQueue = useCallback(
    async (files: File[], overwrite = false, succeededBase = 0) => {
      uploadSucceededRef.current = succeededBase
      uploadFailedRef.current = 0
      const queue = [...files]
      let idx = 0
      while (idx < queue.length) {
        const file = queue[idx]
        if (!file) break // 循环条件已保证存在，noUncheckedIndexedAccess 收窄用
        setQueueRemaining(queue.length - idx)
        try {
          await uploadOne(file, overwrite)
          idx += 1
          // 覆盖模式仅对触发冲突的那一个文件生效，后续文件恢复默认防覆盖
          overwrite = false
        } catch (e) {
          if (e instanceof ApiError && e.code === ErrorCode.PLUGIN_FILE_EXISTS) {
            // 同名冲突：暂停队列，弹确认框；确认后从当前文件继续
            setConflict({ file, rest: queue.slice(idx + 1), succeeded: uploadSucceededRef.current })
            setUploading(null)
            setQueueRemaining(0)
            return
          }
          uploadFailedRef.current += 1
          toast.error(`上传 ${file.name} 失败：${getFriendlyErrorText(e)}`)
          idx += 1
        }
      }
      setUploading(null)
      setQueueRemaining(0)
      if (uploadFailedRef.current > 0) {
        toast.warning(`上传完成：成功 ${uploadSucceededRef.current} 个，失败 ${uploadFailedRef.current} 个`)
      }
      void refreshList()
    },
    [uploadOne, refreshList],
  )

  /** 选择/拖放入口：过滤非 .jar（逐个提示），剩余进入队列 */
  const handleFilesPicked = useCallback(
    (list: FileList | File[] | null) => {
      if (!list || list.length === 0) return
      const all = Array.from(list)
      const jars = all.filter((f) => f.name.toLowerCase().endsWith('.jar'))
      const skipped = all.length - jars.length
      if (jars.length === 0) {
        toast.error('仅支持上传 .jar 插件文件')
        return
      }
      if (skipped > 0) toast.warning(`${skipped} 个非 .jar 文件已跳过`)
      uploadSucceededRef.current = 0
      uploadFailedRef.current = 0
      void runUploadQueue(jars)
    },
    [runUploadQueue],
  )

  const cancelUpload = () => {
    uploadAbortRef.current?.abort()
    setUploading(null)
    setQueueRemaining(0)
    toast.info('上传已取消')
  }

  const confirmOverwrite = () => {
    if (!conflict) return
    const { file, rest, succeeded } = conflict
    setConflict(null)
    void runUploadQueue([file, ...rest], true, succeeded)
  }

  const skipConflictFile = () => {
    if (!conflict) return
    const { rest, succeeded } = conflict
    uploadFailedRef.current += 1
    setConflict(null)
    if (rest.length > 0) {
      void runUploadQueue(rest, false, succeeded)
    } else {
      setUploading(null)
      setQueueRemaining(0)
      toast.warning(`上传完成：成功 ${succeeded} 个，跳过 1 个（同名冲突），失败 0 个`)
      void refreshList()
    }
  }

  /** 关闭冲突确认（ESC/遮罩关闭：队列终止，剩余文件不续传） */
  const dismissConflict = () => setConflict(null)

  // ── 拖放（整页接受 .jar，计数法处理嵌套 dragleave） ────────────

  const onDragEnter = (e: React.DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault() // 允许 drop
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    handleFilesPicked(e.dataTransfer.files)
  }

  return {
    uploading,
    queueRemaining,
    conflict,
    dragActive,
    handleFilesPicked,
    cancelUpload,
    confirmOverwrite,
    skipConflictFile,
    dismissConflict,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  }
}
