/**
 * InstancesPage —— 实例页
 * - 实例卡片网格（30s 轮询；逐卡详情 useQueries 批量拉取版本等字段，与 dashboard 共享 query 缓存）
 * - 部署向导 Dialog（三步 Stepper + WS 进度，deploy-dialog 组件）
 * - 切换实例/启动配置（实例设置弹窗，instance-settings-dialog 组件）/卸载（危险确认）
 * - 深链接：?tab=deploy 自动打开部署向导；?focus=<id> 从通知中心跳转（切换到关联实例）
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, Rocket } from 'lucide-react'
import { toast } from 'sonner'
import { apiGet, ApiError } from '@/api/client'
import { queryKeys, useInstances } from '@/api/queries'
import { ErrorCode, getFriendlyErrorText } from '@/api/errors'
import { queryFailed, queryPhase } from '@/lib/query-phase'
import { instanceLabel } from '@/lib/instance-label'
import { EmptyState } from '@/components/mcs/empty-state'
import { StaleQueryNotice } from '@/components/mcs/data-states'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { PageHeader } from '@/components/mcs/page-header'
import { InfoHint } from '@/components/mcs/info-hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import { useDeployStore, DEPLOY_STAGE_LABELS } from '@/stores/deploy'
import type { DeployResult, InstanceStatus, InstanceSummary } from '@/api/types'
import { InstanceCards, INSTANCE_GRID_CLASS } from './components/instance-cards'
import { DeployDialog } from './components/deploy-dialog'
import { InstanceSettingsDialog } from './components/instance-settings-dialog'
import { UpgradeDialog } from './components/upgrade-dialog'
import { clearUpgradeProgress } from '@/stores/upgrade'
import { useUninstallInstance } from './queries'
import { useDeployStatusFallback } from './hooks/use-deploy-status-fallback'
import { useStartInstanceWithEula } from '@/hooks/use-start-instance-with-eula'
import { useStopInstance } from '@/hooks/use-instance-stop'

/**
 * 部署进行中横幅（issue 352）：部署实例完成前未入实例列表，卡片网格看不到它——
 * 列表页顶部横幅是刷新后恢复的「最小可见标识」（WS 连接补发 deployProgress，
 * WS 断线期间由 useDeployStatusFallback 轮询服务端快照）。
 * 终态由 deployStore.deploying 收敛（applyDeployProgress 终态不置 deploying）
 */
function DeployingBanner() {
  const deploying = useDeployStore((s) => s.deploying)
  const progress = useDeployStore((s) => s.progress)
  if (!deploying) return null
  const stageLabel = progress ? (DEPLOY_STAGE_LABELS[progress.stage] ?? '正在部署…') : '正在部署…'
  const nameSuffix = progress?.instanceName ? `「${progress.instanceName}」` : ''
  const pctSuffix =
    progress != null && progress.stage === 'download' && progress.total > 0
      ? `（${Math.round(progress.percent * 100)}%）`
      : ''
  return (
    <NoticeBanner variant="info" icon={Loader2} className="animate-pulse">
      {`有实例正在部署：${nameSuffix}${stageLabel}${pctSuffix}`}
    </NoticeBanner>
  )
}

/**
 * 实例隔离说明全文（唯一声明源：展示点与测试都取这里）
 * 常驻信息条等于把同一句话在首屏说两遍（右栏部署引导块是同一条信息），还固定占掉一行高度，
 * 故挂在页头描述行末尾的信息图标上（载体见 components/mcs/info-hint.tsx）。
 */
const ISOLATION_HINT =
  '实例隔离：每个实例独立目录 / 端口 / Java 版本，切换实例只需在顶栏选择，实例之间互不影响。'

