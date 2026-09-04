/**
 * UploadProgressBar —— 文件上传进度条（自 files-page.tsx 迁出，纯移动零行为变更）
 * - 对齐插件页交互：progressbar ARIA 三元组（label/min/max + valuenow 直更）+ 取消按钮
 * - 挂载于文件列表上方（mx-3 mt-2），aria-live=polite 播报进度
 */
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface UploadProgressBarProps {
  /** 上传中条目（单文件同一时刻仅一个活跃） */
  uploading: { name: string; pct: number }
  onCancel: () => void
}

export function UploadProgressBar({ uploading, onCancel }: UploadProgressBarProps) {
  return (
    <div
      className="mx-3 mt-2 flex shrink-0 items-center gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted px-4 py-3"
      data-testid="upload-progress"
      aria-live="polite"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-mcs-sm text-mcs-text-default" title={uploading.name}>
            正在上传 {uploading.name}
          </p>
          <span className="text-mcs-xs tabular-nums text-mcs-text-muted">{uploading.pct}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="文件上传进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={uploading.pct}
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-mcs-bg-hover"
        >
          <div
            className="h-full rounded-full bg-mcs-accent transition-[width] duration-mcs-base"
            style={{ width: `${uploading.pct}%` }}
          />
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onCancel} data-testid="upload-cancel">
        <X className="size-3.5" aria-hidden />
        取消
      </Button>
    </div>
  )
}
