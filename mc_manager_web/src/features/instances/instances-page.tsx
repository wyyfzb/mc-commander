/**
 * InstancesPage —— 实例页
 * - 实例卡片网格（30s 轮询；逐卡详情 useQueries 批量拉取版本等字段，与 dashboard 共享 query 缓存）
 * - 部署向导 Dialog（三步 Stepper + WS 进度，deploy-dialog 组件）
 * - 切换实例/启动配置（实例设置弹窗，instance-settings-dialog 组件）/卸载（危险确认）
 * - 深链接：?tab=deploy 自动打开部署向导
 */
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Rocket } from 'lucide-react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/api/client'
import { queryKeys, useInstances } from '@/api/queries'
import { getFriendlyErrorText } from '@/api/errors'
import { EmptyState } from '@/components/mcs/empty-state'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { PageHeader } from '@/components/mcs/page-header'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { useConnectionStore } from '@/stores/connection'
import { useServerStore } from '@/stores/server'
import type { DeployResult, InstanceStatus, InstanceSummary } from '@/api/types'
import { InstanceCards } from './components/instance-cards'
import { DeployDialog } from './components/deploy-dialog'
import { InstanceSettingsDialog } from './components/instance-settings-dialog'
import { UpgradeDialog } from './components/upgrade-dialog'
import { clearUpgradeProgress } from '@/stores/upgrade'
import { useUninstallInstance } from './queries'

