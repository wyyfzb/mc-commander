/**
 * UpgradeDialog - 实例版本升级弹窗（P0-4）
 * - 服务端类型三卡选择（vanilla/paper/purpur）+ 版本 Select
 * - 警示条（自动备份 + 失败自动回滚）
 * - 进度条经 WS upgradeProgress 事件驱动（upgrade store）
 * - 终态展示（成功/失败/已回滚/已取消），关闭时清空该实例进度
 * - 运行中/同版本/升级中时按钮禁用；升级中唯一出口是「取消升级」（服务端中断 + 必要时回滚）
 *
 * 设计纪律：--mcs-* 语义 token，禁硬编码色值/间距/圆角；
 * 不使用 useEffect+setState（oxlint set-state-in-effect 已清零，勿回潮）。
 */
import { useEffect, useRef, useState } from 'react'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { apiUpgradeInstance, apiGetUpgradeStatus, apiCancelUpgrade } from '@/api/instances'
import { getFriendlyErrorText } from '@/api/errors'
import { getSocketSingleton } from '@/hooks/use-server-socket'
import { useRadioGroup } from '@/hooks/use-radio-group'
import {
  useUpgradeStore,
  UPGRADE_STAGE_LABELS,
  clearUpgradeProgress,
  applyUpgradeProgress,
  isUpgradeTerminal,
  getUpgradeProgress,
} from '@/stores/upgrade'
import { useServerVersions } from '../queries'
import type { InstanceStatus, UpgradeStage } from '@/api/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { ProgressBar } from '@/components/mcs/progress-bar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Loader2,
  ArrowUpCircle,
  CheckCircle2,
  RotateCcw,
  XCircle,
  AlertTriangle,
  Ban,
} from 'lucide-react'
import { toast } from 'sonner'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { instanceLabel } from '@/lib/instance-label'

const SERVER_TYPES = [
  { value: 'vanilla', label: 'Vanilla' },
  { value: 'paper', label: 'Paper' },
  { value: 'purpur', label: 'Purpur' },
] as const

function StageIcon({ stage }: { stage: UpgradeStage }) {
  if (stage === 'completed') return <CheckCircle2 className="h-5 w-5 text-mcs-success-fg" />
  if (stage === 'rolled_back') return <RotateCcw className="h-5 w-5 text-mcs-warning-fg" />
  if (stage === 'failed') return <XCircle className="h-5 w-5 text-mcs-error-fg" />
  if (stage === 'cancelled') return <Ban className="h-5 w-5 text-mcs-text-muted" />
  return <Loader2 className="h-5 w-5 animate-spin text-mcs-accent-fg" />
}

