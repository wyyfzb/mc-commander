/**
 * DeployDialog —— 部署新实例三步向导（编排层：状态机 + 数据流，展示件见 ./deploy/）
 * - 三步流程状态：step 推进 / 表单与基线（dirty 判定）/ EULA / 自动启动 / 结果 / 关闭确认
 * - 步骤① 服务端类型 5 卡单选 + 版本 Select（useServerVersions 按类型拉取，切换类型触发新查询）
 *   + fabric/forge loader Select；步骤② 名称 + 内存档位；步骤③ 确认摘要 + EULA
 * - 自动回填：版本/加载器列表就绪回填首个；系统内存 → 推荐档位（用户手动调整后不覆盖），
 *   回填值同步基线不算 dirty
 * - EULA 同意随部署请求下发（服务端据此写 eula.txt）；部署成功且已同意时发启动指令
 *   （POST /start），结果块展示启动状态（首启闭环）
 * - 视图状态机：部署中 → 成功 → 已取消 → 失败 → 表单三步；恢复场景保留进行中进度；
 *   服务端报告在途部署时禁止再次发起（消除重复部署）；部署中禁用上一步与关闭（ESC/遮罩拦截），
 *   仅保留「取消部署」出口（服务端中断执行体并清理未完成目录）
 * - dirty 关闭拦截：表单与基线对比（自动回填的版本/加载器同步基线，不误判 dirty）
 * - 数据流：useDeployStore（progress/deploying/lastResult/cancelling/startDeploy/finishDeploy/resetDeploy）
 *   + useDeployStatusFallback（挂载/断线兜底快照）+ useDeployInstance().mutateAsync + apiCancelDeploy；关闭时 resetDeploy
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CloudDownload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { getFriendlyErrorText, ErrorCode } from '@/api/errors'
import { useConnectionStore } from '@/stores/connection'
import { FALLBACK_VERSIONS, type ServerType } from '@/lib/mc-deploy'
import { useDeployStore } from '@/stores/deploy'
import { useOverview } from '@/api/queries'
import { useDeployInstance, useServerVersions } from '../queries'
import { useDeployStatusFallback } from '../hooks/use-deploy-status-fallback'
import { apiCancelDeploy } from '@/api/instances'
import type { DeployRequest, DeployResult } from '@/api/types'
import { INITIAL_FORM, type AutoStartState, type DeployForm } from './deploy/types'
import {
  hasRoomForInstance,
  memoryBudget,
  recommendNewInstanceGB,
  selectableTiersGB,
} from '@/lib/instance-memory'
import { Stepper } from './deploy/stepper'
import {
  DeployCancelledView,
  DeployErrorView,
  DeployProgressView,
  DeploySuccessView,
} from './deploy/views'
import { DeployStepConfig, DeployStepConfirm, DeployStepServer } from './deploy/steps'

const EMPTY_STRINGS: string[] = []

export interface DeployDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 部署成功后通知页面（刷新实例列表/切换实例由页面负责） */
  onDeployed: (result: DeployResult) => void
}

