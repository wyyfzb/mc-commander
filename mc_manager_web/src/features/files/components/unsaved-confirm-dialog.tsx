/**
 * UnsavedConfirmDialog —— 未保存修改放弃确认（自 files-page.tsx 迁出，纯移动零行为变更）
 * - 关闭编辑器与路由守卫共用（open = 关闭确认 || guard.isBlocked）
 * - isBlocked 分支描述文案：「离开页面」/「关闭」
 * - danger：确认按钮 destructive 深红实底
 */
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'

interface UnsavedConfirmDialogProps {
  open: boolean
  /** 路由守卫拦截态（影响描述文案：离开页面 / 关闭） */
  isBlocked: boolean
  /** 取消（留下）：父组件负责关闭关闭确认 + guard.cancel() */
  onCancel: () => void
  /** 确认放弃：父组件负责清理编辑器状态 + guard.proceed() */
  onConfirm: () => void
}

export function UnsavedConfirmDialog({
  open,
  isBlocked,
  onCancel,
  onConfirm,
}: UnsavedConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
      title="放弃未保存的修改？"
      description={`当前文件有未保存的更改，${isBlocked ? '离开页面' : '关闭'}后将丢失这些修改。`}
      cancelText="留下"
      confirmText="放弃修改并离开"
      danger
      onConfirm={onConfirm}
    />
  )
}
