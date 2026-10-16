/**
 * InstanceSettingsDialog —— 实例设置弹窗
 * - 字段：内存滑块 maxMemory/minMemory（0.5 GB 步进）+ Aikar Flags 开关
 *   （生成 G1GC 优化参数同步进 jvmArgs 多行输入）+ javaPath 可选输入 + jvmArgs 多行
 * - 预填（新旧兼容）：优先解析实例旧 startCommand；无则回退结构化字段
 *   （detail.maxMemory / detail.jvmArgs / detail.javaPath，服务端持久化主路径）
 * - 保存调 PUT /instances/:id（白名单 maxMemory/minMemory/jvmArgs/javaPath），成功后 toast +
 *   失效实例详情查询 + 关闭；遗留 startCommand 实例保存时一并传 startCommand:null 清除
 *   （否则 jvmArgs 空数组时 start() 回退旧命令，新配置被静默覆盖）
 * - 实时推送（MSMP）：走自己的 GET/POST /push-channel，但与启动配置同属一次事务——拨动只改
 *   草稿、落库在点保存时；推送失败另行交代且不关弹窗（结局不同，不能混成一句）
 *   读状态三态分明：读失败给重试与可自查位置、在途给占位、只有真读到才渲染开关
 *   （`?? false` 会把「不知道」显示成「已关闭」，那是肯定式假信息）
 * - 弹窗面走基座 bg-popover（全站统一）+ 表单输入实底；token 纪律，禁硬编码
 */
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ChevronDown,
  ChevronUp,
  Gauge,
  Info,
  Loader2,
  Radio,
  RefreshCw,
  Save,
  Settings,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { NoticeBanner, NoticeBannerAction } from '@/components/mcs/notice-banner'
import { cn } from '@/lib/utils'
import { instanceLabel } from '@/lib/instance-label'
import { getFriendlyErrorText } from '@/api/errors'
import { FALLBACK_POLL_INTERVAL_MS } from '@/api/queries'
import { useRestartPendingStore } from '@/stores/restart-pending'
import { usePushChannel, useSetPushChannel } from '@/features/world/queries'
import { useUpdateInstance } from '../queries'
import type { InstanceStatus, InstanceSummary, InstanceUpdatePayload } from '@/api/types'

// ── 启动命令解析/生成纯函数 ──

/** Java -Xmx/-Xms 不支持小数 G 后缀：整数用 G，非整数转 M */
export function formatMemForJvm(mem: number): string {
  if (mem === Math.round(mem)) return `${Math.round(mem)}G`
  return `${Math.round(mem * 1024)}M`
}

/** 解析持久化内存字段：'4G'/'2048M' 字符串；旧数据数值按 MB 处理（mock/旧库约定） */
export function parseMemoryValue(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return value / 1024
  const m = value.match(/^(\d+(?:\.\d+)?)(G|M)$/i)
  if (!m) return null
  return m[2]!.toUpperCase() === 'G' ? parseFloat(m[1]!) : parseFloat(m[1]!) / 1024
}

/** Aikar 生成的参数名全集（识别并移除旧生成行——参数值随内存变化，不能按整行精确匹配） */
const AIKAR_FLAG_NAMES = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent',
  '-XX:G1MaxNewSizePercent',
  '-XX:G1HeapRegionSize',
  '-XX:G1ReservePercent',
  '-XX:G1HeapWastePercent',
  '-XX:G1MixedGCCountTarget',
  '-XX:InitiatingHeapOccupancyPercent',
  '-XX:G1MixedGCLiveThresholdPercent',
  '-XX:G1RSetUpdatingPauseTimePercent',
  '-XX:SurvivorRatio',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold',
  '-Dusing.aikars.flags',
  '-Daikars.new.flags',
]

/** 判断参数行是否为 Aikar 生成行（参数名命中，可带 =值 后缀） */
export function isAikarFlagLine(line: string): boolean {
  return AIKAR_FLAG_NAMES.some((n) => line === n || line.startsWith(`${n}=`))
}

