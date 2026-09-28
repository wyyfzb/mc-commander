/**
 * DeleteConfirmDialog —— 文件/目录删除确认（自 files-page.tsx 迁出，纯移动零行为变更）
 * - 目录：红色警告递归删除文案；文件：单文件删除文案
 * - danger + 不可逆提示；内容插槽展示完整路径（truncate + title 悬浮全路径）
 */
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import type { FileEntry } from '@/api/types'

interface DeleteConfirmDialogProps {
  /** 删除目标（null=关闭） */
  target: FileEntry | null
  /** 删除 mutation pending 态（确认按钮 loading） */
  loading: boolean
  /** 确认删除（父组件执行 mutation 与页面级联动：回父目录/关编辑器） */
  onConfirm: () => void
  /** 关闭（取消/ESC） */
  onClose: () => void
}

export function DeleteConfirmDialog({
  target,
  loading,
  onConfirm,
  onClose,
}: DeleteConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`删除 ${target?.name ?? ''}？`}
      description={
        target?.isDirectory === true
          ? `将递归删除目录「${target?.name}」及其全部内容。`
          : `将删除文件「${target?.name}」。`
      }
      confirmText="删除"
      danger
      warning="此操作不可撤销"
      loading={loading}
      onConfirm={onConfirm}
    >
      <div className="py-1">
        <p
          className="truncate rounded-mcs-xs bg-mcs-bg-muted px-2 py-1 font-mono text-mcs-2xs text-mcs-text-muted"
          title={target?.path}
        >
          {target?.path}
        </p>
      </div>
    </ConfirmDialog>
  )
}
