/**
 * UploadConflictDialog —— 上传同名冲突确认（自 files-page.tsx 迁出，纯移动零行为变更）
 * - 覆盖/跳过二选（对齐插件市场 40912 冲突流程）：确认携带冲突文件执行覆盖上传
 * - danger：覆盖按钮 destructive 深红实底
 */
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'

interface UploadConflictDialogProps {
  /** 冲突目标（null=关闭） */
  target: File | null
  /** 确认覆盖（携带触发冲突的文件；上传执行由父组件负责） */
  onConfirm: (file: File) => void
  /** 关闭（跳过/ESC） */
  onClose: () => void
}

export function UploadConflictDialog({ target, onConfirm, onClose }: UploadConflictDialogProps) {
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(o) => { if (!o) onClose() }}
      title="同名文件已存在"
      description={`当前目录已存在「${target?.name ?? ''}」，上传将覆盖原文件内容。`}
      confirmText="覆盖"
      cancelText="跳过"
      danger
      loading={false}
      onConfirm={() => {
        const f = target
        onClose()
        if (f) onConfirm(f)
      }}
    />
  )
}
