/**
 * DeployDialog 结果视图：部署中 / 成功 / 失败 / 已取消（从 deploy-dialog.tsx 行为不变迁移）
 * - 部署中：进度条（percent×100）+ stage 中文标签（DEPLOY_STAGE_LABELS）+ transferred/total MB
 *   +「取消部署」（服务端中断下载/安装/首启并清理实例目录）
 * - 成功：绿色结果块（实例 id/名称/版本）+ 自动启动状态（首启闭环，issue 312）+「完成」
 * - 失败：error 块 + 取消/重试
 * - 已取消：中性结果块 + 关闭/重新部署（用户动作而非故障，故不占 error 档）
 */
import { Ban, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { SERVER_TYPE_LABELS, recommendedJavaVersion, type ServerType } from '@/lib/mc-deploy'
import { DEPLOY_STAGE_LABELS } from '@/stores/deploy'
import type { DeployProgress, DeployResult } from '@/api/types'
import type { AutoStartState } from './types'
import { formatMB } from './utils'
import { NoticeBanner } from '@/components/mcs/notice-banner'

interface DeployProgressViewProps {
  progress: DeployProgress | null
  /** 取消请求在途（按钮转「正在取消…」并禁用，避免重复请求） */
  cancelling: boolean
  onCancel: () => void
}

/** 部署中视图：进度条 + 阶段文案 + 传输量（进度为 null 时显示不确定占位）+ 取消入口 */
export function DeployProgressView({ progress, cancelling, onCancel }: DeployProgressViewProps) {
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
        className="h-1.5 w-full overflow-hidden rounded-full bg-mcs-bg-secondary"
      >
        <div
          className="h-full w-full rounded-full bg-mcs-accent transition-transform duration-mcs-base"
          style={{ transform: `translateX(${pct - 100}%)` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-mcs-sm text-mcs-text-muted" aria-live="polite">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {stageLabel}
        </p>
        {pct > 0 && <p className="text-mcs-xs text-mcs-text-muted">{pct}%</p>}
      </div>
      {showTransfer && progress != null && (
        <p className="text-mcs-xs text-mcs-text-muted">
          已下载 {formatMB(progress.transferred)} / {formatMB(progress.total)} MB
        </p>
      )}
      {stageError != null && (
        <p className="text-mcs-xs text-mcs-error-fg">部署失败：{stageError}</p>
      )}
      <DialogFooter>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={cancelling}
          aria-label={cancelling ? '正在取消部署' : '取消部署'}
        >
          {cancelling ? '正在取消…' : '取消部署'}
        </Button>
      </DialogFooter>
    </div>
  )
}

interface DeploySuccessViewProps {
  result: DeployResult
  /** 自动启动状态（null = 未同意 EULA，未尝试启动——此时必须交代「尚未启动」） */
  autoStart: AutoStartState
  onComplete: () => void
}

/** 成功视图：结果块（实例 id/名称/版本/Java 推荐）+ 自动启动状态 +「完成」 */
export function DeploySuccessView({ result, autoStart, onComplete }: DeploySuccessViewProps) {
  return (
    <div className="flex flex-col gap-3">
      <NoticeBanner variant="success" form="card" icon={CheckCircle2}>
        <div className="flex flex-col gap-0.5">
          <p className="font-medium">部署成功</p>
          <p className="text-mcs-text-muted">实例 ID：{result.id}</p>
          <p className="text-mcs-text-muted">名称：{result.name}</p>
          <p className="text-mcs-text-muted">
            服务端：{SERVER_TYPE_LABELS[result.type as ServerType] ?? result.type}{' '}
            {result.mcVersion}
          </p>
          <p className="text-mcs-text-muted">
            推荐 Java 版本：{recommendedJavaVersion(result.mcVersion)}
          </p>
        </div>
      </NoticeBanner>
      {/* autoStart === null 表示「未同意 EULA，故未尝试启动」。
          此前这一支**什么都不渲染**：用户只看到「部署成功」，没有任何线索表明
          服务器还起不来，直到去点「启动」才被拦下——而那一刻被呈现为「启动失败」。
          结果必须交代清楚，否则「成功」是误导。 */}
      {autoStart === null ? (
        <NoticeBanner variant="info" icon={Info}>
          实例已创建，但服务器尚未启动：Minecraft 要求先同意 EULA 才能运行。
          到实例页点「启动」会弹出同意提示，同意后即自动开始运行。
        </NoticeBanner>
      ) : (
        <NoticeBanner
          /* pending 是中性在途态（既非成功也非失败）——走 neutral 档而非 info 蓝：
             染成 info 会读成「有消息要看」，而它要说的只是「还没结束，请稍候」 */
          variant={autoStart === 'ok' ? 'success' : autoStart === 'failed' ? 'warning' : 'neutral'}
          icon={autoStart === 'pending' ? Loader2 : autoStart === 'ok' ? CheckCircle2 : XCircle}
          iconClassName={autoStart === 'pending' ? 'animate-spin' : undefined}
        >
          <span aria-live="polite">
            {autoStart === 'pending' && '正在启动服务器…'}
            {autoStart === 'ok' && '已发送启动指令，服务器正在启动（状态可在仪表盘查看）'}
            {autoStart === 'failed' && '自动启动失败，可稍后在实例页手动启动'}
          </span>
        </NoticeBanner>
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
      <NoticeBanner variant="error" icon={XCircle} role="alert">
        {errorText}
      </NoticeBanner>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button onClick={onRetry}>重试</Button>
      </DialogFooter>
    </div>
  )
}

interface DeployCancelledViewProps {
  /** 服务端收尾结果（清理失败时的明细）；缺省表示实例目录已清理完毕 */
  cleanupError?: string
  onClose: () => void
  onRetry: () => void
}

/** 已取消视图：中性结果块（用户主动取消不是故障）+ 关闭 / 重新部署（回到步骤①保留表单值） */
export function DeployCancelledView({ cleanupError, onClose, onRetry }: DeployCancelledViewProps) {
  return (
    <div className="flex flex-col gap-3">
      <NoticeBanner variant="info" form="card" icon={Ban}>
        <div className="flex flex-col gap-0.5">
          {/* 收尾是 best-effort：目录可能仍被正在退出的进程占用，删除失败时如实说明，
              不宣称「已清理」（否则用户按提示以为磁盘已干净） */}
          <p>部署已取消{cleanupError == null ? '，未完成的实例目录已清理。' : '。'}</p>
          {cleanupError != null && (
            <p className="text-mcs-text-muted">收尾未完成：{cleanupError}</p>
          )}
        </div>
      </NoticeBanner>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
        <Button onClick={onRetry}>重新部署</Button>
      </DialogFooter>
    </div>
  )
}