/** 按当前内存生成 Aikar Flags（内存 >=12G 用 40/50 档，否则 10/30） */
export function generateAikarFlags(allocMem: number): string[] {
  const big = allocMem >= 12
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${big ? '40' : '10'}`,
    `-XX:G1MaxNewSizePercent=${big ? '50' : '30'}`,
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
  ]
}

export interface ParsedStartCommand {
  /** 未命中 -Xmx 时的默认内存 */
  memory: number
  useAikarFlags: boolean
  jvmArgsTokens: string[]
}

/** 解析既有启动命令：内存 / Aikar 开关 / 附加参数 */
export function parseStartCommand(cmd: string | null | undefined): ParsedStartCommand {
  if (cmd == null || cmd.trim() === '') {
    return { memory: 2.0, useAikarFlags: true, jvmArgsTokens: [] }
  }
  let memory = 2.0
  const xmx = cmd.match(/-Xmx(\d+(?:\.\d+)?)(G|M)/)
  if (xmx) {
    const val = parseFloat(xmx[1]!)
    memory = xmx[2] === 'G' ? val : val / 1024
  }
  const useAikar = cmd.includes('aikars')

  // -jar 之前、排除 java/-Xms/-Xmx 及（开关开启时）Aikar 的 -XX/-D 标志
  const tokens = cmd
    .split('-jar')[0]!
    .split(/\s+/)
    .filter((t) => t.length > 0)
  const extraTokens: string[] = []
  for (const tok of tokens) {
    if (tok === 'java') continue
    if (tok.startsWith('-Xms') || tok.startsWith('-Xmx')) continue
    if (useAikar && (tok.startsWith('-XX:') || tok.startsWith('-XX+') || tok.startsWith('-D'))) {
      continue
    }
    extraTokens.push(tok)
  }
  return { memory, useAikarFlags: useAikar, jvmArgsTokens: extraTokens }
}

// ── 组件 ──────────────────────────────────────────────────────────

export interface InstanceSettingsDialogProps {
  instance: InstanceSummary
  /** 实例详情（GET /instances/:id 结果；含 startCommand/jvmArgs/javaPath/内存，缺失时用默认值） */
  detail: InstanceStatus | undefined
  /** 关闭回调（保存成功后同样触发） */
  onOpenChange: (open: boolean) => void
}

/** 多行输入 → 参数行数组（去空行、去首尾空白） */
function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Aikar 开关同步：开启按当前内存重新生成（替换旧生成行、保留自定义行），关闭仅移除生成行 */
function syncAikar(lines: string[], useAikar: boolean, allocMem: number): string[] {
  const kept = lines.filter((l) => !isAikarFlagLine(l))
  return useAikar ? [...kept, ...generateAikarFlags(allocMem)] : kept
}

/**
 * 保存结果文案：按**实际改了哪一类**分说。
 *
 * 两类改动都只有重启实例才生效，但来源不同（启动配置落实例记录、实时推送走 /push-channel），
 * 混成一句「设置已保存」会让用户不知道该去哪一项上核对。逐字未变时不宣称「已修改」——
 * 那会诱导一次无必要重启（保存按钮不判 dirty，原样保存也会走到这里）。
 */
function savedToastText(configDirty: boolean, pushDirty: boolean, pushNext: boolean): string {
  if (configDirty && pushDirty) return '设置已保存，重启实例后生效'
  if (pushDirty) return `实时推送已${pushNext ? '开启' : '关闭'}，重启实例后生效`
  if (configDirty) return '启动配置已保存，重启实例后生效'
  return '设置已保存（与之前一致，无需重启）'
}

/**
 * 设置行：图标 + 标题/说明 + 右侧控件的三栏行，弹窗内两处开关共用这一份配方
 * （行高、描边、内距只有一处声明——改一处即同时作用于两行）。
 * 圆角取 sm 而非卡片档 md：它是弹窗内的设置行，不是卡片面（卡片面配方归 components/mcs/card）。
 * 图标是否处于「亮起」态由调用点给：两行的亮灭跟随各自的开关，着色语义留在调用侧。
 */
function SettingsRow({
  icon: Icon,
  iconClassName,
  title,
  description,
  control,
}: {
  icon: LucideIcon
  iconClassName?: string
  title: string
  description: string
  control: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-3 py-2">
      <Icon className={cn('size-4 shrink-0', iconClassName)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-mcs-sm font-semibold text-mcs-text-default">{title}</p>
        <p className="text-mcs-xs text-mcs-text-muted">{description}</p>
      </div>
      {control}
    </div>
  )
}

export function InstanceSettingsDialog({
  instance,
  detail,
  onOpenChange,
}: InstanceSettingsDialogProps) {
  const updateMutation = useUpdateInstance()
  const markPending = useRestartPendingStore((s) => s.markPending)

  // ── 实时推送（MSMP）：与上面那份启动配置**同一次事务**——拨动只改本地草稿，
  //    落库发生在点「保存配置」时，故「取消」退得回来（它走自己的 /push-channel 接口，
  //    但提交时机必须与弹窗其余内容一致，否则弹窗里并存两套提交语义，用户只能靠猜） ──
  const pushStateQuery = usePushChannel(instance.id)
  const setPushChannel = useSetPushChannel(instance.id)
  /** 本地草稿（null = 跟随服务端值；读不到状态时不会产生草稿——那时开关不渲染） */
  const [pushDraft, setPushDraft] = useState<boolean | null>(null)
  const pushEnabled = pushDraft ?? pushStateQuery.data?.enabled ?? false
  /** 推送开关这一项是否偏离服务端现值（读不到现值时无从比较 ⇒ 不算脏，也不会提交） */
  const pushDirty = pushDraft !== null && pushDraft !== (pushStateQuery.data?.enabled ?? false)

  // ── 初始预填（挂载即打开：父组件条件渲染保证实例切换时重置）──
  const [initial] = useState(() => {
    const parsed = parseStartCommand(detail?.startCommand)
    // 旧 startCommand 优先（旧实例兼容）；无则回退结构化持久化字段
    const memory =
      detail?.startCommand != null && detail.startCommand.trim() !== ''
        ? parsed.memory
        : (parseMemoryValue(detail?.maxMemory) ?? 2.0)
    const useAikar =
      detail?.startCommand != null && detail.startCommand.trim() !== ''
        ? parsed.useAikarFlags
        : (detail?.jvmArgs?.some(isAikarFlagLine) ?? true)
    const jvmArgsInit =
      detail?.startCommand != null && detail.startCommand.trim() !== ''
        ? parsed.jvmArgsTokens
        : (detail?.jvmArgs ?? [])
    return {
      memory,
      useAikar,
      // 仅开关开启时同步生成，关闭时原样保留解析出的附加参数
      jvmArgsText: useAikar
        ? syncAikar(jvmArgsInit, true, memory).join('\n')
        : jvmArgsInit.join('\n'),
      javaPath: detail?.javaPath ?? '',
    }
  })

  const [allocatedMemory, setAllocatedMemory] = useState(initial.memory)
  const [useAikarFlags, setUseAikarFlags] = useState(initial.useAikar)
  const [jvmArgsText, setJvmArgsText] = useState(initial.jvmArgsText)
  const [javaPath, setJavaPath] = useState(initial.javaPath)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)

  /** 启动配置四条是否偏离初始值（不含推送开关——两者要分开说，见 savedToastText） */
  const configDirty =
    allocatedMemory !== initial.memory ||
    useAikarFlags !== initial.useAikar ||
    jvmArgsText !== initial.jvmArgsText ||
    javaPath !== initial.javaPath

  // 脏状态：弹窗里**任何**一项偏离服务端现值（启动配置 + 实时推送开关）。
  // 推送若不算进来，「拨了开关直接关闭」既不提示、也没人提醒它还没生效——两套提交语义的根源
  const dirty = configDirty || pushDirty

  // totalMemory > 1 用系统内存，否则 16 兜底
  const totalMax = detail && detail.totalMemory > 1 ? detail.totalMemory : 16
  const jvmArgsLines = splitLines(jvmArgsText)
  const startMem = Math.min(Math.max(allocatedMemory / 2, 1), allocatedMemory)

  const handleMemoryChange = (mem: number) => {
    setAllocatedMemory(mem)
    // 内存档位影响 G1NewSizePercent 等生成行 → 同步重生成
    setJvmArgsText((t) => syncAikar(splitLines(t), useAikarFlags, mem).join('\n'))
  }

  const handleToggleAikar = (on: boolean) => {
    setUseAikarFlags(on)
    setJvmArgsText((t) => syncAikar(splitLines(t), on, allocatedMemory).join('\n'))
  }

  /** 生成的启动命令预览（与提交的结构化配置一致：javaPath + -Xms/-Xmx + jvmArgs + -jar server.jar nogui） */
  const startCommandPreview = [
    javaPath.trim() === '' ? 'java' : javaPath.trim(),
    `-Xms${formatMemForJvm(startMem)}`,
    `-Xmx${formatMemForJvm(allocatedMemory)}`,
    ...jvmArgsLines,
    '-jar',
    'server.jar',
    'nogui',
  ].join(' ')

  const handleSave = async () => {
    if (isSaving) return
    const payload: InstanceUpdatePayload = {
      maxMemory: formatMemForJvm(allocatedMemory),
      minMemory: formatMemForJvm(startMem),
      jvmArgs: jvmArgsLines,
    }
    // 遗留 startCommand 实例：保存结构化配置时显式清除旧命令（startCommand:null）——否则
    // jvmArgs 为空数组时 start() 回退旧 startCommand，新内存配置被静默覆盖
    if (detail?.startCommand != null && detail.startCommand.trim() !== '') {
      payload.startCommand = null
    }
    // javaPath 留空或填 java → 不携带（服务端沿用默认）
    const javaPathTrimmed = javaPath.trim()
    if (javaPathTrimmed !== '' && javaPathTrimmed !== 'java') {
      payload.javaPath = javaPathTrimmed
    }
    setIsSaving(true)
    try {
      await updateMutation.mutateAsync({ instanceId: instance.id, payload })
      /* 置位与推送成败无关：配置已落库，这份「待重启」必须留下载体 */
      if (configDirty) markPending(instance.id)
      if (pushDirty) {
        try {
          await setPushChannel.mutateAsync(pushDraft === true)
          markPending(instance.id)
        } catch (e) {
          /* 推送这一项没落：两件事必须分开说，且**不能关弹窗**——关了用户就以为整笔都成了。
             弹窗留着，他再点一次「保存配置」即可重试（启动配置的 PATCH 与推送 POST 都幂等）。 */
          toast.error(
            `启动配置已保存，但实时推送设置失败：${getFriendlyErrorText(e)}（重启实例后生效）`,
          )
          setIsSaving(false)
          return
        }
      }
      toast.success(savedToastText(configDirty, pushDirty, pushDraft === true))
      onOpenChange(false)
    } catch (e) {
      toast.error(`保存失败：${getFriendlyErrorText(e)}`)
      setIsSaving(false)
    }
  }

  // 几何随 ui/input 基座，只保留 accent 焦点语义（启动配置项的「可写」视觉线索）
  const accentFocus = 'focus-visible:border-mcs-accent-border focus-visible:ring-mcs-accent-border'

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        /* 保存中不接受关闭：在途写入照样落库，放行会让确认框的「改动将丢失」变成假话 */
        if (!open && isSaving) return
        if (!open && dirty) {
          setCloseConfirmOpen(true)
        } else if (!open) {
          onOpenChange(false)
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-3 space-y-0">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-accent-bg-subtle text-mcs-accent-fg">
            <Settings className="size-4.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-mcs-xl font-semibold text-mcs-text-default">
              实例设置
            </DialogTitle>
            <DialogDescription className="truncate text-mcs-xs text-mcs-text-muted">
              {instanceLabel(instance)}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* ── 内存分配滑块（0.5 GB 步进）── */}
          <div className="flex flex-col gap-1.5">
            <span className="text-mcs-lg font-semibold text-mcs-text-default">内存分配</span>
            <p>
              <span className="font-mono text-mcs-xl font-semibold text-mcs-accent-fg">
                {allocatedMemory.toFixed(1)} GB
              </span>
              <span className="ml-1 text-mcs-sm text-mcs-text-muted">
                / {totalMax.toFixed(1)} GB
              </span>
            </p>
            <Slider
              aria-label="内存分配"
              min={1}
              max={totalMax}
              step={0.5}
              value={[allocatedMemory]}
              onValueChange={([v]) => handleMemoryChange(v!)}
            />
            <p className="text-mcs-xs text-mcs-text-muted">拖拽滑块分配该实例可用的最大内存</p>
          </div>

          {/* ── Aikar Flags 开关（开启时生成 G1GC 优化参数同步进 jvmArgs）── */}
          <SettingsRow
            icon={Gauge}
            iconClassName={useAikarFlags ? 'text-mcs-accent-fg' : 'text-mcs-text-muted'}
            title="JVM 优化 (Aikar's Flags)"
            description="使用 MCS 社区优化的 G1GC 参数，改善 GC 停顿"
            control={
              <Switch
                checked={useAikarFlags}
                onCheckedChange={handleToggleAikar}
                aria-label="JVM 优化 (Aikar's Flags)"
              />
            }
          />

          {/* ── 生成的启动命令预览 ── */}
          <div className="flex flex-col gap-1.5">
            <span className="text-mcs-xs font-semibold text-mcs-text-muted">生成的启动命令</span>
            <pre className="w-full overflow-x-auto whitespace-pre-wrap break-all rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default p-3 font-mono text-mcs-xs text-mcs-accent-fg">
              {startCommandPreview}
            </pre>
          </div>

          {/* ── 高级参数（javaPath + jvmArgs + 参数说明，展开/收起）── */}
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            aria-expanded={showAdvanced}
            className="flex cursor-pointer items-center gap-1 rounded-mcs-sm text-mcs-sm font-medium text-mcs-text-muted transition-colors hover:bg-mcs-state-hover hover:text-mcs-text-default"
          >
            {showAdvanced ? (
              <ChevronUp className="size-4" aria-hidden />
            ) : (
              <ChevronDown className="size-4" aria-hidden />
            )}
            高级参数
          </button>

          {showAdvanced && (
            <div className="flex flex-col gap-4">
              {/* Java 路径（可选）：默认 java；服务端 PUT 校验必须为已存在 java 可执行文件 */}
              <div className="flex flex-col gap-1.5">
                <span className="text-mcs-xs font-medium text-mcs-text-muted">
                  Java 路径（可选）
                </span>
                <Input
                  value={javaPath}
                  onChange={(e) => setJavaPath(e.target.value)}
                  aria-label="Java 路径（可选）"
                  placeholder="java"
                  className={accentFocus}
                />
                <p className="text-mcs-xs text-mcs-text-muted">
                  留空或填 java 使用系统默认；填路径时需为已存在的 java 可执行文件
                </p>
              </div>

              {/* JVM 参数多行输入（服务端 start() 白名单：仅 -X/-D 前缀、-jar 与 nogui） */}
              <div className="flex flex-col gap-1.5">
                <span className="text-mcs-xs font-medium text-mcs-text-muted">
                  JVM 参数（每行一个）
                </span>
                <Textarea
                  value={jvmArgsText}
                  onChange={(e) => setJvmArgsText(e.target.value)}
                  aria-label="JVM 参数（每行一个）"
                  rows={5}
                  placeholder={'每行一个 JVM 参数，例如：\n-Xmx4G\n-XX:+UseG1GC'}
                  className={cn(accentFocus, 'min-h-24 resize-y font-mono')}
                />
                <p className="text-mcs-xs text-mcs-text-muted">
                  仅支持 -X/-D 前缀参数、-jar 与 nogui；-jar 路径需位于实例目录内
                </p>
              </div>

              {/* 参数说明（逐行展示实际提交的参数） */}
              <NoticeBanner variant="info" form="card">
                <p className="flex items-center gap-1.5 text-mcs-xs font-semibold">
                  <Info className="size-3.5" aria-hidden />
                  参数说明
                </p>
                <dl className="mt-1.5 flex flex-col gap-1">
                  {(
                    [
                      [`-Xms${formatMemForJvm(startMem)}`, '初始堆内存（自动设为最大值的一半）'],
                      [`-Xmx${formatMemForJvm(allocatedMemory)}`, '最大堆内存（根据滑块值决定）'],
                      ['-jar server.jar', '指定服务器 JAR 文件'],
                      ['nogui', '禁用图形界面'],
                      ...jvmArgsLines.map((arg) => [arg, '自定义 JVM 参数'] as [string, string]),
                    ] as [string, string][]
                  ).map(([arg, desc]) => (
                    <div key={arg} className="flex items-baseline gap-2">
                      <dt
                        className="w-30 shrink-0 truncate font-mono text-mcs-xs text-mcs-accent-fg"
                        title={arg}
                      >
                        {arg}
                      </dt>
                      <dd className="min-w-0 flex-1 text-mcs-xs text-mcs-text-muted">{desc}</dd>
                    </div>
                  ))}
                </dl>
              </NoticeBanner>
            </div>
          )}
        </div>

        {/* ── 实时推送（MSMP）：一条分隔线只分**主题**（启动配置 / 实时推送设置），不分事务——
             它与上面那份启动配置同属这一次「保存配置 / 取消」。做成即时落库的独立设置会让
             同一弹窗里在两套提交语义之间切换：用户拨完开关以为「都保存好了」，或者反过来
             以为「没点保存所以什么都没发生」，而实际已经落库、取消退不回 ── */}
        <div className="flex flex-col gap-2 border-t border-mcs-border-muted pt-4">
          <SettingsRow
            icon={Radio}
            iconClassName={pushEnabled ? 'text-mcs-accent-fg' : 'text-mcs-text-muted'}
            title="实时推送"
            /* 只讲结果（用户拿到什么刷新时机），不出现 host/port/凭据这类运维视角字段。
               明写「重启后生效」：MSMP 只在服务端启动时读这份配置，运行中开启也拿不到实时 */
            description={`开启后面板能实时收到状态变化；关闭则每 ${FALLBACK_POLL_INTERVAL_MS / 1000} 秒刷新一次。重启实例后生效`}
            control={
              /* 三态分明：读失败说「不知道」（`?? false` 会把「不知道」显示成「已关闭」，
                 那是肯定式假信息）；在途给占位而不是留空；只有真读到状态才落成开关。
                 占位判据取 `isLoading`（真的在取）而非 `isPending`——后者还含「查询被禁用」，
                 连接未就绪时会留下一个永不消失的骨架；占位尺寸对齐 ui/switch 基座，加载完不跳位 */
              pushStateQuery.isError ? (
                <span className="shrink-0 text-mcs-xs text-mcs-text-muted">状态未知</span>
              ) : pushStateQuery.isLoading ? (
                /* 圆角取基座给的 `rounded-mcs-md`：cn 未登记 `rounded-mcs-*` 词汇表，这里再压一个
                   `rounded-full` 会两类并存、胜负交给样式表顺序（写了也不生效）。20px 高的盒子上
                   12px 档被浏览器收敛为半高，视觉与 ui/switch 的胶囊一致，加载完不跳形 */
                <Skeleton
                  role="status"
                  aria-label="正在读取实时推送状态"
                  className="h-5 w-9 shrink-0"
                />
              ) : (
                pushStateQuery.data && (
                  <Switch
                    checked={pushEnabled}
                    /* 只改本地草稿：落库在「保存配置」，故「取消」退得回来、关闭前也会提示未保存 */
                    onCheckedChange={setPushDraft}
                    aria-label="实时推送"
                  />
                )
              )
            }
          />
          {pushStateQuery.isError && (
            <NoticeBanner variant="warning">
              {/* 文案成块、动作靠右：整句折行不产生孤字，重试按钮也不被挤进文本流 */}
              <span className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  读不到实时推送状态：{getFriendlyErrorText(pushStateQuery.error)}
                  。可在世界页的「服务器属性」里核对这一项的实际值
                </span>
                {/* 读失败不是终态：重试复用同一个查询的重取，不另开第二条读路径 */}
                <NoticeBannerAction
                  onClick={() => void pushStateQuery.refetch()}
                  disabled={pushStateQuery.isFetching}
                >
                  <RefreshCw className="size-3" aria-hidden />
                  重试
                </NoticeBannerAction>
              </span>
            </NoticeBanner>
          )}
        </div>

        {/* ── 底部操作：取消 / 保存配置 ── */}
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            disabled={isSaving}
            onClick={() => {
              if (dirty) {
                setCloseConfirmOpen(true)
              } else {
                onOpenChange(false)
              }
            }}
          >
            取消
          </Button>
          {/* detail 未就绪时禁用保存：弹窗预填的是默认值，保存会静默覆盖真实持久化配置 */}
          <Button
            className="flex-1"
            disabled={isSaving || detail === undefined}
            onClick={() => void handleSave()}
            title={detail === undefined ? '实例详情加载中，暂不可保存' : undefined}
          >
            {isSaving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            {isSaving ? '保存中...' : '保存配置'}
          </Button>
        </div>
      </DialogContent>

      {/* ── 脏状态关闭确认 ──
          推送开关也在这条判据里，不得为它写豁免说明——需要一句话解释的交互，
          用户就无法从界面本身推断行为 */}
      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={(open) => !open && setCloseConfirmOpen(false)}
        title="未保存的更改"
        description="上面有未保存的更改，关闭后这些改动将丢失。"
        confirmText="不保存"
        cancelText="继续编辑"
        onConfirm={() => {
          setCloseConfirmOpen(false)
          onOpenChange(false)
        }}
      />
    </Dialog>
  )
}
