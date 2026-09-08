/**
 * PlayerConfirmDialogs —— OP/白名单切换与踢出的行内确认（自 player-table.tsx 拆出，纯搬移零行为变更）
 * 确认状态与提交逻辑由主表格持有，本组件仅按 props 渲染两个 ConfirmDialog
 */
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import type { Player } from '@/api/types'
import type { ConfirmToggleState } from './player-table-columns'

interface PlayerConfirmDialogsProps {
  confirmToggle: ConfirmToggleState | null
  confirmPending: boolean
  kickTarget: Player | null
  onCloseToggle: () => void
  onCloseKick: () => void
  onConfirmToggle: () => Promise<void>
  onConfirmKick: () => Promise<void>
}

export function PlayerConfirmDialogs({
  confirmToggle,
  confirmPending,
  kickTarget,
  onCloseToggle,
  onCloseKick,
  onConfirmToggle,
  onConfirmKick,
}: PlayerConfirmDialogsProps) {
  return (
    <>
      {/* OP/白名单切换确认 */}
      <ConfirmDialog
        open={confirmToggle !== null}
        onOpenChange={(open) => {
          if (!open) onCloseToggle()
        }}
        title={
          confirmToggle
            ? confirmToggle.type === 'op'
              ? confirmToggle.player.isOp
                ? '确认取消 OP'
                : '确认设为 OP'
              : confirmToggle.player.isWhitelisted
                ? '确认移除白名单'
                : '确认加入白名单'
            : ''
        }
        description={
          confirmToggle
            ? confirmToggle.type === 'op'
              ? confirmToggle.player.isOp
                ? `即将取消 ${confirmToggle.player.name} 的 OP 权限`
                : `即将设置 ${confirmToggle.player.name} 为 OP`
              : confirmToggle.player.isWhitelisted
                ? `即将移除 ${confirmToggle.player.name} 的白名单`
                : `即将添加 ${confirmToggle.player.name} 至白名单`
            : ''
        }
        confirmText="确认操作"
        loading={confirmPending}
        onConfirm={onConfirmToggle}
      />

      {/* 踢出确认 */}
      <ConfirmDialog
        open={kickTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCloseKick()
        }}
        title="确认踢出"
        description={`即将踢出 ${kickTarget?.name ?? ''}`}
        warning="此操作不可撤销"
        confirmText="确认操作"
        danger
        loading={confirmPending}
        onConfirm={onConfirmKick}
      />
    </>
  )
}
