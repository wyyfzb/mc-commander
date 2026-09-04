/**
 * useFileEditor —— 编辑器内容状态管理外提（自 files-page.tsx 迁出，纯移动零行为变更）
 * - draft 组件 state 与 query 缓存隔离；originalRef 为已加载/已保存基线
 * - 内容加载完成 → 同步 draft 与基线；二进制文件深链接守卫（feat-9）
 * - 保存竞态守卫（useSnapshotSave）：连续快速保存只有最后一次结果被采纳
 * - restoreDraft：编辑器「还原」按钮（基线存在才可恢复）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { isBinaryFileName } from '@/lib/mc-files'
import { useSnapshotSave } from '@/hooks/use-snapshot-save'
import { useFileContent, useSaveFile } from './queries'

interface UseFileEditorOptions {
  /** 当前选中文件路径（null=未选中） */
  selectedPath: string | null
  /** 选中文件切换（URL 同步版，useCallback 稳定引用） */
  setSelectedPath: (path: string | null) => void
  contentQuery: ReturnType<typeof useFileContent>
  saveMutation: ReturnType<typeof useSaveFile>
}

export function useFileEditor({
  selectedPath,
  setSelectedPath,
  contentQuery,
  saveMutation,
}: UseFileEditorOptions) {
  // ── 编辑器内容（组件 state，与 query 隔离；originalRef 为已加载/已保存基线） ──
  const [draft, setDraft] = useState('')
  const originalRef = useRef<string | null>(null)

  /** 保存竞态守卫：连续快速保存时只有最后一次结果被采纳（hook 须在早返回前调用） */
  const fileSave = useSnapshotSave<{ path: string; content: string }>({
    onSave: async (snapshot) => {
      await saveMutation.mutateAsync(snapshot)
    },
    onSaved: (snapshot) => {
      originalRef.current = snapshot.content
      if (snapshot.path.endsWith('server.properties')) {
        toast.success('文件已保存，部分属性需重启服务器后生效')
      } else {
        toast.success('文件已保存')
      }
    },
    onError: (e) => {
      toast.error(`保存失败：${getFriendlyErrorText(e)}`)
    },
  })

  /** 保存当前文件（Ctrl+S / 保存按钮共用；竞态守卫） */
  const save = useCallback(() => {
    if (!selectedPath) return
    fileSave.save({ path: selectedPath, content: draft })
  }, [selectedPath, draft, fileSave])

  /** 内容加载完成 → 同步本地 draft 与基线（与 query 数据对齐属外部系统同步，非派生可替代） */
  useEffect(() => {
    if (contentQuery.data && contentQuery.data.path === selectedPath) {
      // oxlint-disable-next-line react/set-state-in-effect -- 既有模式（自 files-page 迁出）：异步查询数据到达后同步本地草稿，依赖数组限定仅数据/路径变化时触发
      setDraft(contentQuery.data.content)
      originalRef.current = contentQuery.data.content
    }
  }, [contentQuery.data, selectedPath])

  // oxlint-disable-next-line react/refs -- 既有模式（自 files-page 迁出）：渲染期读取已保存基线计算脏标记，ref 为非渲染输出仅用于比较
  const dirty = selectedPath !== null && draft !== originalRef.current

  /**
   * 二进制文件深链接守卫（feat-9）：URL ?file=/world/level.dat 直达二进制时，
   * 文本编辑器本就打不开（服务端 40006），主动清选择并提示改用下载，
   * 避免“编辑器 + 报错”的误导态。
   */
  useEffect(() => {
    const name = selectedPath?.split('/').pop() ?? ''
    if (selectedPath && isBinaryFileName(name)) {
      toast.info('二进制文件无法在线编辑，可使用行内下载按钮导出到本地', {
        description: selectedPath,
      })
      setSelectedPath(null)
    }
  }, [selectedPath, setSelectedPath])

  /** 恢复到上次保存版本（编辑器「还原」按钮；基线存在才可恢复） */
  const restoreDraft = () => {
    if (originalRef.current != null) {
      setDraft(originalRef.current)
      toast.info('已恢复到上次保存版本')
    }
  }

  return { draft, setDraft, originalRef, fileSave, save, dirty, restoreDraft }
}
