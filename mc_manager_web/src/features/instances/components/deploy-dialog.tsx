/**
 * DeployDialog —— 部署新实例三步向导
 * - 自建三步 Stepper：圆点序号 + 标签 + 连接线（token 纪律，禁硬编码）
 * - 步骤① 服务端类型 5 卡单选（SERVER_TYPE_LABELS + 类型说明一行）+ 版本 Select
 *   （useServerVersions 按类型拉取；切换类型触发新查询）+ Java 推荐提示 + fabric/forge loader Select
 * - 步骤② 实例名称 Input（默认空）+ 内存 Select 档位（1G/2G/4G/8G，默认 2G）
 * - 步骤③ 确认摘要（类型/版本/名称/内存/Java 推荐）+「开始部署」
 * - 部署中：进度条（percent×100）+ stage 中文标签（DEPLOY_STAGE_LABELS）+ transferred/total MB
 *   格式化（服务端 got 下载进度，单位字节）；禁用上一步与关闭（ESC/遮罩拦截）
 * - 成功：绿色结果块（实例 id/名称/版本）+「完成」关闭（onDeployed(result)）；
 *   失败：error 块 + 可重试（回到步骤①，保留表单值供调整）
 * - 数据流：useDeployStore（progress/deploying/lastResult/startDeploy/finishDeploy/resetDeploy）
 *   + useDeployInstance().mutateAsync；关闭时 resetDeploy
 * - dirty 关闭拦截：表单与基线对比（自动回填的版本/加载器同步基线，不误判 dirty）
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import {
  Check,
  CheckCircle2,
  CloudDownload,
  FileText,
  Flame,
  Info,
  LayoutGrid,
  Loader2,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { getFriendlyErrorText } from '@/api/errors'
import {
  FALLBACK_VERSIONS,
  SERVER_TYPES,
  SERVER_TYPE_LABELS,
  recommendedJavaVersion,
  type ServerType,
} from '@/lib/mc-deploy'
import { DEPLOY_STAGE_LABELS, useDeployStore } from '@/stores/deploy'
import { useOverview } from '@/api/queries'
import { useDeployInstance, useServerVersions } from '../queries'
import type { DeployRequest, DeployResult } from '@/api/types'

// ── 本地 UI 常量（文案非领域数据，不入 mc-deploy.ts）────────────────

/** 服务端类型卡片说明一行 */
const SERVER_TYPE_DESCRIPTIONS: Record<ServerType, string> = {
  vanilla: '官方原版服务端，纯净体验',
  paper: '高性能优化，插件生态丰富',
  fabric: '轻量模组加载器，启动快',
  forge: '老牌模组加载器，模组量大',
  purpur: 'Paper 分支，玩法增强',
}

/** 服务端类型图标 */
const SERVER_TYPE_ICONS: Record<ServerType, LucideIcon> = {
  vanilla: LayoutGrid,
  paper: FileText,
  fabric: Wrench,
  forge: Flame,
  purpur: Sparkles,
}

/** 内存档位（1G/2G/4G/8G；默认 2G） */
const MEMORY_OPTIONS = ['1G', '2G', '4G', '8G'] as const
const DEFAULT_MEMORY = '2G'

/** 内存档位 → GB 数值 */
function memoryToGB(memory: string): number {
  return Number.parseInt(memory, 10)
}

/**
 * 系统总内存 → 推荐档位：
 * total×0.5 clamp [1, total] → 0.5 步进取整 → 映射到最近档位（Web Select 化）
 */
function recommendedMemoryGB(totalMemory: number): number {
  const recommended = Math.min(Math.max(totalMemory * 0.5, 1), totalMemory)
  const stepped = Math.max(Math.round(recommended * 2) / 2, 1)
  return MEMORY_OPTIONS.map(memoryToGB).reduce((best, v) =>
    Math.abs(v - stepped) < Math.abs(best - stepped) ? v : best,
  )
}

