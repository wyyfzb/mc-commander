/**
 * MoveDialog —— 移动文件/目录到目标目录
 *
 * 复用 `POST /files/rename`：服务端本就接受任意 `newPath`（`+ noClobber`），
 * 「换父目录」只是 newPath 取另一个目录。此前前端**根本做不到移动**——
 * 重命名对话框的名称校验禁含 `/`（`entryNameError`），故只能改同目录内的名字。
 *
 * 目标目录为手填路径而非树选择器：服务端列表端点一次只给一层，做树要递归拉全仓
 * （大实例很贵），而文件页本就有可粘贴的路径面包屑。校验只拦「显然错」的形态，
 * 真正的合法性（存在性 / 越界 / 冲突）由服务端裁决并把错误码翻译回来。
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

interface MoveDialogProps {
  /** 移动目标（null=关闭） */
  target: FileEntry | null
  /** 目标目录（'/' 前缀风格） */
  targetDir: string
  onTargetDirChange: (v: string) => void
  /** 提交中 */
  submitting: boolean
  onSubmit: () => void
  onClose: () => void
}

export function MoveDialog({
  target,
  targetDir,
  onTargetDirChange,
  submitting,
  onSubmit,
  onClose,
}: MoveDialogProps) {
  const kind = target?.isDirectory === true ? '目录' : '文件'
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>移动 {target?.name}</DialogTitle>
          <DialogDescription>
            将{kind}
            {target?.path}移动到此实例内的另一个目录（同名文件已存在时会被拒绝，不覆盖）
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Input
            value={targetDir}
            onChange={(e) => onTargetDirChange(e.target.value)}
            placeholder="目标目录，如 /plugins"
            aria-label="目标目录"
            onKeyDown={(e) => {
              // IME 组合期（中文候选）的 Enter 是选词确认，不当作提交
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') void onSubmit()
            }}
          />
          <p className="mt-1.5 text-mcs-xs text-mcs-text-muted">
            以 / 开头；不存在的目录不会被创建
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <LoadingButton onClick={() => void onSubmit()} loading={submitting} loadingText="移动中…">
            移动
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