export function DeployDialog({ open, onOpenChange, onDeployed }: DeployDialogProps) {
  const config = useConnectionStore()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<DeployForm>({ ...INITIAL_FORM })
  /** EULA 同意（默认不勾；不参与 dirty 判定——流程性同意而非部署配置） */
  const [eulaAgreed, setEulaAgreed] = useState(false)
  /** 部署成功后自动启动状态（首启闭环；未勾选 EULA 时为 null 不自动启动） */
  const [autoStart, setAutoStart] = useState<AutoStartState>(null)
  /** 基线（自动回填的版本/加载器同步基线：不算用户改动） */
  const baselineRef = useRef<DeployForm>({ ...INITIAL_FORM })
  const [nameError, setNameError] = useState('')
  const [result, setResult] = useState<DeployResult | null>(null)
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  const deploying = useDeployStore((s) => s.deploying)
  const progress = useDeployStore((s) => s.progress)
  const lastResult = useDeployStore((s) => s.lastResult)
  const cancelling = useDeployStore((s) => s.cancelling)
  const startDeploy = useDeployStore((s) => s.startDeploy)
  const finishDeploy = useDeployStore((s) => s.finishDeploy)
  const setCancelling = useDeployStore((s) => s.setCancelling)
  const resetDeploy = useDeployStore((s) => s.resetDeploy)

  const deployMutation = useDeployInstance()
  // 服务端快照兜底：刷新/断线后恢复在途进度，并作为「禁止重复部署」的服务端真值
  const { duplicateDeployBlocked } = useDeployStatusFallback()
  const versionsQuery = useServerVersions(form.type)
  // 版本列表失败 → 本地缓存兜底（仍可部署）；useMemo 稳定引用（回填 effect 依赖）
  const versions = useMemo(
    () =>
      versionsQuery.data?.versions ??
      (versionsQuery.isError ? [...FALLBACK_VERSIONS] : EMPTY_STRINGS),
    [versionsQuery.data, versionsQuery.isError],
  )
  const loaders = versionsQuery.data?.loaders ?? EMPTY_STRINGS

  const overviewQuery = useOverview()
  const totalMemory = overviewQuery.data?.totalMemory ?? 4
  const budget = useMemo(
    () =>
      memoryBudget(
        totalMemory,
        (overviewQuery.data?.instances ?? []).map((i) => i.maxMemory),
      ),
    [totalMemory, overviewQuery.data],
  )
  /** 只留装得下的档：8G 摆在一台 7.4G 的机器上，点了才发现起不来 */
  const memoryOptions = useMemo(
    () => selectableTiersGB(budget.availableGB).map((gb) => `${gb}G`),
    [budget.availableGB],
  )
  const recommendMemory = `${recommendNewInstanceGB(budget.availableGB, budget.allocatableGB)}G`
  const memoryTouchedRef = useRef(false)

  // 打开时重置表单与部署状态（自动回填前的基线同步见下方 effect）。
  // 恢复场景例外：store 中已有进行中的部署（页面刷新后 WS 连接补发恢复的
  // 进度）→ 保留进度直接显示部署视图，重置会丢掉恢复态
  useEffect(() => {
    if (!open) return
    const store = useDeployStore.getState()
    const resuming =
      store.deploying &&
      store.progress != null &&
      store.progress.stage !== 'complete' &&
      store.progress.stage !== 'error' &&
      store.progress.stage !== 'cancelled'
    if (!resuming) {
      store.resetDeploy()
    }
    setStep(0)
    setForm({ ...INITIAL_FORM })
    baselineRef.current = { ...INITIAL_FORM }
    setResult(null)
    setNameError('')
    setEulaAgreed(false)
    setAutoStart(null)
    setCloseConfirmOpen(false)
  }, [open])

  // 系统内存就绪 → 推荐档位覆盖默认 2G。
  // 与表单重置同周期
  useEffect(() => {
    if (open) memoryTouchedRef.current = false
  }, [open])

  useEffect(() => {
    if (memoryTouchedRef.current) return
    setForm((f) => {
      if (f.memory === recommendMemory) return f
      baselineRef.current = { ...baselineRef.current, memory: recommendMemory }
      return { ...f, memory: recommendMemory }
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- recommendMemory 由预算派生，setter/ref 稳定引用
  }, [recommendMemory, open])

  // 预算变小（别的实例占走了内存）而当前档位已装不下 → 拉回装得下的最大档。
  // 不静默下发装不下的档：服务端不校验，用户会拿到一个必然互相抢内存的实例
  useEffect(() => {
    if (memoryTouchedRef.current) return
    setForm((f) => {
      if (memoryOptions.includes(f.memory)) return f
      const next = memoryOptions[memoryOptions.length - 1] ?? recommendMemory
      baselineRef.current = { ...baselineRef.current, memory: next }
      return { ...f, memory: next }
    })
  }, [memoryOptions, recommendMemory])

  // 版本列表就绪 → 自动回填首个版本，并同步基线。
  // 依赖含 open 且用函数式更新内部判空：打开向导时重置清空 version，但 effect 读到的
  // form.version 是渲染快照（旧值非空）会误判「已选」跳过回填——函数式更新读取最新
  // state，仅在真正为空时回填并同步基线（用户手动选择的版本不受影响）
  useEffect(() => {
    const first = versions[0]
    if (first == null) return
    setForm((f) => {
      if (f.version !== '') return f
      baselineRef.current = { ...baselineRef.current, version: first }
      return { ...f, version: first }
    })
  }, [versions, open])

  // 加载器列表就绪 → 自动回填首个 loader（时序同版本）
  useEffect(() => {
    const first = loaders[0]
    if (first == null) return
    setForm((f) => {
      if (f.loader !== '') return f
      baselineRef.current = { ...baselineRef.current, loader: first }
      return { ...f, loader: first }
    })
  }, [loaders, open])

  /** dirty：与基线对比（用户改动过任意字段） */
  const dirty =
    form.type !== baselineRef.current.type ||
    form.version !== baselineRef.current.version ||
    form.loader !== baselineRef.current.loader ||
    form.name !== baselineRef.current.name ||
    form.memory !== baselineRef.current.memory

  /**
   * 服务端报告在途部署 → 禁止再次发起（重复部署会产出重复实例目录与 DB 记录）。
   * 本地已有本轮终态结果（lastResult 非空）时放行：那是刚结束的部署，
   * 服务端快照可能尚未清理，不能因此永久禁用按钮（「重试」路径读同一条件）
   */
  const duplicateDeploy =
    duplicateDeployBlocked &&
    lastResult === null &&
    !(
      progress?.stage === 'complete' ||
      progress?.stage === 'error' ||
      progress?.stage === 'cancelled'
    )

  const changeType = (type: ServerType) => {
    if (type === form.type) return
    // 切换类型重置版本与加载器（新数据就绪后自动回填）
    setForm((f) => ({ ...f, type, version: '', loader: '' }))
  }

  const handleNext = () => {
    if (step === 1 && form.name.trim() === '') {
      setNameError('请填写实例名称')
      // 只显示一行小字时，用户点完「下一步」看不出哪里没填（焦点仍在按钮上，
      // 视线上移才看得见）。把焦点送到该填的框里，键盘用户也能直接开始输入
      document.getElementById('deploy-instance-name')?.focus()
      return
    }
    // 内存不够时不放行：服务端不校验总量，放过去就是一个必然与已有实例抢内存的实例，
    // 症状要等到运行时被 OOM 杀掉才出现，那时用户已经不知道是哪一步的错
    if (step === 1 && !hasRoomForInstance(budget.availableGB)) {
      setNameError('这台机器已没有可分配的内存，请先卸载不用的实例')
      return
    }
    setNameError('')
    setStep((s) => Math.min(s + 1, 2))
  }

  const handleDeploy = async () => {
    if (form.version === '' || form.name.trim() === '') return
    if (!hasRoomForInstance(budget.availableGB)) {
      toast.error('这台机器已没有可分配的内存，请先卸载不用的实例')
      return
    }
    // 服务端在途部署时不再发起（服务端同样以 409 拒绝，这里省掉一次注定失败的往返）
    if (duplicateDeploy) {
      toast.error('服务端已有部署在进行中，请等待其完成后再发起新部署')
      return
    }
    const payload: DeployRequest = {
      type: form.type,
      mcVersion: form.version,
      instanceName: form.name.trim(),
      maxMemory: form.memory,
      // EULA 同意随请求下发：服务端据此写 eula.txt（未同意写 false 且不首启）
      eula: eulaAgreed,
    }
    if ((form.type === 'fabric' || form.type === 'forge') && form.loader !== '') {
      payload.loaderVersion = form.loader
    }
    startDeploy()
    try {
      const deployed = await deployMutation.mutateAsync(payload)
      setResult(deployed)
      finishDeploy({ ok: true, instanceId: deployed.id })
      // 启动由服务端在部署收尾时完成（勾了 EULA 才做），结果随响应回来。
      // 不能再发一次 start：服务端此时已置 isRunning，第二个请求必然撞上
      // 「already running」→ 每次勾 EULA 的成功部署都会闪一次假的「自动启动失败」。
      if (eulaAgreed) {
        setAutoStart(deployed.started ? 'ok' : 'failed')
        if (deployed.started) {
          toast.success('部署完成，服务器开始启动')
        } else {
          toast.error('服务器未能自动启动，请到实例页手动启动')
        }
      }
      if (deployed.warnings.length > 0) {
        // 部署本身成功，但收尾有未完成项：逐条说清，别让「部署成功」盖过去
        toast.warning('部署已完成，但有以下未完成项', {
          description: deployed.warnings.join('；'),
        })
      }
    } catch (e) {
      // 取消的回声（服务端以 409 TASK_CANCELLED 结束部署请求）：用户动作不能被
      // 显示成「部署失败」，走 cancelled 终态；其余错误照旧。
      // details.cleanup 是服务端的收尾明细（收尾未完成时才有）：WS 断线时前端只剩
      // 这条回声，缺了它会把「收尾未完成」显示成「已清理」
      if (e instanceof ApiError && e.code === ErrorCode.TASK_CANCELLED) {
        const cleanup = (e.details as { cleanup?: string } | null)?.cleanup
        finishDeploy({ ok: false, cancelled: true, ...(cleanup ? { error: cleanup } : {}) })
      } else {
        finishDeploy({ ok: false, error: getFriendlyErrorText(e) })
      }
    }
  }

  /**
   * 取消部署（服务端中断下载/安装/首启并清理未完成的实例目录）。
   * 只负责发请求：成功与否以服务端 cancelled 终态事件为准，此处不乐观置终态——
   * 请求被受理但中断未能生效（如任务恰好刚结束）时，乐观置终态会让界面谎报已取消。
   */
  const handleCancelDeploy = async () => {
    setCancelConfirmOpen(false)
    const taskId = progress?.instanceId
    if (!taskId) {
      toast.error('无法定位在途部署的实例，请刷新页面后重试')
      return
    }
    setCancelling(true)
    try {
      await apiCancelDeploy(config, taskId)
      toast.success('已请求取消部署')
    } catch (e) {
      setCancelling(false)
      toast.error(`取消部署失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 真正关闭：清部署状态 + 通知页面 */
  const handleClose = () => {
    resetDeploy()
    onOpenChange(false)
  }

  /** 关闭拦截：部署中禁关；dirty 先确认 */
  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true)
      return
    }
    if (deploying) return
    if (dirty) {
      setCloseConfirmOpen(true)
      return
    }
    handleClose()
  }

  /** 成功结果「完成」：通知页面 + 关闭 */
  const handleComplete = () => {
    if (result) onDeployed(result)
    handleClose()
  }

  /** 失败「重试」：清部署状态回步骤①（保留表单值供调整） */
  const handleRetry = () => {
    setResult(null)
    resetDeploy()
    setStep(0)
  }

  // ── 视图状态机：部署中 → 成功 → 已取消 → 失败 → 表单三步 ──
  const cancelled = lastResult?.cancelled === true
  const showProgress =
    !cancelled && (deploying || (progress != null && result === null && lastResult?.ok !== false))
  const showSuccess = result !== null
  const showCancelled = cancelled && result === null
  const showError = lastResult?.ok === false && !cancelled && result === null && !deploying

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!deploying}
        onInteractOutside={(e) => {
          // 部署中禁止遮罩关闭（dirty 拦截走 onOpenChange）
          if (deploying) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          // 部署中禁止 ESC 关闭（dirty 拦截走 onOpenChange）
          if (deploying) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>部署新实例</DialogTitle>
          <DialogDescription>按步骤选择服务端类型、配置实例并创建。</DialogDescription>
        </DialogHeader>

        {showProgress && (
          <DeployProgressView
            progress={progress}
            cancelling={cancelling}
            onCancel={() => setCancelConfirmOpen(true)}
          />
        )}

        {showSuccess && result && (
          <DeploySuccessView result={result} autoStart={autoStart} onComplete={handleComplete} />
        )}

        {showCancelled && (
          <DeployCancelledView
            cleanupError={progress?.stage === 'cancelled' ? progress.error : undefined}
            onClose={handleClose}
            onRetry={handleRetry}
          />
        )}

        {showError && (
          <DeployErrorView
            errorText={lastResult?.error ?? '部署失败，请重试'}
            onCancel={handleClose}
            onRetry={handleRetry}
          />
        )}

        {!showProgress && !showSuccess && !showCancelled && !showError && (
          <>
            <Stepper step={step} />

            {step === 0 && (
              <DeployStepServer
                form={form}
                versions={versions}
                versionsLoading={versionsQuery.isLoading}
                versionsError={versionsQuery.isError}
                loaders={loaders}
                onTypeChange={changeType}
                onVersionChange={(v) => {
                  setNameError('')
                  setForm((f) => ({ ...f, version: v }))
                }}
                onLoaderChange={(loader) => setForm((f) => ({ ...f, loader }))}
              />
            )}

            {step === 1 && (
              <DeployStepConfig
                form={form}
                budget={budget}
                memoryOptions={memoryOptions}
                recommendGB={recommendNewInstanceGB(budget.availableGB, budget.allocatableGB)}
                nameError={nameError}
                onNameChange={(name) => {
                  setNameError('')
                  setForm((f) => ({ ...f, name }))
                }}
                onMemoryChange={(memory) => {
                  // 用户改过内存后，推荐值不得再覆盖它
                  memoryTouchedRef.current = true
                  setForm((f) => ({ ...f, memory }))
                }}
              />
            )}

            {step === 2 && (
              <DeployStepConfirm
                form={form}
                loaders={loaders}
                eulaAgreed={eulaAgreed}
                onEulaAgreedChange={setEulaAgreed}
              />
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                取消
              </Button>
              {step > 0 && (
                <Button variant="outline" onClick={() => setStep((s) => s - 1)} aria-label="上一步">
                  上一步
                </Button>
              )}
              {step < 2 ? (
                <Button
                  onClick={handleNext}
                  disabled={step === 0 && form.version === ''}
                  aria-label="下一步"
                >
                  下一步
                </Button>
              ) : (
                // 按钮文案说「点下去的后果」，不说流程模式：「仅部署」曾与「部署并启动」
                // 并列为看似平级的选项，而前者实际通向「服务器起不来」——同一信息两个词，
                // 用户无法预判该点哪个。改为「部署（暂不启动）」，语义与勾选框解耦。
                <Button
                  onClick={() => void handleDeploy()}
                  disabled={duplicateDeploy}
                  aria-label={
                    duplicateDeploy
                      ? '已有部署在进行中'
                      : eulaAgreed
                        ? '部署并启动'
                        : '部署（暂不启动）'
                  }
                >
                  <CloudDownload className="size-4" aria-hidden />
                  {duplicateDeploy
                    ? '已有部署在进行中'
                    : eulaAgreed
                      ? '部署并启动'
                      : '部署（暂不启动）'}
                </Button>
              )}
            </DialogFooter>
          </>
        )}

        {/* dirty 关闭拦截确认 */}
        <ConfirmDialog
          open={closeConfirmOpen}
          onOpenChange={setCloseConfirmOpen}
          title="放弃部署配置？"
          description="当前配置尚未部署，关闭后表单内容将丢失。"
          cancelText="继续编辑"
          confirmText="放弃配置"
          danger
          onConfirm={() => {
            setCloseConfirmOpen(false)
            handleClose()
          }}
        />

        {/* 取消部署确认：中断不可撤销（已下载内容会被清理），故二次确认 */}
        <ConfirmDialog
          open={cancelConfirmOpen}
          onOpenChange={setCancelConfirmOpen}
          title="取消部署？"
          description="将中断下载/安装/首启，并清理未完成的实例目录；需要时重新发起部署。"
          cancelText="继续部署"
          confirmText="中断并清理"
          danger
          onConfirm={() => void handleCancelDeploy()}
        />
      </DialogContent>
    </Dialog>
  )
}
