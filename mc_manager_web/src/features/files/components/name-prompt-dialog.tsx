/**
 * NamePromptDialog —— 名称输入对话框（新建文件/新建目录共用表单骨架）
 * （自 files-page.tsx 两个同构 Dialog 合并迁出，纯移动零行为变更）
 * - 受控名称输入 + Enter 直提交；创建中 LoadingButton 防重复提交
 * - 名称校验（空值/路径分隔符）由父组件 onSubmit 负责（toast 提示行为不变）
 */
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { LoadingButton } from '@/components/mcs/loading-button'
import { Input } from '@/components/ui/input'

interface NamePromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** 描述文案（含当前目录名，由父组件拼接） */
  description: string
  /** 输入框 aria-label（「文件名」/「目录名」） */
  inputLabel: string
  placeholder: string
  value: string
  onValueChange: (v: string) => void
  /** 提交中（LoadingButton loading） */
  submitting: boolean
  submitText?: string
  loadingText?: string
  onSubmit: () => void
}

export function NamePromptDialog({
  open,
  onOpenChange,
  title,
  description,
  inputLabel,
  placeholder,
  value,
  onValueChange,
  submitting,
  submitText = '创建',
  loadingText = '创建中…',
  onSubmit,
}: NamePromptDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Input
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={placeholder}
            aria-label={inputLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSubmit()
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <LoadingButton onClick={() => void onSubmit()} loading={submitting} loadingText={loadingText}>
            {submitText}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
