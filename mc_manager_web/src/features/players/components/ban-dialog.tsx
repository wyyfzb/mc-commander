/**
 * BanDialog —— 封禁对话框
 * - 封禁类型：玩家封禁 / IP 封禁（IP 封禁要求玩家有 IP 地址）
 * - 时长 6 档：1小时/12小时/1天/7天/30天/永久（服务端 temp_bans 到期自动解封）
 * - 理由 9 项：「其他」展开自定义输入（空回退「其他」）
 * - 附加选项：同时踢出在线玩家（kick 失败不阻断封禁）
 * - 脏状态关闭拦截：自定义理由有未提交输入时，ESC/遮罩/X/取消先弹确认（对齐 task-dialog 范式）；
 *   其余选项均有安全默认值，不构成可丢失输入
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { LoadingButton } from '@/components/mcs/loading-button'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { cn } from '@/lib/utils'
import { BAN_DURATION_OPTIONS, BAN_REASONS, BAN_REASON_FALLBACK, validateBanForm, type BanFormModel } from '@/lib/mc-ban'
import type { Player } from '@/api/types'

interface BanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  player: Player
  /** 确认回调（页面提供：ban mutation + 可选 kick + toast） */
  onConfirm: (model: BanFormModel) => Promise<void>
}

/**
 * 表单内容（key=player.name 驱动重置，避免 setState-in-effect）
 * 每次挂载即为全新表单，关闭时卸载：确认弹窗等局部状态随之自动重置
 */
