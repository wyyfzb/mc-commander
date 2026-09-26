/**
 * InstanceSettingsDialog —— 实例启动配置弹窗
 * - 字段：内存滑块 maxMemory/minMemory（0.5 GB 步进）+ Aikar Flags 开关
 *   （生成 G1GC 优化参数同步进 jvmArgs 多行输入）+ javaPath 可选输入 + jvmArgs 多行
 * - 预填（新旧兼容）：优先解析实例旧 startCommand；无则回退结构化字段
 *   （detail.maxMemory / detail.jvmArgs / detail.javaPath，服务端持久化主路径）
 * - 保存调 PUT /instances/:id（白名单 maxMemory/minMemory/jvmArgs/javaPath），成功后 toast +
 *   失效实例详情查询 + 关闭；遗留 startCommand 实例保存时一并传 startCommand:null 清除
 *   （否则 jvmArgs 空数组时 start() 回退旧命令，新配置被静默覆盖）
 * - 弹窗面走基座 bg-popover（全站统一）+ 表单输入实底；token 纪律，禁硬编码
 */
import { useState } from 'react'
import { ChevronDown, ChevronUp, Gauge, Info, Loader2, Save, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { cn } from '@/lib/utils'
import { instanceLabel } from '@/lib/instance-label'
import { getFriendlyErrorText } from '@/api/errors'
import { useRestartPendingStore } from '@/stores/restart-pending'
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

export function InstanceSettingsDialog({
  instance,
  detail,
  onOpenChange,
}: InstanceSettingsDialogProps) {
  const updateMutation = useUpdateInstance()
  const markPending = useRestartPendingStore((s) => s.markPending)

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

  // 脏状态：任一字段偏离初始值
  const dirty =
    allocatedMemory !== initial.memory ||
    useAikarFlags !== initial.useAikar ||
    jvmArgsText !== initial.jvmArgsText ||
    javaPath !== initial.javaPath

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
      /* 只在真的改动了才置位：保存按钮不判 dirty（详情未就绪也要能点），原样保存也走这条路
         ——无条件置位会宣称「启动配置已修改」而实际逐字未变，诱导一次无必要重启。
         改回原值是合法的 dirty=false 路径（用户改了又改回来），此时同样不该提示。 */
      if (dirty) {
        /* 置「待重启生效」：本弹窗保存后即关闭，是持续状态却没有可见载体（级别 3 的未满足
           要求，见 docs/design-review-guidelines.md）。置位后由实例页页头的常驻指示器承担，
           toast 只留动作回执本分——此前口径临时压在 toast 文案里，几秒即散。 */
        markPending(instance.id)
      }
      toast.success(
        dirty ? '启动配置已保存，重启实例后生效' : '启动配置已保存（与之前一致，无需重启）',
      )
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
              启动配置
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
          <div className="flex items-center gap-3 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-3 py-2">
            <Gauge
              className={cn(
                'size-4 shrink-0',
                useAikarFlags ? 'text-mcs-accent-fg' : 'text-mcs-text-muted',
              )}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-mcs-sm font-semibold text-mcs-text-default">
                JVM 优化 (Aikar&apos;s Flags)
              </p>
              <p className="text-mcs-xs text-mcs-text-muted">
                使用 MCS 社区优化的 G1GC 参数，改善 GC 停顿
              </p>
            </div>
            <Switch
              checked={useAikarFlags}
              onCheckedChange={handleToggleAikar}
              aria-label="JVM 优化 (Aikar's Flags)"
            />
          </div>

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

      {/* ── 脏状态关闭确认 ── */}
      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={(open) => !open && setCloseConfirmOpen(false)}
        title="未保存的更改"
        description="当前有未保存的配置更改，关闭后这些修改将丢失。"
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