/** 三步 Stepper 标签 */
const STEP_LABELS = ['选择服务端', '实例配置', '确认部署'] as const

const EMPTY_STRINGS: string[] = []

/** 表单值（初始态与基线） */
interface DeployForm {
  type: ServerType
  version: string
  loader: string
  name: string
  memory: string
}

const INITIAL_FORM: DeployForm = {
  type: 'paper',
  version: '',
  loader: '',
  name: '',
  memory: DEFAULT_MEMORY,
}

/** 传输字节 → MB 文案（服务端 got downloadProgress 单位字节；整数档去小数） */
function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)
}

/** 自建三步 Stepper：圆点序号 + 标签 + 连接线（token 纪律） */
function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2" role="group" aria-label="部署步骤">
      {STEP_LABELS.map((label, i) => (
        <Fragment key={label}>
          {i > 0 && (
            <div
              aria-hidden
              className={cn(
                'h-px flex-1 rounded-full',
                i <= step ? 'bg-mcs-accent-border' : 'bg-mcs-border-muted',
              )}
            />
          )}
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden={i < step}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border text-mcs-xs transition-colors',
                i < step
                  ? 'border-mcs-accent bg-mcs-accent text-mcs-on-accent'
                  : i === step
                    ? 'border-mcs-accent bg-mcs-accent-bg-subtle text-mcs-accent-fg'
                    : 'border-mcs-border-default text-mcs-text-subtle',
              )}
            >
              {i < step ? <Check className="size-3" aria-hidden /> : i + 1}
            </span>
            <span
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'text-mcs-sm whitespace-nowrap',
                i === step ? 'text-mcs-text-default' : 'text-mcs-text-subtle',
              )}
            >
              {label}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  )
}

export interface DeployDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 部署成功后通知页面（刷新实例列表/切换实例由页面负责） */
  onDeployed: (result: DeployResult) => void
}

