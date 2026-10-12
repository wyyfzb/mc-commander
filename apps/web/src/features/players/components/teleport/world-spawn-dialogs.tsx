/**
 * 修改世界出生点两步弹窗：第一步坐标输入（非法值拦截）→ 第二步确认后执行。
 * setworldspawn 是服务器全局命令，无论单/批量只执行一次，执行走 onSave（成功后由上层关闭确认弹窗）。
 */
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import type { Dispatch, SetStateAction } from 'react'
import type { TeleportPoint } from '@/lib/mc-teleport'
import { CoordField } from './coord-field'
import { formatCoords } from './teleport-utils'

export type WorldSpawnDraft = { x: string; y: string; z: string }

export interface WorldSpawnDialogsProps {
  worldSpawn: TeleportPoint
  draft: WorldSpawnDraft | null
  onDraftChange: Dispatch<SetStateAction<WorldSpawnDraft | null>>
  confirm: TeleportPoint | null
  onConfirmChange: Dispatch<SetStateAction<TeleportPoint | null>>
  onSave: (point: TeleportPoint) => void
  running: boolean
}

export function WorldSpawnDialogs({
  worldSpawn,
  draft,
  onDraftChange,
  confirm,
  onConfirmChange,
  onSave,
  running,
}: WorldSpawnDialogsProps) {
  /** 第一步保存：校验坐标合法后进入二次确认 */
  const handleDraftConfirm = () => {
    if (!draft) return
    const x = Number.parseFloat(draft.x)
    const y = Number.parseFloat(draft.y)
    const z = Number.parseFloat(draft.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      toast.error('请输入有效的坐标数值')
      return
    }
    onConfirmChange({ x, y, z })
    onDraftChange(null)
  }

  return (
    <>
      {/* ── 第一步：坐标输入 ── */}
      <ConfirmDialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) onDraftChange(null)
        }}
        title="修改世界出生点"
        description={`当前世界出生点：(${formatCoords(worldSpawn)})`}
        confirmText="保存"
        loading={running}
        onConfirm={handleDraftConfirm}
      >
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
      </ConfirmDialog>

      {/* ── 第二步：二次确认 ── */}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) onConfirmChange(null)
        }}
        title="确认修改世界出生点"
        description={
          confirm
            ? `确定要将世界出生点修改为 (${Math.round(confirm.x)}, ${Math.round(confirm.y)}, ${Math.round(confirm.z)}) 吗？`
            : ''
        }
        confirmText="确认修改"
        loading={running}
        onConfirm={() => {
          if (confirm) onSave(confirm)
        }}
      />
    </>
  )
}
