/**
 * UploadProgressBar —— 上传进度条（自 plugins-page.tsx 迁出，纯移动零行为变更）
 * 顺序队列展示：当前文件名 + 队列剩余 + 进度百分比 + 取消按钮
 */
import { FileText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface UploadProgressBarProps {
  /** 上传中条目（顺序队列同一时刻仅一个活跃） */
  uploading: { name: string; pct: number }
  /** 上传队列剩余数量（含活跃项） */
  queueRemaining: number
  onCancel: () => void
}

export function UploadProgressBar({ uploading, queueRemaining, onCancel }: UploadProgressBarProps) {
  return (
    <div
      className="flex items-center gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted px-4 py-3"
      data-testid="upload-progress"
      aria-live="polite"
    >
      <FileText className="size-4 shrink-0 text-mcs-accent" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-mcs-sm text-mcs-text-default" title={uploading.name}>
            正在上传 {uploading.name}
            {queueRemaining > 1 && (
              <span className="ml-1.5 text-mcs-xs text-mcs-text-subtle">（队列剩余 {queueRemaining - 1} 个）</span>
            )}
          </p>
          <span className="text-mcs-xs tabular-nums text-mcs-text-muted">{uploading.pct}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="上传进度"
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
      <Button variant="ghost" size="sm" onClick={onCancel}>
        <X className="size-3.5" aria-hidden />
        取消
      </Button>
    </div>
  )
}
