import type { ReactNode } from 'react'
import { Pencil, X } from 'lucide-react'

export interface QuickChipProps {
  name: string
  coords: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  onDelete?: () => void
  onEdit?: () => void
}

/** 快捷传送点 chip：名称行 + 坐标行，可带编辑/删除操作 */
export function QuickChip({ name, coords, icon, onClick, disabled, onDelete, onEdit }: QuickChipProps) {
  return (
    <div className="inline-flex items-start gap-1 rounded-mcs-md border border-mcs-border-default bg-mcs-bg-default px-2.5 py-1.5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex min-w-0 flex-col items-start gap-0.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="inline-flex items-center gap-1 text-mcs-xs font-medium text-mcs-text-default">
          <span className="text-mcs-accent-fg" aria-hidden>
            {icon}
          </span>
          {name}
        </span>
        <span className="pl-4 font-mono text-mcs-2xs text-mcs-text-subtle">{coords}</span>
      </button>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`编辑${name}`}
          className="mt-0.5 rounded-mcs-xs p-0.5 text-mcs-text-subtle transition-colors hover:text-mcs-text-default"
        >
          <Pencil className="size-3" aria-hidden />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`删除${name}`}
          className="mt-0.5 rounded-mcs-xs p-0.5 text-mcs-text-subtle transition-colors hover:text-mcs-error-fg"
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </div>
  )
}