export function DeployDialog({ open, onOpenChange, onDeployed }: DeployDialogProps) {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<DeployForm>({ ...INITIAL_FORM })
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
  const versionsQuery = useServerVersions(form.type)
  // 版本列表失败 → 本地缓存兜底（仍可部署）
  const versions =
    versionsQuery.data?.versions ??
    (versionsQuery.isError ? [...FALLBACK_VERSIONS] : EMPTY_STRINGS)
  const loaders = versionsQuery.data?.loaders ?? EMPTY_STRINGS

  // 系统内存 → 推荐档位（用户手动调整后不覆盖）
  const overviewQuery = useOverview()
  const totalMemory = overviewQuery.data?.totalMemory ?? 4
  const memoryTouchedRef = useRef(false)

  // 打开时重置表单与部署状态（自动回填前的基线同步见下方 effect）
  useEffect(() => {
    if (!open) return
    setStep(0)
    setForm({ ...INITIAL_FORM })
    baselineRef.current = { ...INITIAL_FORM }
    setResult(null)
    setNameError('')
    setCloseConfirmOpen(false)
    useDeployStore.getState().resetDeploy()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaders, open])

  /** dirty：与基线对比（用户改动过任意字段） */
  const dirty =
    form.type !== baselineRef.current.type ||
    form.version !== baselineRef.current.version ||
    form.loader !== baselineRef.current.loader ||
    form.name !== baselineRef.current.name ||
    form.memory !== baselineRef.current.memory

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
    const payload: DeployRequest = {
      type: form.type,
      mcVersion: form.version,
      instanceName: form.name.trim(),
      maxMemory: form.memory,
    }
    if ((form.type === 'fabric' || form.type === 'forge') && form.loader !== '') {
      payload.loaderVersion = form.loader
    }
    startDeploy()
    try {
      const deployed = await deployMutation.mutateAsync(payload)
      setResult(deployed)
      finishDeploy({ ok: true, instanceId: deployed.id })
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

  const pct = progress != null ? Math.round(progress.percent * 100) : 0
  const stageLabel = progress
    ? (DEPLOY_STAGE_LABELS[progress.stage] ?? progress.stage)
    : '正在部署…'
  const showTransfer = progress != null && progress.total > 0
  const stageError = progress?.stage === 'error' ? progress.error : undefined

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
        )}

        {showSuccess && result && (
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
            <DialogFooter>
              <Button onClick={handleComplete}>完成</Button>
            </DialogFooter>
          </div>
        )}

        {showError && (
          <div className="flex flex-col gap-3">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-mcs-sm border border-mcs-error-border bg-mcs-error-bg-subtle px-3 py-2.5"
            >
              <XCircle className="mt-px size-4 shrink-0 text-mcs-error-fg" aria-hidden />
              <p className="text-mcs-sm text-mcs-error-fg">
                {lastResult?.error ?? '部署失败，请重试'}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                取消
              </Button>
              <Button onClick={handleRetry}>重试</Button>
            </DialogFooter>
          </div>
        )}

        {!showProgress && !showSuccess && !showError && (
          <>
            <Stepper step={step} />

            {step === 0 && (
              <div className="flex flex-col gap-3">
                {/* 服务端类型 5 卡单选 */}
                <div className="flex flex-col gap-2">
                  <Label>服务端类型</Label>
                  <RadioGroup
                    value={form.type}
                    onValueChange={(v) => changeType(v as ServerType)}
                    className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                  >
                    {SERVER_TYPES.map((type) => {
                      const selected = form.type === type
                      const Icon = SERVER_TYPE_ICONS[type]
                      return (
                        <label
                          key={type}
                          className={cn(
                            'flex cursor-pointer flex-col gap-0.5 rounded-mcs-sm border px-2.5 py-2 transition-colors',
                            selected
                              ? 'border-mcs-accent bg-mcs-accent-bg-subtle text-mcs-text-default'
                              : 'border-mcs-border-default text-mcs-text-muted hover:bg-mcs-bg-hover',
                          )}
                        >
                          <RadioGroupItem value={type} className="sr-only" />
                          <span className="flex items-center gap-1.5 text-mcs-sm">
                            <Icon
                              className={cn(
                                'size-3.5 shrink-0',
                                selected ? 'text-mcs-accent-fg' : 'text-mcs-text-subtle',
                              )}
                              aria-hidden
                            />
                            {SERVER_TYPE_LABELS[type]}
                          </span>
                          <span className="text-mcs-xs text-mcs-text-subtle">
                            {SERVER_TYPE_DESCRIPTIONS[type]}
                          </span>
                        </label>
                      )
                    })}
                  </RadioGroup>
                </div>

                {/* 版本下拉（useServerVersions 按类型拉取；切换类型触发新查询） */}
                <div className="flex flex-col gap-2">
                  <Label>Minecraft 版本</Label>
                  <Select
                    value={form.version}
                    onValueChange={(v) => {
                      setNameError('')
                      setForm((f) => ({ ...f, version: v }))
                    }}
                    disabled={versions.length === 0}
                  >
                    <SelectTrigger className="w-full" aria-label="选择 Minecraft 版本">
                      <SelectValue
                        placeholder={
                          versionsQuery.isLoading
                            ? '版本列表加载中…'
                            : versions.length === 0
                              ? '未获取到版本列表'
                              : '请选择版本'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {versions.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {versionsQuery.isError && (
                    <p className="text-mcs-xs text-mcs-warning-fg">
                      无法获取远程版本列表，使用本地缓存
                    </p>
                  )}
                  {form.version !== '' && (
                    <div className="flex items-center gap-1.5 rounded-mcs-sm border border-mcs-info-border bg-mcs-info-bg-subtle px-2.5 py-1.5 text-mcs-xs text-mcs-info-fg">
                      <Info className="size-3.5 shrink-0" aria-hidden />
                      推荐 Java 版本：{recommendedJavaVersion(form.version)}（服务端会自动检测并使用合适的 Java 版本）
                    </div>
                  )}
                </div>

                {/* fabric/forge 加载器下拉（versions 响应带 loaders 时显示） */}
                {loaders.length > 0 && (form.type === 'fabric' || form.type === 'forge') && (
                  <div className="flex flex-col gap-2">
                    <Label>加载器版本</Label>
                    <Select
                      value={form.loader}
                      onValueChange={(v) => setForm((f) => ({ ...f, loader: v }))}
                    >
                      <SelectTrigger className="w-full" aria-label="选择加载器版本">
                        <SelectValue placeholder="请选择加载器版本" />
                      </SelectTrigger>
                      <SelectContent>
                        {loaders.map((l) => (
                          <SelectItem key={l} value={l}>
                            {l}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {step === 1 && (
              <div className="flex flex-col gap-3">
                {/* 实例名称 */}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="deploy-instance-name">实例名称</Label>
                  <Input
                    id="deploy-instance-name"
                    value={form.name}
                    onChange={(e) => {
                      setNameError('')
                      setForm((f) => ({ ...f, name: e.target.value }))
                    }}
                    placeholder="例如: 我的生存服"
                    maxLength={50}
                  />
                  {nameError !== '' && (
                    <p className="text-mcs-xs text-mcs-error-fg">{nameError}</p>
                  )}
                </div>

                {/* 内存档位 */}
                <div className="flex flex-col gap-2">
                  <Label>内存分配</Label>
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-mcs-2xl font-bold text-mcs-accent">
                      {memoryToGB(form.memory).toFixed(1)} GB
                    </span>
                    <span className="text-mcs-sm text-mcs-text-subtle">
                      / {totalMemory.toFixed(1)} GB
                    </span>
                  </div>
                  <Select
                    value={form.memory}
                    onValueChange={(v) => {
                      // 用户手动调整后不再被推荐值覆盖
                      memoryTouchedRef.current = true
                      setForm((f) => ({ ...f, memory: v }))
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="选择内存分配">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MEMORY_OPTIONS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-mcs-xs text-mcs-text-subtle">
                    选择 Minecraft 服务器可用的最大内存
                  </p>
                  {/* 推荐提示（<=8G 推荐 50%，>8G 推荐 70%） */}
                  <p className="flex items-center gap-1.5 text-mcs-xs text-mcs-warning-fg">
                    <Info className="size-3.5 shrink-0" aria-hidden />
                    {totalMemory <= 8
                      ? `推荐分配 ${(totalMemory * 0.5).toFixed(1)} GB（系统保留 ${(totalMemory - totalMemory * 0.5).toFixed(1)} GB）`
                      : `推荐分配 ${(totalMemory * 0.7).toFixed(1)} GB（系统保留 ${(totalMemory - totalMemory * 0.7).toFixed(1)} GB）`}
                  </p>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="flex flex-col gap-2 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted py-1">
                {(
                  [
                    ['服务端类型', SERVER_TYPE_LABELS[form.type]],
                    ['版本', form.version],
                    ...(loaders.length > 0 && (form.type === 'fabric' || form.type === 'forge') && form.loader !== ''
                      ? [['加载器', form.loader] as const]
                      : []),
                    ['实例名称', form.name.trim()],
                    ['内存', form.memory],
                    ['推荐 Java', recommendedJavaVersion(form.version)],
                  ] as const
                ).map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 text-mcs-sm"
                  >
                    <span className="shrink-0 text-mcs-text-subtle">{label}</span>
                    <span className="min-w-0 truncate font-mono text-mcs-text-default">
                      {value}
                    </span>
                  </div>
                ))}
              </div>
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
                <Button onClick={() => void handleDeploy()}>
                  <CloudDownload className="size-4" aria-hidden />
                  开始部署
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
