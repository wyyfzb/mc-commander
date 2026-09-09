/**
 * BanRecordsDialog —— 页面级「封禁记录」弹窗
 * 全量玩家/IP 封禁记录列表 + 30s 轮询（usePlayerBans）+ 逐条解封（确认后按 target+targetType 匹配移除）
 * 状态文案与配色（已解封=灰/永久封禁=error/剩余时间=warning）
 */
import { useState } from 'react'
import { CheckCircle2, Globe, Loader2, User } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { queryKeys } from '@/api/queries'
import { usePlayerBans } from '../queries'
import type { BanRecord } from '@/api/types'
import type { PlayerActionRequest } from '../mutations'

interface BanRecordsDialogProps {
  instanceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 解封等操作回调（错误 toast 由调用方处理） */
  onAction: (req: PlayerActionRequest) => Promise<void>
}

export function BanRecordsDialog({ instanceId, open, onOpenChange, onAction }: BanRecordsDialogProps) {
  const queryClient = useQueryClient()
  const { data: bans, isLoading, isError } = usePlayerBans(instanceId, open)
  const [pardonTarget, setPardonTarget] = useState<BanRecord | null>(null)
  const [running, setRunning] = useState(false)

  /** 解封：确认 → 调用 → toast → invalidate（以服务端真值校准，防在途旧快照复活） */
  const handlePardon = async () => {
    if (!pardonTarget) return
    const target = pardonTarget
    setPardonTarget(null)
    setRunning(true)
    try {
      await onAction({ kind: 'pardonTarget', playerName: target.target, targetType: target.targetType })
      toast.success(`已解封 ${target.target}`)
      await queryClient.invalidateQueries({ queryKey: [...queryKeys.players(instanceId), 'bans'] })
    } catch (e) {
      toast.error(`解封失败：${getFriendlyErrorText(e)}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>封禁记录</DialogTitle>
            <DialogDescription>全部玩家与 IP 封禁记录（每 30 秒自动刷新）</DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] min-h-40 overflow-y-auto">
            {isLoading ? (
              <div className="flex h-40 items-center justify-center text-mcs-text-muted">
                <Loader2 className="size-5 animate-spin" aria-hidden />
              </div>
            ) : isError ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2">
                <p className="text-mcs-sm text-mcs-text-muted">封禁记录加载失败，请稍后重试</p>
              </div>
            ) : bans === undefined || bans.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2">
                <CheckCircle2 className="size-9 text-mcs-success-fg" aria-hidden />
                <p className="text-mcs-sm text-mcs-text-muted">暂无封禁记录</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {bans.map((ban, i) => (
                  <div
                    key={`${ban.targetType}-${ban.target}-${i}`}
                    className="flex items-center gap-3 border-b border-mcs-border-muted px-4 py-2.5 last:border-b-0"
                  >
                    {ban.targetType === 'ip' ? (
                      <Globe
                        className={ban.isActive ? 'size-5 shrink-0 text-mcs-error-fg' : 'size-5 shrink-0 text-mcs-text-muted'}
                        aria-hidden
                      />
                    ) : (
                      <User
                        className={ban.isActive ? 'size-5 shrink-0 text-mcs-error-fg' : 'size-5 shrink-0 text-mcs-text-muted'}
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-mcs-sm font-semibold text-mcs-text-default">
                        {ban.targetType === 'ip' ? `${ban.target} (IP)` : ban.target}
                      </div>
                      <div className="truncate text-mcs-xs text-mcs-text-muted">{ban.reason || '无原因'}</div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end">
                      <BanStatus ban={ban} />
                      <BanTimeText ban={ban} />
                    </div>
                    {ban.isActive && (
                      <Button variant="outline" size="xs" disabled={running} onClick={() => setPardonTarget(ban)}>
                        解封
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 解封确认（danger + 「解封后对方可重新连接」） */}
      <ConfirmDialog
        open={pardonTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPardonTarget(null)
        }}
        title={`解封${pardonTarget?.targetType === 'ip' ? 'IP' : '玩家'}`}
        description={`确定要解封 ${pardonTarget?.target ?? ''} 吗？解封后对方可重新连接。`}
        confirmText="确认解封"
        danger
        loading={running}
        onConfirm={handlePardon}
      />
    </>
  )
}

/** 状态文本与配色 */
function BanStatus({ ban }: { ban: BanRecord }) {
  const cls = (color: string) => `text-mcs-xs font-semibold ${color}`
  if (!ban.isActive) return <span className={cls('text-mcs-text-muted')}>已解封</span>
  if (ban.isPermanent) return <span className={cls('text-mcs-error-fg')}>永久封禁</span>
  if (ban.expiresAt !== null) {
    // 渲染期取当前时间为可接受权衡：剩余时间精度到分钟、随列表数据刷新自然更新，非实时倒计时
    // eslint-disable-next-line react/purity
    const remain = ban.expiresAt - Date.now()
    if (remain < 0) return <span className={cls('text-mcs-warning-fg')}>已到期</span>
    const days = Math.floor(remain / 86_400_000)
    const hours = Math.floor((remain % 86_400_000) / 3_600_000)
    const minutes = Math.floor((remain % 3_600_000) / 60_000)
    if (days >= 1) return <span className={cls('text-mcs-warning-fg')}>剩{days}天{hours}小时</span>
    return <span className={cls('text-mcs-warning-fg')}>剩{hours}小时{minutes}分</span>
  }
  return <span className={cls('text-mcs-warning-fg')}>临时封禁</span>
}

/** 时间文本：生效中 → 到期 MM-dd HH:mm；否则 → 封禁于 createdAt */
function BanTimeText({ ban }: { ban: BanRecord }) {
  if (ban.isActive && ban.expiresAt !== null) {
    const t = new Date(ban.expiresAt)
    const two = (v: number) => String(v).padStart(2, '0')
    return (
      <span className="text-mcs-xs text-mcs-text-muted">
        到期 {two(t.getMonth() + 1)}-{two(t.getDate())} {two(t.getHours())}:{two(t.getMinutes())}
      </span>
    )
  }
  return ban.createdAt.length >= 16 ? (
    <span className="text-mcs-xs text-mcs-text-muted">封禁于 {ban.createdAt.substring(0, 16)}</span>
  ) : null
}