export function InstancesPage() {
  const config = useConnectionStore()
  const instanceId = useServerStore((s) => s.instanceId)
  const setInstanceId = useServerStore((s) => s.setInstanceId)
  // 服务端在途部署兜底快照：挂载/断线后恢复进度显示，并禁止再次发起部署
  const { duplicateDeployBlocked } = useDeployStatusFallback()

  const instancesQuery = useInstances()
  /** 列表相位：有旧值可留时不把一次轮询抖动呈现成整屏故障 */
  const instancesPhase = queryPhase(instancesQuery)
  const uninstallMutation = useUninstallInstance()
  const stopMutation = useStopInstance()
  const queryClient = useQueryClient()
  const phase = useServerStore((s) => s.phase)

  // ── 对话框状态 ──
  const [searchParams, setSearchParams] = useSearchParams()
  const [settingsTarget, setSettingsTarget] = useState<InstanceSummary | null>(null)
  const [upgradeTarget, setUpgradeTarget] = useState<InstanceSummary | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<InstanceSummary | null>(null)
  /** 卸载强确认：输入实例名匹配后才可确认（防误删世界数据）；服务端同名校验为强制口径 */
  const [uninstallInput, setUninstallInput] = useState('')
  /** 服务端回「无备份」后的第二阶段：不可恢复确认（仅此阶段才声明 acknowledgeIrreversible） */
  /**
   * 「确认不可恢复」二次确认的触发原因（null = 未触发）：
   * - no-backup：实例没有任何快照可回退（40914）
   * - unnamed：实例名为空，实例名确认这道闸门空转（40916）
   * 两者都要求显式声明 acknowledgeIrreversible，但原因不同 → 提示文案必须据实分叉
   */
  const [uninstallAckReason, setUninstallAckReason] = useState<'no-backup' | 'unnamed' | null>(null)
  // 两侧都 trim：服务端按 trim 后比对，升级前库里带首尾空白的旧实例名也要能确认
  const uninstallInputMatches = uninstallInput.trim() === (uninstallTarget?.name ?? '').trim()
  /** 待停止确认的实例（启动走共享 hook：EULA 首启特例内置） */
  const [stopTarget, setStopTarget] = useState<InstanceSummary | null>(null)

  // 启动：共享 mutation（EULA 首启特例：命中 → 弹同意 → 续启；与仪表盘同源）
  const { startInstance, startPending, pendingStartId, eulaDialog } = useStartInstanceWithEula()

  // ── 深链接：?focus=<id> 从通知中心跳转（issue 334）→ 切换到关联实例并清参数 ──
  useEffect(() => {
    const focus = searchParams.get('focus')
    if (!focus) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('focus')
        return next
      },
      { replace: true },
    )
    if (focus !== instanceId) {
      setInstanceId(focus)
      toast.success('已切换到通知关联的实例', { duration: 1500 })
    }
  }, [searchParams, setSearchParams, setInstanceId, instanceId])

  // ── 停止：共享 mutation（issue 334 收敛：与仪表盘同源，phase 中间态防连点） ──
  // 卡片停止按钮仍经 ConfirmDialog 确认后调用 stopMutation.mutate(id)

  /** 卡片启动：EULA 首启弹窗由共享 hook 处理，成功后反馈与列表刷新与 stop 一致 */
  const handleStart = (inst: InstanceSummary) => {
    startInstance(inst.id, {
      onStarted: () => {
        toast.success('启动指令已发送')
        void queryClient.invalidateQueries({ queryKey: queryKeys.instance(inst.id) })
        void instancesQuery.refetch()
      },
      // 非 EULA 错误由 hook 内 toast 兜底
    })
  }

  // ── 深链接：?tab=deploy 打开部署向导；URL 为单一事实源 ──
  // 只在挂载时读一次会漏掉同路由再点（如顶栏「暂无实例，前往部署」）与前进/后退两路，
  // 表现为 URL 已变而向导不开（点击无反应）。
  // 写入语义：打开 push 一条历史（后退即关弹窗）；关闭 replace，避免「开→关」堆两条、
  // 也避免用户后退时把已关掉的向导又弹回来（?focus= 清理同用 replace）
  const deployOpen = searchParams.get('tab') === 'deploy'
  const setDeployOpenDeep = (open: boolean) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (open) next.set('tab', 'deploy')
        else next.delete('tab')
        return next
      },
      open ? undefined : { replace: true },
    )
  }

  const instances = instancesQuery.data ?? []

  // ── 逐卡详情（GET /instances/:id 批量；列表端点字段薄，卡片需要版本等） ──
  const detailsQueries = useQueries({
    queries: instances.map((inst) => ({
      queryKey: queryKeys.instance(inst.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiGet<InstanceStatus>(`/api/v1/instances/${inst.id}`, config, signal),
      enabled: config.status === 'ready',
      refetchInterval: 30_000,
    })),
  })
  const detailStatuses: Record<string, InstanceStatus> = {}
  const loadingIds = new Set<string>()
  /* 逐卡详情失败必须传到卡片：此前只取 data/isLoading，isError 被静默丢掉 ⇒
     失败卡的版本徽章凭空消失、四个指标全「—」，与「这台机器真的没有 TPS」不可分 */
  const detailErrorIds = new Set<string>()
  const detailIndexById = new Map<string, number>()
  detailsQueries.forEach((q, idx) => {
    const inst = instances[idx]
    if (!inst) return
    detailIndexById.set(inst.id, idx)
    if (q.data) detailStatuses[inst.id] = q.data
    if (q.isLoading) loadingIds.add(inst.id)
    if (queryFailed(q)) detailErrorIds.add(inst.id)
  })

  /** 重试某实例的详情查询（失败卡的重试入口；index 由上面的遍历建立） */
  const handleRetryDetail = (instanceId: string) => {
    const idx = detailIndexById.get(instanceId)
    if (idx != null) void detailsQueries[idx]?.refetch()
  }

  /** 切换当前实例 */
  const handleSwitch = (inst: InstanceSummary) => {
    setInstanceId(inst.id)
    toast.success(`已切换到 "${instanceLabel(inst)}"`, { duration: 1500 })
  }

  /**
   * 启动配置 → 实例设置弹窗。
   *
   * 弹窗必须拿到详情才能预填（预填在 mount 时计算，未就绪挂载会把默认值固化），故详情
   * 未就绪时弹窗延迟到查询完成才出现。但「详情失败」不会自愈——不给出反馈就是一个
   * 死点击（用户不知道是没反应还是在等），故此时直接说明并给重试入口。
   */
  const handleOpenSettings = (inst: InstanceSummary) => {
    if (!detailStatuses[inst.id] && detailErrorIds.has(inst.id)) {
      toast.error('实例详情获取失败，无法打开启动配置', {
        description: '启动配置需要实例详情预填，请先重试获取详情。',
      })
      handleRetryDetail(inst.id)
      return
    }
    setSettingsTarget(inst)
  }

  /** 关闭卸载弹窗：确认输入与不可恢复阶段一并复位 */
  const closeUninstall = () => {
    setUninstallTarget(null)
    setUninstallInput('')
    setUninstallAckReason(null)
  }

  /**
   * 卸载确认执行。实例名确认与「有没有备份」都由服务端裁决：服务端在前置清单
   * 为空时回 409，此时不重开弹窗，就地转入不可恢复二次确认（用户已输入的名字保留），
   * 二次确认才带 acknowledgeIrreversible 重发——客户端不预判备份清单，避免与服务端
   * 盘面判断分叉。
   */
  const handleUninstallConfirm = async () => {
    if (!uninstallTarget) return
    const target = uninstallTarget
    try {
      const result = await uninstallMutation.mutateAsync({
        instanceId: target.id,
        // 用户输入原值：两侧 trim 归一化由服务端裁决（前端只在放行判定上做同构处理）
        confirmName: uninstallInput,
        acknowledgeIrreversible: uninstallAckReason !== null || undefined,
      })
      closeUninstall()
      // 展示名统一走 instanceLabel（空名/纯空白名回退 id，否则 toast 会印出 `实例 ""`）
      const label = instanceLabel(target)
      toast.success(
        result.retainedBackupCount > 0
          ? `实例 "${label}" 已卸载，已保留 ${result.retainedBackupCount} 份备份`
          : `实例 "${label}" 已卸载，该实例没有备份`,
      )
      // 卸载的是当前实例 → 清空选择（面板回无实例空态）
      if (instanceId === target.id) setInstanceId(null)
    } catch (e) {
      // 无备份（40914）与空名实例（40916）都要求「确认不可恢复」这道二次确认：
      // 两者的实例名闸门都不承载信息（无副本可回退 / 名称为空天然匹配）。
      // 原因分档记录，二次确认的提示文案按原因据实显示
      if (e instanceof ApiError && e.code === ErrorCode.INSTANCE_DELETE_NO_BACKUP) {
        setUninstallAckReason('no-backup')
        return
      }
      if (e instanceof ApiError && e.code === ErrorCode.INSTANCE_DELETE_UNNAMED) {
        setUninstallAckReason('unnamed')
        return
      }
      toast.error(`卸载失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 部署成功：自动切换为新实例 + 失效列表 + 关闭向导 */
  const handleDeployed = (result: DeployResult) => {
    setInstanceId(result.id)
    void instancesQuery.refetch()
    setDeployOpenDeep(false)
    toast.success(`实例 "${instanceLabel(result)}" 部署完成`)
  }

  return (
    /* @container：卡片栅格按「可用内容宽」切档而非视口宽（侧栏可折叠，同视口下内容宽差 152px），
       口径见 instance-cards.tsx 的 INSTANCE_GRID_CLASS */
    <div className="@container flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="实例管理"
        description={
          <span className="inline-flex items-center gap-1">
            {instancesQuery.isLoading
              ? '管理服务器实例的部署、切换与卸载'
              : `已安装 ${instances.length} 个实例`}
            <InfoHint label="实例隔离说明">{ISOLATION_HINT}</InfoHint>
          </span>
        }
        actions={
          /* 禁用按钮带 disabled:pointer-events-none，挂在自己身上的原生 title
             悬停不到 → 提示挂外层 span（指针事件穿透到 span），tooltip 才可达 */
          <span
            title={
              duplicateDeployBlocked
                ? '服务端已有部署在进行中，等待其完成后再发起新部署'
                : undefined
            }
          >
            <Button
              size="sm"
              onClick={() => setDeployOpenDeep(true)}
              disabled={duplicateDeployBlocked}
              aria-label={duplicateDeployBlocked ? '已有部署在进行中' : '部署新实例'}
            >
              <Rocket aria-hidden />
              {duplicateDeployBlocked ? '已有部署在进行中' : '部署新实例'}
            </Button>
          </span>
        }
      />

      {/* ── 部署进行中横幅（刷新后 WS 补发恢复的可见标识；部署实例未入列表） ── */}
      <DeployingBanner />

      {/* ── 实例卡片网格 ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {instancesPhase === 'stale' && (
          <StaleQueryNotice
            className="mb-2"
            error={instancesQuery.error}
            onRetry={() => void instancesQuery.refetch()}
          />
        )}
        {instancesQuery.isLoading && instances.length === 0 ? (
          // 骨架与真实网格同源（INSTANCE_GRID_CLASS）：列数恒定，实例数在数据到达前不可知
          // 也不再影响布局；两格＝一张实例卡 + 单实例形态下的部署引导块（三列档下跨两列）
          <div role="status" aria-label="加载实例中" className={INSTANCE_GRID_CLASS}>
            {/* sr-only 文本才是 live region 的公告载体（role=status 播报的是内容，
                aria-label 只作内容前缀）；骨架格是装饰，不进可访问树 */}
            <span className="sr-only">加载实例中</span>
            <Skeleton className="h-28" aria-hidden />
            <Skeleton className="h-28 @5xl:col-span-2" aria-hidden />
          </div>
        ) : instancesPhase === 'failed' ? (
          <EmptyState
            icon={AlertTriangle}
            title="加载失败"
            hint={`无法获取实例列表：${getFriendlyErrorText(instancesQuery.error)}`}
            action={{ label: '重试', onClick: () => void instancesQuery.refetch() }}
          />
        ) : (
          <InstanceCards
            instances={instances}
            currentId={instanceId}
            detailStatuses={detailStatuses}
            loadingIds={loadingIds}
            detailErrorIds={detailErrorIds}
            onRetryDetail={handleRetryDetail}
            uninstallingId={
              // 同 runMutation：variables 成功后常驻，必须 isPending 才取（防按钮永久禁用）
              uninstallMutation.isPending ? (uninstallMutation.variables?.instanceId ?? null) : null
            }
            onSwitch={handleSwitch}
            onOpenSettings={handleOpenSettings}
            onUpgrade={(inst) => {
              // 每次打开升级弹窗清空该实例残留进度，避免展示上一轮终态
              clearUpgradeProgress(inst.id)
              setUpgradeTarget(inst)
              // 同上：升级弹窗以 detail 为 instance 入参，详情未就绪时不会挂载
              if (!detailStatuses[inst.id] && detailErrorIds.has(inst.id)) {
                toast.error('实例详情获取失败，无法打开升级向导', {
                  description: '升级需要实例详情，请先重试获取详情。',
                })
                handleRetryDetail(inst.id)
              }
            }}
            onUninstall={setUninstallTarget}
            onStart={handleStart}
            onStop={setStopTarget}
            busyId={
              (startPending ? pendingStartId : null) ??
              (stopMutation.isPending ? (stopMutation.variables ?? null) : null)
            }
            phaseById={phase}
            onDeploy={() => setDeployOpenDeep(true)}
          />
        )}
      </div>

      {/* ── 部署向导 ── */}
      <DeployDialog
        open={deployOpen}
        onOpenChange={setDeployOpenDeep}
        onDeployed={handleDeployed}
      />

      {/* ── 启动配置弹窗（条件挂载：每次打开重置表单状态；详情预填取逐卡查询缓存） ──
          detail 就绪才挂载：预填在 mount 时计算，未就绪挂载会以默认值固化，
          详情到达后也不更新（点击后弹窗延迟至查询完成自动出现） */}
      {settingsTarget && detailStatuses[settingsTarget.id] && (
        <InstanceSettingsDialog
          instance={settingsTarget}
          detail={detailStatuses[settingsTarget.id]}
          onOpenChange={(open) => !open && setSettingsTarget(null)}
        />
      )}

      {/* ── 升级弹窗 ── */}
      {(() => {
        // 局部变量承接索引访问，truthiness 收窄后传入（noUncheckedIndexedAccess 安全）
        const upgradeDetail = upgradeTarget ? detailStatuses[upgradeTarget.id] : undefined
        if (!upgradeTarget || !upgradeDetail) return null
        return (
          <UpgradeDialog
            instance={upgradeDetail}
            open={true}
            onOpenChange={(open) => !open && setUpgradeTarget(null)}
          />
        )
      })()}

      {/* ── 停止确认（卡片停止按钮） ── */}
      <ConfirmDialog
        open={stopTarget !== null}
        onOpenChange={(open) => !open && setStopTarget(null)}
        title="停止服务器"
        description={`确定要停止实例 "${stopTarget ? instanceLabel(stopTarget) : ''}" 吗？停止前将自动执行存档，在线玩家会断开连接。`}
        confirmText="存档并停止"
        danger
        onConfirm={() => {
          const target = stopTarget
          setStopTarget(null)
          if (target) stopMutation.mutate(target.id)
        }}
      />

      {/* ── EULA 首启特例（共享 hook：同意写入 eula.txt 后自动续启） ── */}
      {eulaDialog}

      {/* ── 卸载确认（破坏力最大操作：输入实例名强确认，与备份恢复同级门槛；
             实例名确认与备份清单校验都由服务端强制，无备份时转入第二阶段） ── */}
      <ConfirmDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeUninstall()
        }}
        title="卸载实例"
        description={`确定要卸载实例 "${uninstallTarget ? instanceLabel(uninstallTarget) : ''}" 吗？`}
        confirmText={uninstallAckReason !== null ? '确认不可恢复删除' : '确认卸载'}
        danger
        loading={uninstallMutation.isPending}
        warning={
          uninstallAckReason !== null
            ? undefined
            : '此操作不可撤销！将会：停止运行中的服务器、删除所有世界数据和配置、从数据库中移除记录'
        }
        confirmDisabled={uninstallAckReason === null && !uninstallInputMatches}
        onConfirm={() => void handleUninstallConfirm()}
      >
        {uninstallAckReason !== null ? (
          <NoticeBanner variant="error" icon={AlertTriangle} role="alert">
            {uninstallAckReason === 'no-backup'
              ? '该实例没有任何备份：删除后世界数据与配置不可恢复，也没有任何快照可供还原'
              : '该实例没有名称，实例名确认不构成有效确认：删除后世界数据与配置不可恢复'}
          </NoticeBanner>
        ) : (
          <div className="flex flex-col gap-1.5">
            {/* 确认块刻意**不用** instanceLabel：只有名称为空/纯空白时展示名会变成 id，
                而服务端（routes/status.js：confirmName.trim() === name.trim()）只认原值，
                那时用户照显示名输入会被判不匹配，故这里保持显示与比对同源的原值 */}
            <label
              htmlFor="uninstall-confirm-input"
              className="text-mcs-xs font-semibold text-mcs-text-muted"
            >
              输入实例名「{uninstallTarget?.name ?? ''}」以确认
            </label>
            {/* 归 ui/input 基座，只保留危险语义焦点环（确认框的「红色 = 不可逆」提示） */}
            <Input
              id="uninstall-confirm-input"
              value={uninstallInput}
              onChange={(e) => setUninstallInput(e.target.value)}
              placeholder={uninstallTarget?.name ?? ''}
              className="font-mono focus-visible:border-mcs-error-fg focus-visible:ring-mcs-error-fg"
            />
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
