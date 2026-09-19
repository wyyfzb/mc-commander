/**
 * RenameDialog —— 文件/目录重命名对话框（自 files-page.tsx 迁出，纯移动零行为变更）
 * - 标题携带原名；描述区分目录/文件并展示完整路径
 * - 受控新名称输入 + Enter 直提交；重命名中 LoadingButton 防重复提交
 * - 名称校验（空值/分隔符/未变更短路）由父组件 onSubmit 负责
 */
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
import { Input } from '@/components/ui/input'
import type { FileEntry } from '@/api/types'

interface RenameDialogProps {
  /** 重命名目标（null=关闭） */
  target: FileEntry | null
  value: string
  onValueChange: (v: string) => void
  /** 提交中（LoadingButton loading） */
  submitting: boolean
  onSubmit: () => void
  /** 关闭（取消/ESC） */
  onClose: () => void
}

export function RenameDialog({
  target,
  value,
  onValueChange,
  submitting,
  onSubmit,
  onClose,
}: RenameDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重命名 {target?.name}</DialogTitle>
          <DialogDescription>
            {target?.isDirectory === true ? '目录' : '文件'}路径：{target?.path}
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Input
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder="新名称"
            aria-label="新名称"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSubmit()
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <LoadingButton
            onClick={() => void onSubmit()}
            loading={submitting}
            loadingText="重命名中…"
          >
            重命名
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
