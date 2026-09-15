/**
 * DeployDialog —— 部署新实例三步向导（编排层：状态机 + 数据流，展示件见 ./deploy/）
 * - 三步流程状态：step 推进 / 表单与基线（dirty 判定）/ EULA / 自动启动 / 结果 / 关闭确认
 * - 步骤① 服务端类型 5 卡单选 + 版本 Select（useServerVersions 按类型拉取，切换类型触发新查询）
 *   + fabric/forge loader Select；步骤② 名称 + 内存档位；步骤③ 确认摘要 + EULA
 * - 自动回填：版本/加载器列表就绪回填首个；系统内存 → 推荐档位（用户手动调整后不覆盖），
 *   回填值同步基线不算 dirty
 * - EULA 同意随部署请求下发（服务端据此写 eula.txt）；部署成功且已同意时发启动指令
 *   （POST /start），结果块展示启动状态（首启闭环，issue 312）
 * - 视图状态机：部署中 → 成功 → 失败 → 表单三步；恢复场景保留进行中进度（issue 352）；
 *   服务端报告在途部署时禁止再次发起（J29，消除重复部署）；部署中禁用上一步与关闭（ESC/遮罩拦截）
 * - dirty 关闭拦截：表单与基线对比（自动回填的版本/加载器同步基线，不误判 dirty）
 * - 数据流：useDeployStore（progress/deploying/lastResult/startDeploy/finishDeploy/resetDeploy）
 *   + useDeployStatusFallback（挂载/断线兜底快照）+ useDeployInstance().mutateAsync；关闭时 resetDeploy
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
import { apiPost } from '@/api/client'
import { getFriendlyErrorText } from '@/api/errors'
import { useConnectionStore } from '@/stores/connection'
import { FALLBACK_VERSIONS, type ServerType } from '@/lib/mc-deploy'
import { useDeployStore } from '@/stores/deploy'
import { useOverview } from '@/api/queries'
import { useDeployInstance, useServerVersions } from '../queries'
import { useDeployStatusFallback } from '../hooks/use-deploy-status-fallback'
import type { DeployRequest, DeployResult } from '@/api/types'
import { INITIAL_FORM, type AutoStartState, type DeployForm } from './deploy/types'
import { recommendedMemoryGB } from './deploy/utils'
import { Stepper } from './deploy/stepper'
import { DeployErrorView, DeployProgressView, DeploySuccessView } from './deploy/views'
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

  const deploying = useDeployStore((s) => s.deploying)
  const progress = useDeployStore((s) => s.progress)
  const lastResult = useDeployStore((s) => s.lastResult)
  const startDeploy = useDeployStore((s) => s.startDeploy)
  const finishDeploy = useDeployStore((s) => s.finishDeploy)
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

  // 系统内存 → 推荐档位（用户手动调整后不覆盖）
  const overviewQuery = useOverview()
  const totalMemory = overviewQuery.data?.totalMemory ?? 4
  const memoryTouchedRef = useRef(false)

  // 打开时重置表单与部署状态（自动回填前的基线同步见下方 effect）。
  // 恢复场景例外：store 中已有进行中的部署（页面刷新后 WS 连接补发恢复的
  // 进度）→ 保留进度直接显示部署视图，重置会丢掉恢复态（issue 352）
  useEffect(() => {
    if (!open) return
    const store = useDeployStore.getState()
    const resuming =
      store.deploying &&
      store.progress != null &&
      store.progress.stage !== 'complete' &&
      store.progress.stage !== 'error'
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
  // 仅用户未手动调整内存时覆盖；打开向导时重置手动标记（与表单重置同周期）
  useEffect(() => {
    if (open) memoryTouchedRef.current = false
  }, [open])

  useEffect(() => {
    const recommended = recommendedMemoryGB(totalMemory)
    if (memoryTouchedRef.current) return
    setForm((f) => {
      const next = `${recommended}G`
      if (f.memory === next) return f
      baselineRef.current = { ...baselineRef.current, memory: next }
      return { ...f, memory: next }
    })
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- recommendedMemoryGB 模块级纯函数，setter/ref 稳定引用
  }, [totalMemory, open])

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
    !(progress?.stage === 'complete' || progress?.stage === 'error')

  const changeType = (type: ServerType) => {
    if (type === form.type) return
    // 切换类型重置版本与加载器（新数据就绪后自动回填）
    setForm((f) => ({ ...f, type, version: '', loader: '' }))
  }

  const handleNext = () => {
    if (step === 1 && form.name.trim() === '') {
      setNameError('请填写实例名称')
      return
    }
    setNameError('')
    setStep((s) => Math.min(s + 1, 2))
  }

  const handleDeploy = async () => {
    if (form.version === '' || form.name.trim() === '') return
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
      // 首启闭环（issue 312）：EULA 已随部署请求写入，这里只需发启动指令（启动异步，状态在仪表盘/终端可见）
      if (eulaAgreed) {
        setAutoStart('pending')
        try {
          await apiPost(`/api/v1/instances/${deployed.id}/start`, config)
          setAutoStart('ok')
          toast.success('部署完成，服务器开始启动')
        } catch (e) {
          setAutoStart('failed')
          toast.error(`自动启动失败：${getFriendlyErrorText(e)}`)
        }
      }
    } catch (e) {
      finishDeploy({ ok: false, error: getFriendlyErrorText(e) })
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

  // ── 视图状态机：部署中 → 成功 → 失败 → 表单三步 ──
  const showProgress = deploying || (progress != null && result === null && lastResult?.ok !== false)
  const showSuccess = result !== null
  const showError = lastResult?.ok === false && result === null && !deploying

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

        {showProgress && <DeployProgressView progress={progress} />}

        {showSuccess && result && (
          <DeploySuccessView result={result} autoStart={autoStart} onComplete={handleComplete} />
        )}

        {showError && (
          <DeployErrorView
            errorText={lastResult?.error ?? '部署失败，请重试'}
            onCancel={handleClose}
            onRetry={handleRetry}
          />
        )}

        {!showProgress && !showSuccess && !showError && (
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
                totalMemory={totalMemory}
                nameError={nameError}
                onNameChange={(name) => {
                  setNameError('')
                  setForm((f) => ({ ...f, name }))
                }}
                onMemoryChange={(memory) => {
                  // 用户手动调整后不再被推荐值覆盖
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
                <Button onClick={handleNext} disabled={step === 0 && form.version === ''} aria-label="下一步">
                  下一步
                </Button>
              ) : (
                <Button
                  onClick={() => void handleDeploy()}
                  disabled={duplicateDeploy}
                  aria-label={
                    duplicateDeploy
                      ? '已有部署在进行中'
                      : eulaAgreed
                        ? '部署并启动'
                        : '仅部署'
                  }
                >
                  <CloudDownload className="size-4" aria-hidden />
                  {duplicateDeploy ? '已有部署在进行中' : eulaAgreed ? '部署并启动' : '仅部署'}
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
      </DialogContent>
    </Dialog>
  )
}