function BanFormContent({
  player,
  onConfirm,
  onRequestClose,
  onOpenChange,
  dirtyRef,
  confirmRequestRef,
}: {
  player: Player
  onConfirm: (model: BanFormModel) => Promise<void>
  /** 取消按钮路径：脏状态时由外层弹确认 */
  onRequestClose: () => void
  /** 提交成功关闭：直接关不确认 */
  onOpenChange: (open: boolean) => void
  /** 脏状态同步到外层（外层据此拦截关闭；ref 避免驱动重渲染） */
  dirtyRef: RefObject<boolean>
  /** 向外层注册「请求弹关闭确认」入口（外层拦截到关闭请求时调用） */
  confirmRequestRef: RefObject<() => void>
}) {
  const [targetType, setTargetType] = useState<'player' | 'ip'>('player')
  // 默认最低档时长：永久封禁是不可逆高危默认值，不应作为默认选项（防错原则）
  const [durationIndex, setDurationIndex] = useState(0)
  const [reasonIndex, setReasonIndex] = useState(0) // 默认「作弊」
  const [customReason, setCustomReason] = useState('')
  const [kickFirst, setKickFirst] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)

  const ipAvailable = Boolean(player.ip && player.ip.length > 0)
  const selectedDuration = BAN_DURATION_OPTIONS[durationIndex]
  const selectedReason = BAN_REASONS[reasonIndex] ?? BAN_REASONS[0]
  const finalReason = selectedReason === '其他' ? (customReason.trim() || BAN_REASON_FALLBACK) : selectedReason

  // 仅自定义理由是可丢失的自由输入；理由未选「其他」或输入为空白时提交不依赖它
  const closeDirty = selectedReason === '其他' && customReason.trim().length > 0
  useEffect(() => {
    dirtyRef.current = closeDirty
  }, [closeDirty, dirtyRef])
  // 确认弹窗状态留在本组件（随卸载自动重置，无残留），外层经 ref 请求弹出
  useEffect(() => {
    confirmRequestRef.current = () => setConfirmClose(true)
    return () => {
      confirmRequestRef.current = () => {}
    }
  }, [confirmRequestRef])

  const handleConfirm = async () => {
    const model: BanFormModel = {
      targetType,
      duration: selectedDuration?.value ?? null,
      reason: finalReason,
      kickFirst,
    }
    const validationError = validateBanForm(model, player.ip)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await onConfirm(model)
      onOpenChange(false)
    } catch {
      // 错误 toast 由调用方处理；保持弹窗打开供调整
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>封禁 {player.name}</DialogTitle>
        <DialogDescription>
          {player.isOnline ? '该玩家当前在线，可同时踢出。' : '该玩家当前离线。'}
          临时封禁到期后服务端自动解封。
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        {/* 封禁类型 */}
        <div className="flex flex-col gap-2">
          <Label>封禁类型</Label>
          <RadioGroup
            value={targetType}
            onValueChange={(v) => {
              setTargetType(v as 'player' | 'ip')
              setError(null)
            }}
            className="flex gap-2"
          >
            <label
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-mcs-sm border px-3 py-1.5 text-mcs-sm transition-colors',
                targetType === 'player'
                  ? 'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle text-mcs-text-default'
                  : 'border-mcs-border-default text-mcs-text-muted hover:bg-mcs-bg-hover',
              )}
            >
              <RadioGroupItem value="player" className="sr-only" />
              玩家封禁
            </label>
            <label
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-mcs-sm border px-3 py-1.5 text-mcs-sm transition-colors',
                !ipAvailable && 'cursor-not-allowed opacity-50',
                targetType === 'ip'
                  ? 'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle text-mcs-text-default'
                  : 'border-mcs-border-default text-mcs-text-muted hover:bg-mcs-bg-hover',
              )}
            >
              <RadioGroupItem value="ip" className="sr-only" disabled={!ipAvailable} />
              IP 封禁
            </label>
          </RadioGroup>
          {!ipAvailable && (
            <p className="text-mcs-xs text-mcs-text-subtle">该玩家暂无 IP 信息，无法 IP 封禁</p>
          )}
        </div>

        {/* 时长 6 档 */}
        <div className="flex flex-col gap-2">
          <Label>时长</Label>
          <div className="flex flex-wrap gap-1.5">
            {BAN_DURATION_OPTIONS.map((option, i) => (
              <button
                key={option.label}
                type="button"
                onClick={() => setDurationIndex(i)}
                aria-pressed={durationIndex === i}
                className={cn(
                  'rounded-mcs-sm border px-2.5 py-1 text-mcs-xs transition-colors',
                  durationIndex === i
                    ? 'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle text-mcs-text-default'
                    : 'border-mcs-border-default text-mcs-text-muted hover:bg-mcs-bg-hover',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* 理由 9 项 */}
        <div className="flex flex-col gap-2">
          <Label>理由</Label>
          <div className="flex flex-wrap gap-1.5">
            {BAN_REASONS.map((reason, i) => (
              <button
                key={reason}
                type="button"
                onClick={() => setReasonIndex(i)}
                aria-pressed={reasonIndex === i}
                className={cn(
                  'rounded-mcs-sm border px-2.5 py-1 text-mcs-xs transition-colors',
                  reasonIndex === i
                    ? 'border-mcs-accent-border-strong bg-mcs-accent-bg-subtle text-mcs-text-default'
                    : 'border-mcs-border-default text-mcs-text-muted hover:bg-mcs-bg-hover',
                )}
              >
                {reason}
              </button>
            ))}
          </div>
          {selectedReason === '其他' && (
            <Textarea
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              placeholder={`自定义理由（留空使用「${BAN_REASON_FALLBACK}」）`}
              rows={2}
              maxLength={200}
              className="mt-1"
            />
          )}
        </div>

        {/* 同时踢出 */}
        {player.isOnline && (
          <label className="flex cursor-pointer items-center gap-2 text-mcs-sm text-mcs-text-muted">
            <Checkbox checked={kickFirst} onCheckedChange={(v) => setKickFirst(v === true)} />
            同时踢出在线玩家（kick 失败不阻断封禁）
          </label>
        )}

        {error && <p className="text-mcs-sm text-mcs-error-fg">{error}</p>}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onRequestClose} disabled={submitting}>
          取消
        </Button>
        <LoadingButton variant="destructive" loading={submitting} onClick={handleConfirm}>
          封禁{selectedDuration?.label ? `（${selectedDuration.label}）` : ''}
        </LoadingButton>
      </DialogFooter>

      {/* dirty 关闭确认：确认状态留在表单内容层，随卸载自动重置 */}
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={(next) => {
          if (!next) setConfirmClose(false)
        }}
        title="放弃未保存的修改？"
        description="自定义理由尚未提交，关闭对话框将丢失输入内容。"
        confirmText="放弃修改"
        cancelText="继续编辑"
        onConfirm={() => {
          setConfirmClose(false)
          onOpenChange(false)
        }}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  )
}

export function BanDialog({ open, onOpenChange, player, onConfirm }: BanDialogProps) {
  const closeDirtyRef = useRef(false)
  /** 表单内容注册的「弹关闭确认」入口（open=false 时随卸载解绑） */
  const confirmRequestRef = useRef<() => void>(() => {})

  /** 所有关闭路径（遮罩/ESC/X/取消）统一入口：有未提交输入 → 确认，否则直接关 */
  const requestClose = (next: boolean) => {
    if (next || !closeDirtyRef.current) {
      onOpenChange(next)
      return
    }
    confirmRequestRef.current()
  }

  // 弹窗关闭后重置脏标记，下次打开重新评估（写 ref 不驱动渲染）
  useEffect(() => {
    if (!open) {
      closeDirtyRef.current = false
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <BanFormContent
            key={player.name}
            player={player}
            onConfirm={onConfirm}
            onRequestClose={() => requestClose(false)}
            onOpenChange={onOpenChange}
            dirtyRef={closeDirtyRef}
            confirmRequestRef={confirmRequestRef}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
