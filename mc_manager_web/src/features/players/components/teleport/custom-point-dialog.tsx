/**
 * 添加自定义快捷传送点弹窗：名称 + XYZ。
 * 校验（名称空/坐标非法）由上层 addCustom 执行并 toast，返回是否添加成功；成功后关闭弹窗。
 */
import type { Dispatch, SetStateAction } from 'react'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { Label } from '@/components/ui/label'
import type { CustomPointDraft } from '../../use-quick-teleports'
import { CoordField } from './coord-field'

export interface CustomPointDialogProps {
  draft: CustomPointDraft | null
  onDraftChange: Dispatch<SetStateAction<CustomPointDraft | null>>
  onAdd: (draft: CustomPointDraft) => boolean
  running: boolean
}

export function CustomPointDialog({ draft, onDraftChange, onAdd, running }: CustomPointDialogProps) {
  const handleConfirm = () => {
    if (!draft) return
    if (onAdd(draft)) onDraftChange(null)
  }

  return (
    <ConfirmDialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onDraftChange(null)
      }}
      title="添加快捷传送点"
      description="保存到本地浏览器，可随时一键传送"
      confirmText="添加"
      loading={running}
      onConfirm={handleConfirm}
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="quick-point-name">名称</Label>
          <input
            id="quick-point-name"
            value={draft?.name ?? ''}
            onChange={(e) => onDraftChange((d) => (d ? { ...d, name: e.target.value } : d))}
            placeholder="如：基地、刷怪塔"
            maxLength={24}
            className="w-full rounded-mcs-xs border border-mcs-border-default bg-mcs-bg-default px-2.5 py-1.5 text-mcs-sm text-mcs-text-default placeholder:text-mcs-text-subtle focus:outline-none focus:ring-1 focus:ring-mcs-focus-ring"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <CoordField
            label="X"
            value={draft?.x ?? ''}
            onChange={(v) => onDraftChange((d) => (d ? { ...d, x: v } : d))}
          />
          <CoordField
            label="Y"
            value={draft?.y ?? ''}
            onChange={(v) => onDraftChange((d) => (d ? { ...d, y: v } : d))}
          />
          <CoordField
            label="Z"
            value={draft?.z ?? ''}
            onChange={(v) => onDraftChange((d) => (d ? { ...d, z: v } : d))}
          />
        </div>
      </div>
    </ConfirmDialog>
  )
}
