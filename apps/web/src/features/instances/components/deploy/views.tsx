/**
 * DeployDialog 结果视图：部署中 / 成功 / 失败 / 已取消
 * - 部署中：进度条（percent×100）+ stage 中文标签（DEPLOY_STAGE_LABELS）+ transferred/total MB
 *   +「取消部署」（服务端中断下载/安装/首启并清理实例目录）
 * - 成功：绿色结果块（实例 id/名称/版本）+ 自动启动状态（首启闭环）+ 收尾未完成项
 *   + 白名单提示（新实例默认已开白名单、名单为空则谁都进不去；服务器启动后先加人）+「完成」
 * - 失败：error 块 + 取消/重试
 * - 已取消：中性结果块 + 关闭/重新部署（用户动作而非故障，故不占 error 档）
 */
import { AlertTriangle, Ban, CheckCircle2, Info, Loader2, UserPlus, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { SERVER_TYPE_LABELS, recommendedJavaVersion, type ServerType } from '@/lib/mc-deploy'
import { DEPLOY_STAGE_LABELS } from '@/stores/deploy'
import type { DeployProgress, DeployResult } from '@/api/types'
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
  // detail 优先：带版本号的阶段（如「正在准备 Java 21…」）无法用固定标签表达
  const stageLabel = progress
    ? (progress.detail ?? DEPLOY_STAGE_LABELS[progress.stage] ?? progress.stage)
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
  eulaAgreed: boolean
  onComplete: () => void
}

/** 成功视图：结果块（实例 id/名称/版本/Java 推荐）+ 自动启动状态 +「完成」 */
export function DeploySuccessView({ result, eulaAgreed, onComplete }: DeploySuccessViewProps) {
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
      {!eulaAgreed ? (
        <NoticeBanner variant="info" icon={Info}>
          实例已创建，但服务器尚未启动：Minecraft 要求先同意 EULA 才能运行。
          到实例页点「启动」会弹出同意提示，同意后即自动开始运行。
        </NoticeBanner>
      ) : result.started ? (
        <NoticeBanner variant="neutral" icon={Info}>
          服务器进程已启动，是否就绪请在实例卡片上查看。
        </NoticeBanner>
      ) : (
        <NoticeBanner variant="warning" icon={XCircle}>
          自动启动失败，可稍后在实例页手动启动
        </NoticeBanner>
      )}
      {/* 收尾未完成项：部署本身成功，但这些事没做成，用户必须知道。
          只发 toast 不够——toast 会自动消失，而「实例重启后会从列表消失」这类
          后果需要留在结果块里可回看。 */}
      {result.warnings.length > 0 && (
        <NoticeBanner variant="warning" form="card" icon={AlertTriangle}>
          <p className="font-medium">部署已完成，但有以下未完成项</p>
          <ul className="list-disc pl-4 text-mcs-text-muted">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </NoticeBanner>
      )}
      {/* 新实例必然处于「白名单已开 + 名单为空」：部署写的 server.properties 跟随上游默认
          （white-list=true），而部署不生成 whitelist.json（面板只在读侧用它识别已知玩家）
          ⇒ 不先加人，谁都会被服务端在登录期拦下，包括服主自己。enforce-whitelist=false 只管
          运行中重载时把非名单玩家踢出，登录期照样拦，指望不上它。
          「服务器启动后」不是客套：加白名单的入口走 RCON（玩家页那个按钮在 RCON 未就绪时禁用），
          部署结果不确认游戏就绪，故白名单提示须交代启动前置条件。
          图标取 UserPlus 而非 Info：与同屏「未同意 EULA」那条同为 info 档，靠语义图标区分
          （与玩家页那个按钮同记号），否则两条同图标同 tint 会被读成「一条两块」。 */}
      <NoticeBanner variant="info" icon={UserPlus}>
        新实例默认开启白名单：名单为空时任何玩家都无法进入。服务器启动后，请在玩家页点「添加白名单」把自己加进去，再进入服务器。
      </NoticeBanner>
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
