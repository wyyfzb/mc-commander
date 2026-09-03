/**
 * DeployDialog 三态结果视图：部署中 / 成功 / 失败（从 deploy-dialog.tsx 行为不变迁移）
 * - 部署中：进度条（percent×100）+ stage 中文标签（DEPLOY_STAGE_LABELS）+ transferred/total MB
 * - 成功：绿色结果块（实例 id/名称/版本）+ 自动启动状态（首启闭环，issue 312）+「完成」
 * - 失败：error 块 + 取消/重试
 */
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { SERVER_TYPE_LABELS, recommendedJavaVersion, type ServerType } from '@/lib/mc-deploy'
import { DEPLOY_STAGE_LABELS } from '@/stores/deploy'
import type { DeployProgress, DeployResult } from '@/api/types'
import type { AutoStartState } from './types'
import { formatMB } from './utils'

/** 部署中视图：进度条 + 阶段文案 + 传输量（进度为 null 时显示不确定占位） */
export function DeployProgressView({ progress }: { progress: DeployProgress | null }) {
  const pct = progress != null ? Math.round(progress.percent * 100) : 0
  const stageLabel = progress
    ? (DEPLOY_STAGE_LABELS[progress.stage] ?? progress.stage)
    : '正在部署…'
  const showTransfer = progress != null && progress.total > 0
  const stageError = progress?.stage === 'error' ? progress.error : undefined

  return (
    <div className="flex flex-col gap-2.5">
      <div
        role="progressbar"
        aria-label="部署进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 w-full overflow-hidden rounded-full bg-mcs-bg-hover"
      >
        <div
          className="h-full rounded-full bg-mcs-accent transition-[width] duration-mcs-base"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-mcs-sm text-mcs-text-muted" aria-live="polite">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {stageLabel}
        </p>
        {pct > 0 && <p className="text-mcs-xs text-mcs-text-subtle">{pct}%</p>}
      </div>
      {showTransfer && progress != null && (
        <p className="text-mcs-xs text-mcs-text-subtle">
          已下载 {formatMB(progress.transferred)} / {formatMB(progress.total)} MB
        </p>
      )}
      {stageError != null && (
        <p className="text-mcs-xs text-mcs-error-fg">部署失败：{stageError}</p>
      )}
    </div>
  )
}

interface DeploySuccessViewProps {
  result: DeployResult
  /** 自动启动状态（null = 未勾选 EULA，不展示状态块） */
  autoStart: AutoStartState
  onComplete: () => void
}

/** 成功视图：结果块（实例 id/名称/版本/Java 推荐）+ 自动启动状态 +「完成」 */
export function DeploySuccessView({ result, autoStart, onComplete }: DeploySuccessViewProps) {
  return (
    <div className="flex flex-col gap-3">
      <div
        role="status"
        className="flex items-start gap-2 rounded-mcs-sm border border-mcs-success-border bg-mcs-success-bg-subtle px-3 py-2.5"
      >
        <CheckCircle2 className="mt-px size-4 shrink-0 text-mcs-success-fg" aria-hidden />
        <div className="flex flex-col gap-0.5 text-mcs-sm">
          <p className="font-medium text-mcs-success-fg">部署成功</p>
          <p className="text-mcs-text-muted">实例 ID：{result.id}</p>
          <p className="text-mcs-text-muted">名称：{result.name}</p>
          <p className="text-mcs-text-muted">
            服务端：{SERVER_TYPE_LABELS[result.type as ServerType] ?? result.type} {result.mcVersion}
          </p>
          <p className="text-mcs-text-muted">
            推荐 Java 版本：{recommendedJavaVersion(result.mcVersion)}
          </p>
        </div>
      </div>
      {autoStart !== null && (
        <div
          role="status"
          className={cn(
            'flex items-center gap-2 rounded-mcs-sm border px-3 py-2 text-mcs-sm',
            autoStart === 'ok' && 'border-mcs-success-border bg-mcs-success-bg-subtle text-mcs-success-fg',
            autoStart === 'pending' && 'border-mcs-border-muted bg-mcs-bg-muted text-mcs-text-muted',
            autoStart === 'failed' && 'border-mcs-warning-border bg-mcs-warning-bg-subtle text-mcs-warning-fg',
          )}
        >
          {autoStart === 'pending' && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
          {autoStart === 'ok' && <CheckCircle2 className="size-4 shrink-0" aria-hidden />}
          {autoStart === 'failed' && <XCircle className="size-4 shrink-0" aria-hidden />}
          <p aria-live="polite">
            {autoStart === 'pending' && '正在启动服务器…'}
            {autoStart === 'ok' && '已发送启动指令，服务器正在启动（状态可在仪表盘查看）'}
            {autoStart === 'failed' && '自动启动失败，可稍后在实例页手动启动'}
          </p>
        </div>
      )}
      <DialogFooter>
        <Button onClick={onComplete}>完成</Button>
      </DialogFooter>
    </div>
  )
}

interface DeployErrorViewProps {
  errorText: string
  onCancel: () => void
  onRetry: () => void
}

/** 失败视图：error 块 + 取消 / 重试（重试由编排层回到步骤①并保留表单值） */
export function DeployErrorView({ errorText, onCancel, onRetry }: DeployErrorViewProps) {
  return (
    <div className="flex flex-col gap-3">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-mcs-sm border border-mcs-error-border bg-mcs-error-bg-subtle px-3 py-2.5"
      >
        <XCircle className="mt-px size-4 shrink-0 text-mcs-error-fg" aria-hidden />
        <p className="text-mcs-sm text-mcs-error-fg">{errorText}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button onClick={onRetry}>重试</Button>
      </DialogFooter>
    </div>
  )
}