interface UpgradeDialogProps {
  instance: InstanceStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UpgradeDialog({ instance, open, onOpenChange }: UpgradeDialogProps) {
  // ConnectionState extends ConnectionConfig：全 store 即 config（与 queries.ts 同模式）
  const config = useConnectionStore()
  const [type, setType] = useState<'vanilla' | 'paper' | 'purpur'>('vanilla')
  const [mcVersion, setMcVersion] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 取消请求在途（服务端已受理但终态未到）：按钮转「正在取消…」并禁用 */
  const [cancelling, setCancelling] = useState(false)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  const progress = useUpgradeStore((s) => s.progress[instance.id])

  // 派生态：进度存在且未到终态 = 升级进行中（WS 驱动，无需 effect 同步）
  const isTerminal = isUpgradeTerminal(progress?.stage)
  const upgrading = progress != null && !isTerminal

  // 打开弹窗时按需订阅目标实例（服务端按订阅过滤升级进度事件；
  // Set 幂等去重，不退订 —— 避免与 useServerSocket 的当前实例订阅冲突）
  useEffect(() => {
    if (!open) return
    getSocketSingleton()?.subscribe(instance.id)
  }, [open, instance.id])

  // WS 断线时轮询升级状态，WS 恢复或终态时停止
  const socketConnected = useServerStore((s) => s.socketConnected)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!open || !upgrading) {
      // 非升级中或弹窗关闭 → 清理轮询
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      return
    }
    if (socketConnected) {
      // WS 已连接 → 停止轮询
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      return
    }
    // WS 断线 + 升级进行中 → 启动 5s 轮询
    if (!pollingRef.current) {
      pollingRef.current = setInterval(async () => {
        try {
          const status = await apiGetUpgradeStatus(config, instance.id)
          // 陈旧响应守卫：请求在途期间可能已有终态事件到达（WS 恢复/服务端收尾），
          // 此时响应无论说什么都不得推翻终态（清进度会把刚落地的终态块删掉，
          // 陈旧的 upgrading:true 会把终态倒回「升级中」）
          if (isUpgradeTerminal(getUpgradeProgress(instance.id)?.stage)) return
          if (status.upgrading && status.stage && status.percent != null) {
            applyUpgradeProgress({
              instanceId: instance.id,
              stage: status.stage as UpgradeStage,
              percent: status.percent,
              detail: status.detail ?? '',
              timestamp: Date.now(),
            })
          } else {
            // 空态即服务端真值：已不在升级（终态/被取消/服务重启），本会话不该继续
            // 声称「升级中」——否则弹窗停在进度视图且关闭被禁，用户被卡死（尤其取消
            // 走的是 HTTP、结果只由 WS 播报时）。终态文案由通知中心在实时通道恢复后
            // 补齐（长任务终态事件均落库），故这里清掉本地进度不算丢信息
            clearUpgradeProgress(instance.id)
          }
        } catch {
          // 轮询失败静默，下次 5s 重试
        }
      }, 5000)
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [open, upgrading, socketConnected, config, instance.id])

  const versionsQuery = useServerVersions(type)
  const versions: string[] = versionsQuery.isSuccess ? (versionsQuery.data?.versions ?? []) : []

  const isSuccess = progress?.stage === 'completed'
  const isRolledBack = progress?.stage === 'rolled_back'
  const isCancelled = progress?.stage === 'cancelled'

  /**
   * 取消升级（服务端中断备份等待/下载/首启校验；替换之后会先回滚到旧版本）。
   * 只负责发请求：结果以 cancelled 终态事件为准，此处不乐观置终态——受理不等于
   * 已中断，乐观置终态会在中断未生效时谎报取消
   */
  const handleCancelUpgrade = async () => {
    setCancelConfirmOpen(false)
    setCancelling(true)
    try {
      await apiCancelUpgrade(config, instance.id)
      toast.success('已请求取消升级')
    } catch (err) {
      setCancelling(false)
      toast.error(`取消升级失败：${getFriendlyErrorText(err)}`)
    }
  }

  /** 类型切换与版本重置合并为一次事件驱动更新（不走 useEffect） */
  const handleTypeChange = (next: 'vanilla' | 'paper' | 'purpur') => {
    setType(next)
    setMcVersion('')
  }

  // 服务端类型是单选组：语义与方向键由 hook 统一提供（切换仍走 handleTypeChange 以连带重置版本）
  const typeGroup = useRadioGroup<'vanilla' | 'paper' | 'purpur'>({
    label: '服务端类型',
    value: type,
    values: SERVER_TYPES.map((t) => t.value),
    onChange: handleTypeChange,
  })