export function InstancesPage() {
  const config = useConnectionStore()
  const instanceId = useServerStore((s) => s.instanceId)
  const setInstanceId = useServerStore((s) => s.setInstanceId)

  const instancesQuery = useInstances()
  const uninstallMutation = useUninstallInstance()
  const queryClient = useQueryClient()

  // ── 对话框状态 ──
  const [searchParams, setSearchParams] = useSearchParams()
  const [deployOpen, setDeployOpen] = useState(() => searchParams.get('tab') === 'deploy')
  const [settingsTarget, setSettingsTarget] = useState<InstanceSummary | null>(null)
  const [upgradeTarget, setUpgradeTarget] = useState<InstanceSummary | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<InstanceSummary | null>(null)
  /** 卸载强确认：输入实例名匹配后才可确认（防误删世界数据） */
  const [uninstallInput, setUninstallInput] = useState('')
  const uninstallInputMatches = uninstallInput.trim() === (uninstallTarget?.name ?? '')
  /** 待停止确认的实例（启动直接执行） */
  const [stopTarget, setStopTarget] = useState<InstanceSummary | null>(null)

  // ── 启停（卡片按钮；停止需确认弹窗）──
  const runMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'start' | 'stop' }) => {
      await apiPost(`/api/v1/instances/${id}/${action}`, config)
    },
    onSuccess: (_data, { id, action }) => {
      toast.success(action === 'start' ? '启动指令已发送' : '停止指令已发送')
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance(id) })
      void instancesQuery.refetch()
    },
    onError: (e) => {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    },
  })

  // ── 深链接：?tab=deploy 打开部署向导；写入 URL 保持全站一致性 ──
  const setDeployOpenDeep = (open: boolean) => {
    setDeployOpen(open)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (open) next.set('tab', 'deploy')
      else next.delete('tab')
      return next
    })
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
  detailsQueries.forEach((q, idx) => {
    const inst = instances[idx]
    if (!inst) return
    if (q.data) detailStatuses[inst.id] = q.data
    if (q.isLoading) loadingIds.add(inst.id)
  })

  /** 切换当前实例 */
  const handleSwitch = (inst: InstanceSummary) => {
    setInstanceId(inst.id)
    toast.success(`已切换到 "${inst.name}"`, { duration: 1500 })
  }

  /** 启动配置 → 实例设置弹窗 */
  const handleOpenSettings = (inst: InstanceSummary) => {
    setSettingsTarget(inst)
  }

  /** 卸载确认执行 */
  const handleUninstallConfirm = async () => {
    if (!uninstallTarget) return
    const target = uninstallTarget
    setUninstallTarget(null)
    setUninstallInput('')
    try {
      await uninstallMutation.mutateAsync(target.id)
      toast.success(`实例 "${target.name}" 已卸载`)
      // 卸载的是当前实例 → 清空选择（面板回无实例空态）
      if (instanceId === target.id) setInstanceId(null)
    } catch (e) {
      toast.error(`卸载失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 部署成功：自动切换为新实例 + 失效列表 + 关闭向导 */
  const handleDeployed = (result: DeployResult) => {
    setInstanceId(result.id)
    void instancesQuery.refetch()
    setDeployOpenDeep(false)
    toast.success(`实例 "${result.name}" 部署完成`)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="实例管理"
        description={instancesQuery.isLoading ? '管理服务器实例的部署、切换与卸载' : `已安装 ${instances.length} 个实例`}
        actions={
          <Button size="sm" onClick={() => setDeployOpenDeep(true)}>
            <Rocket aria-hidden />
            部署新实例
          </Button>
        }
      />

      {/* ── 实例隔离说明 ── */}
      <NoticeBanner variant="info" icon={ShieldCheck}>
        实例隔离：每个实例独立目录 / 端口 / Java 版本，切换实例仅需在顶栏选择。
      </NoticeBanner>

      {/* ── 实例卡片网格 ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {instancesQuery.isLoading && instances.length === 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="加载实例中">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-28 rounded-mcs-md bg-mcs-bg-muted" aria-hidden />
            ))}
          </div>
        ) : instancesQuery.isError && !instancesQuery.isLoading ? (
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
            uninstallingId={
              // 同 runMutation：variables 成功后常驻，必须 isPending 才取（防按钮永久禁用）
              uninstallMutation.isPending ? (uninstallMutation.variables ?? null) : null
            }
            onSwitch={handleSwitch}
            onOpenSettings={handleOpenSettings}
            onUpgrade={(inst) => {
              // 每次打开升级弹窗清空该实例残留进度，避免展示上一轮终态
              clearUpgradeProgress(inst.id)
              setUpgradeTarget(inst)
            }}
            onUninstall={setUninstallTarget}
            onStart={(inst) => runMutation.mutate({ id: inst.id, action: 'start' })}
            onStop={setStopTarget}
            busyId={runMutation.isPending ? (runMutation.variables?.id ?? null) : null}
            onDeploy={() => setDeployOpenDeep(true)}
          />
        )}
      </div>

      {/* ── 部署向导 ── */}
      <DeployDialog open={deployOpen} onOpenChange={setDeployOpenDeep} onDeployed={handleDeployed} />

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
        description={`确定要停止实例 "${stopTarget?.name ?? ''}" 吗？停止前将自动执行存档，在线玩家会断开连接。`}
        confirmText="存档并停止"
        danger
        onConfirm={() => {
          const target = stopTarget
          setStopTarget(null)
          if (target) runMutation.mutate({ id: target.id, action: 'stop' })
        }}
      />

      {/* ── 卸载确认（破坏力最大操作：输入实例名强确认，与备份恢复同级门槛） ── */}
      <ConfirmDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setUninstallTarget(null)
            setUninstallInput('')
          }
        }}
        title="卸载实例"
        description={`确定要卸载实例 "${uninstallTarget?.name ?? ''}" 吗？`}
        confirmText="确认卸载"
        danger
        loading={uninstallMutation.isPending}
        warning="此操作不可撤销！将会：停止运行中的服务器、删除所有世界数据和配置、从数据库中移除记录"
        confirmDisabled={!uninstallInputMatches}
        onConfirm={() => void handleUninstallConfirm()}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="uninstall-confirm-input" className="text-mcs-xs font-semibold text-mcs-text-muted">
            输入实例名「{uninstallTarget?.name ?? ''}」以确认
          </label>
          <input
            id="uninstall-confirm-input"
            value={uninstallInput}
            onChange={(e) => setUninstallInput(e.target.value)}
            placeholder={uninstallTarget?.name ?? ''}
            className="h-9 rounded-mcs-md border border-mcs-error-border bg-mcs-bg-default px-3 font-mono text-mcs-sm text-mcs-text-default outline-none placeholder:text-mcs-text-subtle focus:border-mcs-error-fg"
          />
        </div>
      </ConfirmDialog>
    </div>
  )
}
