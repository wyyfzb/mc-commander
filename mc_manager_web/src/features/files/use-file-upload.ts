/**
 * useFileUpload —— 文件上传逻辑外提（自 files-page.tsx 迁出，纯移动零行为变更）
 * - 隐藏 file input 直传：multipart → 服务端落地当前浏览目录（同名覆盖）
 * - 体积上限前置拦截：选择阶段即拒绝，不等到上传失败才报错（对齐服务端 multer 50MB）
 * - 同名冲突探测：当前目录已有同名文件 → 弹确认（对齐插件市场 40912 冲突流程）
 * - 可视进度 + 可取消（abort 信号透传 XHR）；卸载时中断在途上传（对齐插件页）
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { UPLOAD_MAX_FILE_BYTES, formatUploadLimit } from '@/api/files'
import { useFileList, useUploadFile } from './queries'

/** 上传逻辑 hook：状态（进度/冲突/abort 句柄/input ref）与回调整组外提 */
export function useFileUpload(
  instanceId: string | null,
  dir: string,
  uploadMutation: ReturnType<typeof useUploadFile>,
) {
  /** 上传中状态 + 进度（对齐插件上传进度条模式；单文件无需队列计数） */
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null)
  /** 上传同名冲突确认（对齐插件市场 40912 冲突流程） */
  const [uploadConflictTarget, setUploadConflictTarget] = useState<File | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)

  // 卸载时中断在途上传（对齐插件页：避免卸载后回调触发 state 更新）
  useEffect(() => () => uploadAbortRef.current?.abort(), [])

  /** 当前目录文件列表（上传前探测同名冲突；仅目录列表有 .files） */
  const fileListQuery = useFileList(instanceId, dir)
  const existingFileNames = useMemo(
    () => new Set(
      (fileListQuery.data && 'files' in fileListQuery.data
        ? fileListQuery.data.files
        : []
      ).map((f: { name: string }) => f.name),
    ),
    [fileListQuery.data],
  )

  /** 上传：触发隐藏 file input（服务端落地到当前浏览目录，同名覆盖） */
  const openUploadPicker = () => {
    uploadInputRef.current?.click()
  }

  /** 执行上传（冲突确认后调用或无冲突直接调用）；可视进度条 + 可取消（对齐插件上传交互） */
  const doUpload = async (file: File) => {
    setUploading({ name: file.name, pct: 0 })
    const controller = new AbortController()
    uploadAbortRef.current = controller
    try {
      const result = await uploadMutation.mutateAsync({
        file,
        targetDir: dir,
        onProgress: (pct) => setUploading({ name: file.name, pct }),
        signal: controller.signal,
      })
      toast.success(`已上传 ${result.path}（${(result.size / 1024).toFixed(1)} KB）`)
    } catch (err) {
      // 用户主动取消（cancelUpload 已提示「上传已取消」）：以 signal 状态判定，不叠加错误 toast
      if (controller.signal.aborted) return
      toast.error(`上传失败：${getFriendlyErrorText(err)}`)
    } finally {
      uploadAbortRef.current = null
      setUploading(null)
    }
  }

  /** 取消在途上传：abort 信号透传 XHR 中断；请求侧 reject 由 doUpload 以 signal 状态静默 */
  const cancelUpload = () => {
    uploadAbortRef.current?.abort()
    setUploading(null)
    toast.info('上传已取消')
  }

  const handleUploadChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复上传同名文件
    if (!file) return
    // 体积上限前置拦截：选择阶段即拒绝，不再等到上传失败才报错（对齐服务端 multer 50MB）
    if (file.size > UPLOAD_MAX_FILE_BYTES) {
      toast.error(`「${file.name}」超过单文件上限 ${formatUploadLimit(UPLOAD_MAX_FILE_BYTES)}，请压缩后上传`)
      return
    }
    if (uploadMutation.isPending) return // 在途保护：上传中忽略重复触发
    // 同名冲突探测：当前目录已有同名文件 → 弹确认（对齐插件市场 40912 流程）
    if (existingFileNames.has(file.name)) {
      setUploadConflictTarget(file)
      return
    }
    await doUpload(file)
  }

  return {
    /** 上传中条目（进度条渲染） */
    uploading,
    /** 同名冲突目标（确认弹窗受控值） */
    uploadConflictTarget,
    setUploadConflictTarget,
    /** 隐藏 file input ref（工具栏上传按钮触发用） */
    uploadInputRef,
    openUploadPicker,
    doUpload,
    cancelUpload,
    handleUploadChange,
  }
}