  const handleUpgrade = async () => {
    if (!mcVersion || mcVersion === instance.mcVersion) return
    setStarting(true)
    setError(null)
    // 新一轮升级不受上一轮取消标记影响（否则进度视图里的按钮一出现就是「正在取消…」）
    setCancelling(false)
    try {
      await apiUpgradeInstance(config, instance.id, { mcVersion, type })
      // 202 受理后由 WS upgradeProgress 驱动界面
    } catch (err) {
      setError(getFriendlyErrorText(err))
    } finally {
      setStarting(false)
    }
  }

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      // 升级进行中禁止关闭（终态/未开始可关），关闭即清空该实例进度
      if (upgrading || starting) return
      setError(null)
      clearUpgradeProgress(instance.id)
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="h-5 w-5" aria-hidden />
            {`升级 ${instanceLabel(instance)}`}
          </DialogTitle>
          <DialogDescription>
            {`${instanceLabel(instance)} · 当前版本 ${instance.mcVersion}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 警示条 */}
          <NoticeBanner variant="warning" form="card" icon={AlertTriangle}>
            <p className="font-medium">升级须知</p>
            <p className="mt-1 text-mcs-text-muted">
              升级前自动创建备份，随后下载并替换服务端 JAR，启动校验失败将自动回滚。
            </p>
          </NoticeBanner>

          {/* 升级进行中：进度 + 取消入口（升级中唯一的可用出口） */}
          {upgrading && progress && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <StageIcon stage={progress.stage} />
                <span className="text-sm font-medium">{UPGRADE_STAGE_LABELS[progress.stage]}</span>
                {progress.percent > 0 && (
                  <span className="text-xs text-mcs-text-muted">{progress.percent}%</span>
                )}
              </div>
              {progress.percent > 0 && <ProgressBar percent={progress.percent} />}
              {progress.detail && <p className="text-xs text-mcs-text-muted">{progress.detail}</p>}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCancelConfirmOpen(true)}
                disabled={cancelling}
                aria-label={cancelling ? '正在取消升级' : '取消升级'}
              >
                {cancelling ? '正在取消…' : '取消升级'}
              </Button>
            </div>
          )}

          {/* 终态展示 */}
          {isTerminal && progress && (
            <div
              className={`rounded-mcs-sm border p-4 ${
                isSuccess
                  ? 'border-mcs-success-border bg-mcs-bg-muted'
                  : isCancelled
                    ? 'border-mcs-border-muted bg-mcs-bg-muted'
                    : 'border-mcs-error-border bg-mcs-bg-muted'
              }`}
            >
              <div className="flex items-center gap-2">
                <StageIcon stage={progress.stage} />
                <span
                  className={`font-medium ${
                    isSuccess
                      ? 'text-mcs-success-fg'
                      : isRolledBack
                        ? 'text-mcs-warning-fg'
                        : isCancelled
                          ? 'text-mcs-text-muted'
                          : 'text-mcs-error-fg'
                  }`}
                >
                  {progress.detail || UPGRADE_STAGE_LABELS[progress.stage]}
                </span>
              </div>
            </div>
          )}

          {/* 版本选择（升级进行中/终态隐藏） */}
          {!progress && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">服务端类型</label>
                <div className="grid grid-cols-3 gap-2" {...typeGroup.groupProps}>
                  {SERVER_TYPES.map((t, index) => (
                    <button
                      key={t.value}
                      type="button"
                      {...typeGroup.itemProps(index)}
                      onClick={() => handleTypeChange(t.value)}
                      className={`rounded-mcs-sm border p-2 text-center text-sm transition-colors ${
                        type === t.value
                          ? 'border-mcs-accent-fg bg-mcs-accent-bg-subtle text-mcs-accent-fg'
                          : 'border-mcs-border-muted hover:bg-mcs-state-hover'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">目标版本</label>
                <Select value={mcVersion} onValueChange={setMcVersion}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择版本" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v} value={v} disabled={v === instance.mcVersion}>
                        {v}
                        {v === instance.mcVersion ? '（当前）' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* 错误 */}
          {error && (
            <p className="text-sm text-mcs-error-fg" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          {isTerminal ? (
            <Button onClick={() => handleClose(false)}>关闭</Button>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => handleClose(false)}
                disabled={upgrading || starting}
              >
                取消
              </Button>
              <Button
                onClick={handleUpgrade}
                disabled={!mcVersion || mcVersion === instance.mcVersion || upgrading || starting}
              >
                {starting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                开始升级
              </Button>
            </div>
          )}
        </DialogFooter>

        {/* 取消升级确认：替换阶段之后服务端会回滚到旧版本，故二次确认 */}
        <ConfirmDialog
          open={cancelConfirmOpen}
          onOpenChange={setCancelConfirmOpen}
          title="取消升级？"
          description="将中断备份等待、下载或启动校验；若服务端 JAR 已被替换，会先回滚到原版本。"
          cancelText="继续升级"
          confirmText="中断升级"
          danger
          onConfirm={() => void handleCancelUpgrade()}
        />
      </DialogContent>
    </Dialog>
  )
}
