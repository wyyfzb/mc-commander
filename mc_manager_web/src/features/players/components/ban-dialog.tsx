/**
 * BanDialog —— 封禁对话框
 * - 封禁类型：玩家封禁 / IP 封禁（IP 封禁要求玩家有 IP 地址）
 * - 时长 6 档：1小时/12小时/1天/7天/30天/永久（服务端 temp_bans 到期自动解封）
 * - 理由 9 项：「其他」展开自定义输入（空回退「其他」）
 * - 附加选项：同时踢出在线玩家（kick 失败不阻断封禁）
 */
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { DangerButton } from '@/components/mcs/danger-button'
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
 * 每次挂载即为全新表单，关闭时卸载，无需 useEffect 清理
 */
function BanFormContent({ player, onConfirm, onOpenChange }: Omit<BanDialogProps, 'open'>) {
  const [targetType, setTargetType] = useState<'player' | 'ip'>('player')
  // 默认最低档时长：永久封禁是不可逆高危默认值，不应作为默认选项（防错原则）
  const [durationIndex, setDurationIndex] = useState(0)
  const [reasonIndex, setReasonIndex] = useState(0) // 默认「作弊」
  const [customReason, setCustomReason] = useState('')
  const [kickFirst, setKickFirst] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ipAvailable = Boolean(player.ip && player.ip.length > 0)
  const selectedDuration = BAN_DURATION_OPTIONS[durationIndex]
  const selectedReason = BAN_REASONS[reasonIndex] ?? BAN_REASONS[0]
  const finalReason = selectedReason === '其他' ? (customReason.trim() || BAN_REASON_FALLBACK) : selectedReason

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
                  ? 'border-mcs-accent bg-mcs-accent-bg-subtle text-mcs-text-default'
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
                  ? 'border-mcs-accent bg-mcs-accent-bg-subtle text-mcs-text-default'
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
                    ? 'border-mcs-accent bg-mcs-accent-bg-subtle text-mcs-text-default'
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
                    ? 'border-mcs-accent bg-mcs-accent-bg-subtle text-mcs-text-default'
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
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
          取消
        </Button>
        <DangerButton onClick={handleConfirm} disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" aria-hidden />}
          封禁{selectedDuration?.label ? `（${selectedDuration.label}）` : ''}
        </DangerButton>
      </DialogFooter>
    </>
  )
}

export function BanDialog({ open, onOpenChange, player, onConfirm }: BanDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <BanFormContent
            key={player.name}
            player={player}
            onConfirm={onConfirm}
            onOpenChange={onOpenChange}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
