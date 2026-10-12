import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { LoadingButton } from '@/components/mcs/loading-button'

/**
 * ConfirmDialog —— Tasteful Friction 分级确认（设计文档 P2）
 * - danger：破坏性操作（停止服务器等）确认按钮走 destructive 深红实底
 * - warning：不可逆提示小字（「此操作不可撤销」）
 * - children：自定义内容插槽（表单类确认，如消息输入）
 * - 强制显式确认（onInteractOutside 阻止点击遮罩关闭）
 */
interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  loading?: boolean
  onConfirm: () => void
  /** 取消时回调（EULA"不同意"场景需写回服务端） */
  onCancel?: () => void
  /** 不可逆提示（description 下方 warning 色小字） */
  warning?: string
  /** 自定义内容（DialogHeader 与 DialogFooter 之间） */
  children?: ReactNode
  /** 确认按钮禁用（危险确认输入不匹配等；loading 优先） */
  confirmDisabled?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
  warning,
  children,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="glass-overlay sm:max-w-sm"
        onInteractOutside={(e) => {
          // 强制显式确认：阻止点击遮罩关闭
          if (!loading) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (!loading) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {warning && <p className="text-mcs-xs text-mcs-warning-fg">{warning}</p>}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onCancel?.()
              onOpenChange(false)
            }}
            disabled={loading}
          >
            {cancelText}
          </Button>
          {danger ? (
            <LoadingButton
              variant="destructive"
              loading={loading}
              loadingText="处理中…"
              onClick={onConfirm}
              disabled={confirmDisabled}
            >
              {confirmText}
            </LoadingButton>
          ) : (
            <LoadingButton
              loading={loading}
              loadingText="处理中…"
              onClick={onConfirm}
              disabled={confirmDisabled}
            >
              {confirmText}
            </LoadingButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
