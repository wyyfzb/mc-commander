/**
 * 排障面板（帮助页「排障」标签页）
 *
 * 为什么在帮助页：面板自身的错、实例崩溃史都是**用户主动求助**时才要的东西。仪表盘那张崩溃卡
 * 解决的是「刚崩了、现在就要看」；这里解决的是「我来查一下为什么」，它天然落在「帮助」这条
 * 心理路径上，故不进常态首屏。
 *
 * 数据全部来自既有只读契约，**不做额外探测**（页面自己说明这一点，不让用户误以为面板会主动去连
 * 他的服务器）：实例状态（运行态 / RCON / MSMP 推送面）、机器资源（磁盘 / 内存，阈值由服务端下发）、
 * 崩溃历史、面板自身错误日志。
 *
 * 自检的每一条都必须给得出**依据**，且判不出来就说「未知」——一条没有依据的「正常」比没有这一项更糟。
 */
import { useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardCopy,
  Info,
  FileWarning,
  History,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Link } from 'react-router'
import { queryFailed } from '@/lib/query-phase'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { CountBadge } from '@/components/mcs/count-badge'
import { EmptyState } from '@/components/mcs/empty-state'
import { StatusPill } from '@/components/mcs/status-pill'
import { SEMANTIC_TONE_CLASSES, TONE_SELECTED_CLASSES } from '@/components/mcs/tone'
import type { ChipTone } from '@/components/mcs/chip'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { formatRelativeTime, formatUptime } from '@/lib/format'
import { isVersionAtLeast } from '@/lib/mc-version'
import { MSMP_MIN_MC_VERSION } from '@mc-commander/schemas'
import { useNow } from '@/hooks/use-now'
import {
  useCrashArtifact,
  useCrashHistory,
  useInstanceStatus,
  useSystemErrors,
  useSystemStats,
} from '@/api/queries'
import type { CrashArtifactHistory, InstanceStatus, PanelErrors, SystemStats } from '@/api/types'
import { useServerStore } from '@/stores/server'
import { CrashReportView, RECENT_CRASH_MS } from '@/features/dashboard/components/crash-report-card'

// ── 自检 ────────────────────────────────────────────────────────────────────

type CheckTone = 'ok' | 'warn' | 'bad' | 'unknown'

export interface Check {
  key: string
  name: string
  tone: CheckTone
  /** 结论：一句话说清「这项怎么样」 */
  verdict: string
  /** 依据：实测值或判据来源，缺了它这条结论就不可信 */
  basis: string
  action?: { label: string; to: string }
}

const TONE_ICON: Record<CheckTone, { icon: LucideIcon; className: string }> = {
  ok: { icon: CircleCheck, className: SEMANTIC_TONE_CLASSES.success.text },
  warn: { icon: TriangleAlert, className: SEMANTIC_TONE_CLASSES.warning.text },
  bad: { icon: CircleX, className: SEMANTIC_TONE_CLASSES.error.text },
  // 未知不染语义色：它不是「轻微的问题」，而是「这条判不出来」
  unknown: { icon: CircleHelp, className: 'text-mcs-text-muted' },
}

const NO_INSTANCE: Pick<Check, 'tone' | 'verdict' | 'basis'> = {
  tone: 'unknown',
  verdict: '未选择实例',
  basis: '先在顶栏选择一个实例，这一项才有判据',
}

/**
 * 判不出时的结论。**「没选实例」与「状态没拿到」必须分开**：顶栏明明写着实例名，
 * 页面却说「未选择实例」，会把用户推去改一个不存在的问题。
 */
function statusMissing(instanceId: string | null): Pick<Check, 'tone' | 'verdict' | 'basis'> {
  return instanceId
    ? { tone: 'unknown', verdict: '读不到实例状态', basis: '面板没取到状态（请求失败或还没返回）' }
    : NO_INSTANCE
}

function percent(n: number): string {
  return `${n.toFixed(1)}%`
}

/**
 * 组装自检项。纯函数：判据与文案的用例不必穿过网络层，也不受取数时机影响。
 *
 * 阈值一律用服务端下发的（`diskAlert` / `memoryAlert`），前端不另写一份数字——写两份必然漂移。
 */
export function buildChecks(input: {
  instanceId: string | null
  status?: InstanceStatus
  stats?: SystemStats
  history?: CrashArtifactHistory
  errors?: PanelErrors
  /** 判定时点（时效类判据用）。注入而非内部取 Date.now()：否则用例随真实时间漂移 */
  nowMs?: number
}): Check[] {
  const { instanceId, status, stats, history, errors, nowMs = Date.now() } = input
  const checks: Check[] = []

  // ① 实例运行：熔断（连续崩溃保护）是最高优先的信号——它意味着「启动也会立刻再崩」
  if (!status) {
    checks.push({ key: 'instance', name: '实例运行', ...statusMissing(instanceId) })
  } else if (status.circuitBreakerTripped) {
    checks.push({
      key: 'instance',
      name: '实例运行',
      tone: 'bad',
      verdict: `已熔断（连续崩溃 ${status.consecutiveCrashes} 次）`,
      basis: '熔断是面板对连续崩溃的保护：先查明崩溃原因再启动，否则大概率会再崩一次',
      action: { label: '去实例页', to: `/instances/${instanceId}` },
    })
  } else if (!status.isRunning) {
    checks.push({
      key: 'instance',
      name: '实例运行',
      tone: 'warn',
      verdict: '未运行',
      basis: status.autoRestart
        ? '已开启自动重启：面板会尝试拉起（连续失败会熔断）'
        : '未开启自动重启：需要手动启动',
      action: { label: '去实例页', to: `/instances/${instanceId}` },
    })
  } else {
    checks.push({
      key: 'instance',
      name: '实例运行',
      tone: 'ok',
      verdict: '运行中',
      basis: `已运行 ${formatUptime(status.uptime)}`,
    })
  }

  // ② 命令通道：实例没运行时「未连通」是正常状态，不能报成问题（否则每台停着的实例都挂一条警告）
  if (!status) {
    checks.push({ key: 'rcon', name: '命令通道（RCON）', ...statusMissing(instanceId) })
  } else if (!status.isRunning) {
    checks.push({
      key: 'rcon',
      name: '命令通道（RCON）',
      tone: 'unknown',
      verdict: '实例未运行，无需连通',
      basis: 'RCON 只在实例运行时才有意义',
    })
  } else if (status.capabilities.rcon) {
    checks.push({
      key: 'rcon',
      name: '命令通道（RCON）',
      tone: 'ok',
      verdict: '已连通',
      basis: '命令下发、玩家管理可用',
    })
  } else {
    checks.push({
      key: 'rcon',
      name: '命令通道（RCON）',
      tone: 'warn',
      verdict: '未连通',
      basis: '实例在运行但 RCON 连不上：命令与玩家管理会失败，检查端口与密码配置',
      action: { label: '去实例页', to: `/instances/${instanceId}` },
    })
  }

  // ③ 推送面：查询面与推送面分开判（查询成功不代表推送连着，端口随机、密钥由服务端写回）
  if (!status) {
    checks.push({ key: 'msmp', name: '实时推送（MSMP）', ...statusMissing(instanceId) })
  } else if (status.capabilities.msmpPush) {
    checks.push({
      key: 'msmp',
      name: '实时推送（MSMP）',
      tone: 'ok',
      verdict: '已连通',
      basis: '玩家名单与统计走实时推送',
    })
  } else if (!isVersionAtLeast(status.mcVersion, MSMP_MIN_MC_VERSION, true)) {
    // 老版本没有这个面：报「不适用」并给出结论，不报「未开启」——对 MC 1.21.4 的用户，
    // 一条他无法处理的警告等于噪音，而自检里每多一条噪音，其余条目就更不被当回事
    checks.push({
      key: 'msmp',
      name: '实时推送（MSMP）',
      // 这是**确定结论**（这个版本没有这个面）而不是「判不出来」：标成 unknown 会占住
      // 「需要看」的位置，把用户引向一件他无事可做的事
      tone: 'ok',
      verdict: `不适用（${status.mcVersion} 无此通道）`,
      basis: `MSMP 需要 MC ${MSMP_MIN_MC_VERSION} 及以上；名单与统计按 30 秒轮询更新，不影响使用`,
    })
  } else {
    checks.push({
      key: 'msmp',
      name: '实时推送（MSMP）',
      tone: 'warn',
      verdict: status.capabilities.msmp ? '查询面可用，推送面未连通' : '未开启',
      basis: `名单与统计会退化为 30 秒轮询；${status.mcVersion} 支持推送通道，开启后为实时数据`,
      action: { label: '去世界页', to: '/world' },
    })
  }

  // ④ 磁盘余量：阈值来自服务端，前端只做比较
  const disk = stats?.diskUsage?.primary
  const diskAlert = stats?.diskAlert
  if (!disk || !diskAlert) {
    checks.push({
      key: 'disk',
      name: '磁盘余量',
      tone: 'unknown',
      verdict: '读不到磁盘占用',
      basis: '资源统计还没取到（或这台机器读不到挂载点信息）',
    })
  } else {
    const tone: CheckTone =
      disk.percent >= diskAlert.errorPercent
        ? 'bad'
        : disk.percent >= diskAlert.warningPercent
          ? 'warn'
          : 'ok'
    checks.push({
      key: 'disk',
      name: '磁盘余量',
      tone,
      verdict: `已用 ${percent(disk.percent)}`,
      basis: `阈值 ${diskAlert.warningPercent}% 提醒 / ${diskAlert.errorPercent}% 告警 · ${disk.usedGB.toFixed(1)} / ${disk.totalGB.toFixed(1)} GB（${disk.mountpoint}）`,
    })
  }

  // ⑤ 内存：整机口径（与 memoryPercent 同源），不是 JVM 堆——判「机器吃紧」只能用这个口径
  const memoryAlert = stats?.memoryAlert
  if (!stats || !memoryAlert) {
    checks.push({
      key: 'memory',
      name: '整机内存',
      tone: 'unknown',
      verdict: '读不到内存占用',
      basis: '资源统计还没取到',
    })
  } else {
    const over = stats.memoryPercent >= memoryAlert.warningPercent
    checks.push({
      key: 'memory',
      name: '整机内存',
      tone: over ? 'warn' : 'ok',
      verdict: `已用 ${percent(stats.memoryPercent)}`,
      // 单位已是 GB（服务端 systemStats 的 memoryUsage/totalMemory 即 GB），不要再除 1024
      basis: `阈值 ${memoryAlert.warningPercent}% · ${stats.memoryUsage.toFixed(1)} / ${stats.totalMemory.toFixed(0)} GB（整机口径，非 JVM 堆）`,
    })
  }

  // ⑥ 崩溃记录：产物文件本身即持久面，所以「几次」是能数出来的事实
  if (!instanceId) {
    checks.push({ key: 'crash', name: '崩溃记录', ...NO_INSTANCE })
  } else if (!history) {
    checks.push({
      key: 'crash',
      name: '崩溃记录',
      tone: 'unknown',
      verdict: '读不到崩溃历史',
      basis: '请求还没回来或读取失败（与「从未崩溃过」在接口上同形，故不当作正常）',
    })
  } else if (history.total === 0) {
    checks.push({
      key: 'crash',
      name: '崩溃记录',
      tone: 'ok',
      verdict: '没有读到崩溃记录',
      // 枚举失败与「从未崩溃过」在接口上同形，所以不能断言「实例目录里没有产物」
      basis: '可能从未崩溃过，也可能是产物目录读不到',
    })
  } else {
    const newest = history.items[0]
    const newestAgo = newest ? nowMs - newest.mtimeMs : Number.POSITIVE_INFINITY
    const recent = newestAgo < RECENT_CRASH_MS || (status?.consecutiveCrashes ?? 0) > 0
    const when = formatRelativeTime(
      newest ? new Date(newest.mtimeMs).toISOString() : null,
      nowMs,
      '时间未知',
    )
    // 崩溃是事实但不是持续故障：只有「刚崩过」才值得提醒，否则一条几周前的崩溃会长期挂在
    // 自检里，把真正要看的那条淹掉。历史本身仍在下面完整列出
    checks.push({
      key: 'crash',
      name: '崩溃记录',
      tone: recent ? 'warn' : 'ok',
      verdict: recent
        ? `最近 24 小时内崩过（共 ${history.total} 次）`
        : `当前稳定（共 ${history.total} 次）`,
      // 只给时间：原因紧接着就在崩溃历史里逐条列出，同一句话写两遍没有收益
      basis: `最近一次 ${when}`,
      action: { label: '看崩溃历史', to: '#crash-history' },
    })
  }

  // ⑦ 面板自身错误：`available=false` 既可能是文件不存在，也可能是存在但读不到——两种都只说
  // 「没有读到」，不替用户断言「面板没有出错」
  const errorCount = errors?.available ? errors.entries.length : 0
  if (!errors) {
    // 请求失败或还没返回：这一项**判不出来**。说成「没有读到错误」是在用绿灯替面板背书
    // （契约里 available=false 也是「没读到」，故两者都不能当正常）
    checks.push({
      key: 'panel',
      name: '面板自身错误',
      tone: 'unknown',
      verdict: '读不到面板错误日志',
      basis: '请求失败或还没返回；这一项判不出来，不代表面板没出错',
    })
  } else if (errorCount === 0) {
    checks.push({
      key: 'panel',
      name: '面板自身错误',
      tone: 'ok',
      verdict: '没有读到错误',
      basis: '面板错误日志里没有可读条目（日志文件不存在，或存在但读不到）',
    })
  } else {
    const latest = errors!.entries[0]!
    checks.push({
      key: 'panel',
      name: '面板自身错误',
      tone: 'warn',
      verdict: `记录 ${errorCount} 条`,
      basis: `${formatRelativeTime(latest.time, nowMs, '时间未知')}：${latest.message.split('\n')[0]}`,
      action: { label: '看错误列表', to: '#panel-errors' },
    })
  }

  return checks
}

/**
 * 自检结果的复制载荷：结论 + 依据逐条列出。
 *
 * 为什么要它能被带走：排障的最后一公里常常是「把现象交给维护者」。截图会丢文本、也不便检索，
 * 所以这里给一份可直接粘贴的文本；依据行必须一起带上——只给结论，接收方无从判断。
 */
export function selfCheckCopyText(
  checks: Check[],
  meta: { instanceName?: string; mcVersion?: string; nowMs: number },
): string {
  const head = ['MC_Commander 自检结果']
  if (meta.instanceName)
    head.push(`实例：${meta.instanceName}${meta.mcVersion ? `（MC ${meta.mcVersion}）` : ''}`)
  head.push(`时间：${new Date(meta.nowMs).toISOString()}`)
  const lines = checks.map((c) => `- ${c.name}：${c.verdict}｜${c.basis}`)
  return [...head, '', ...lines].join('\n')
}

function CheckRow({ check }: { check: Check }) {
  const { icon: Icon, className } = TONE_ICON[check.tone]
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Icon className={cn('mt-1 size-4 shrink-0', className)} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex flex-wrap items-baseline gap-x-2">
          {/* 标签弱于结论：扫读时先该看到「已用 92%」而不是「磁盘余量」 */}
          <span className="text-mcs-sm text-mcs-text-muted">{check.name}</span>
          <span className="text-mcs-sm font-medium text-mcs-text-default">{check.verdict}</span>
        </p>
        <p className="text-mcs-xs break-all text-mcs-text-muted">{check.basis}</p>
      </div>
      {check.action &&
        // 页内锚点用原生 <a>：路由的 pushState 不会滚动（本仓未挂 ScrollRestoration），
        // 用 <Link to="#…"> 只会改地址栏，用户点了没反应；跨页跳转才走路由
        (check.action.to.startsWith('#') ? (
          <a
            href={check.action.to}
            className="shrink-0 text-mcs-xs font-medium text-mcs-accent-fg underline-offset-2 hover:underline"
          >
            {check.action.label}
          </a>
        ) : (
          <Link
            to={check.action.to}
            className="shrink-0 text-mcs-xs font-medium text-mcs-accent-fg underline-offset-2 hover:underline"
          >
            {check.action.label}
          </Link>
        ))}
    </li>
  )
}

/** 复制自检结果并给出反馈：成功/失败都要说，静默失败等于让用户以为已经贴出去了 */
async function copySelfCheck(
  checks: Check[],
  meta: { instanceName?: string; mcVersion?: string; nowMs: number },
) {
  const ok = await copyText(selfCheckCopyText(checks, meta))
  if (ok) toast.success('自检结果已复制', { duration: 1500 })
  else toast.error('复制失败，请手动复制')
}

/** 排序：有事的排前面。自检的价值是「哪一项要处理」，把它埋在六行绿灯之后等于没有 */
const TONE_ORDER: Record<CheckTone, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 }

function SelfCheckCard({
  checks,
  instanceName,
  mcVersion,
  nowMs,
}: {
  checks: Check[]
  instanceName?: string
  mcVersion?: string
  nowMs: number
}) {
  const [showNormal, setShowNormal] = useState(false)
  const bad = checks.filter((c) => c.tone === 'bad').length
  const warn = checks.filter((c) => c.tone === 'warn').length
  const unknown = checks.filter((c) => c.tone === 'unknown').length
  const ordered = [...checks].sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone])
  const attention = ordered.filter((c) => c.tone !== 'ok')
  const normal = ordered.filter((c) => c.tone === 'ok')
  const visible = showNormal ? ordered : attention
  // 摘要按**最差项**聚合：只在确实什么都判不出来时才说「未能判定」，
  // 只在没有任何 bad/warn/unknown 时才说「全部正常」——否则绿灯会替面板背书
  const summary: { tone: ChipTone; text: string; title?: string } = bad
    ? { tone: 'error', text: `${bad} 项异常` }
    : warn
      ? { tone: 'warning', text: `${warn} 项注意` }
      : unknown
        ? { tone: 'muted', text: `${unknown} 项未能判定` }
        : { tone: 'success', text: '全部正常' }
  // 聚合结论要指名：只有数字的话，用户还得回去逐行比对
  if (attention.length > 0 && attention.length <= 3) {
    summary.title = attention.map((c) => c.name).join('、')
  }

  return (
    <Card size="default" className="flex flex-col gap-3">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="size-4 text-mcs-text-muted" aria-hidden="true" />
          自检
        </CardTitle>
        <StatusPill tone={summary.tone} title={summary.title}>
          {summary.text}
        </StatusPill>
      </CardHeader>
      <CardBody className="flex flex-col gap-2">
        <p className="text-mcs-xs text-mcs-text-muted">
          依据面板已有的数据逐项判定，
          <strong className="font-medium">不会主动去连你的服务器</strong>
          （实时状态来自面板自己维护的连接与最近一次采样）。
        </p>
        <ul className="flex flex-col divide-y divide-mcs-border-subtle">
          {visible.map((c) => (
            <CheckRow key={c.key} check={c} />
          ))}
        </ul>
        {normal.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showNormal}
            onClick={() => setShowNormal((v) => !v)}
            className="self-start"
          >
            {showNormal ? '收起正常项' : `其余 ${normal.length} 项正常`}
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void copySelfCheck(checks, { instanceName, mcVersion, nowMs })}
          >
            <ClipboardCopy className="size-3.5" aria-hidden="true" />
            复制自检结果
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

// ── 崩溃历史 ────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  'crash-report': '崩溃报告',
  'jvm-crash': 'JVM 崩溃日志',
}

/**
 * 单份产物的完整诊断。取不到时说清是「这份已被清理」——列表里仍留着它的摘要，
 * 不能悄悄换成最新那份（那会让用户以为自己点错了）。
 */
function CrashArtifactDetail({ instanceId, fileName }: { instanceId: string; fileName: string }) {
  const query = useCrashArtifact(instanceId, fileName)
  const nowMs = useNow()

  if (query.isLoading) {
    return <p className="text-mcs-xs text-mcs-text-muted">读取中…</p>
  }
  if (queryFailed(query)) {
    return (
      <NoticeBanner variant="warning" icon={Info}>
        读取这份产物失败（面板没能取到它），可以稍后重试或直接看服务器目录里的崩溃产物文件。
      </NoticeBanner>
    )
  }
  if (!query.data) {
    return (
      <NoticeBanner variant="warning" icon={Info}>
        {fileName} 已不在（日志轮转或手工清理会删掉旧产物），上面列表里的摘要仍然有效。
      </NoticeBanner>
    )
  }
  return <CrashReportView data={query.data} nowMs={nowMs} />
}

/**
 * 崩溃历史一节 = 可选列表 + 选中那份的完整诊断。
 * 诊断呈现复用仪表盘的 `CrashReportView`：同一套解析只有一份渲染实现，两处同源。
 */
function CrashHistorySection() {
  const instanceId = useServerStore((s) => s.instanceId)
  const statusQuery = useInstanceStatus(instanceId)
  const historyQuery = useCrashHistory(instanceId)
  const nowMs = useNow()
  const history = historyQuery.data
  const [selected, setSelected] = useState<string | null>(null)

  const items = history?.items ?? []
  // 默认看最新一份；选中项已从列表消失（清理/刷新）时回落到最新，不留一个点不中的选中态
  const selectedFile = items.some((i) => i.fileName === selected)
    ? selected
    : (items[0]?.fileName ?? null)

  return (
    // 锚点放在容器上：卡座不声明 id（基座只收它列出的属性），自检里的「看崩溃历史」要能跳到这里
    <div id="crash-history" className="flex flex-col gap-4">
      <Card size="default" className="flex flex-col gap-3">
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <History className="size-4 text-mcs-text-muted" aria-hidden="true" />
            崩溃历史
          </CardTitle>
          {history && history.total > 0 && (
            <CountBadge title={`${history.total} 次`}>{history.total}</CountBadge>
          )}
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {!instanceId ? (
            <EmptyState
              icon={History}
              title="未选择实例"
              hint="崩溃历史按实例记录，先在顶栏选一个"
            />
          ) : !history ? (
            <p className="text-mcs-xs text-mcs-text-muted">读取中…</p>
          ) : history.total === 0 ? (
            <EmptyState
              icon={CircleCheck}
              title="没有读到崩溃记录"
              // 枚举失败与「从未崩溃过」在接口上同形（都是空列表），不能替服务端断言原因
              hint="可能从未崩溃过，也可能是产物目录读不到"
            />
          ) : (
            <>
              <p className="text-mcs-xs text-mcs-text-muted">
                {statusQuery.data?.name ?? '当前实例'} · 崩溃产物跨面板重启留存
              </p>
              <ul className="flex flex-col gap-1">
                {items.map((item) => (
                  <li key={item.fileName}>
                    {/* 条目即选择器：整块可点；选中态用 tone 的强描边（不只靠颜色，另带 aria-current） */}
                    <button
                      type="button"
                      aria-current={item.fileName === selectedFile ? 'true' : undefined}
                      onClick={() => setSelected(item.fileName)}
                      className={cn(
                        'flex w-full flex-col gap-1 rounded-mcs-sm border p-2 text-left',
                        item.fileName === selectedFile
                          ? TONE_SELECTED_CLASSES
                          : 'border-transparent hover:bg-mcs-state-hover',
                        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-mcs-focus-ring',
                      )}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-mcs-2xs text-mcs-text-muted">
                          {formatRelativeTime(
                            new Date(item.mtimeMs).toISOString(),
                            nowMs,
                            '时间未知',
                          )}
                        </span>
                        <span className="text-mcs-2xs text-mcs-text-muted">
                          {KIND_LABEL[item.kind] ?? item.kind} · {item.fileName}
                        </span>
                      </div>
                      <p className="text-mcs-sm break-all text-mcs-text-default">
                        {item.reason ?? '未记录原因'}
                      </p>
                      {item.detail && (
                        <p className="truncate text-mcs-xs text-mcs-text-muted" title={item.detail}>
                          {item.detail}
                        </p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {history.hasMore && (
                <p className="text-mcs-xs text-mcs-text-muted">
                  只显示最近 {history.items.length} 次（共 {history.total} 次）
                </p>
              )}
            </>
          )}
        </CardBody>
      </Card>
      {instanceId && selectedFile && (
        <CrashArtifactDetail instanceId={instanceId} fileName={selectedFile} />
      )}
    </div>
  )
}

// ── 面板自身错误 ────────────────────────────────────────────────────────────

/** 复制载荷上限：错误消息可能带长堆栈，避免把剪贴板与粘贴框塞满 */
const COPY_TEXT_MAX = 8000

/** 默认展开几条：错误量级本就低频，超过这个数说明是批量故障，其余折叠后按需看 */
const EXPANDED_LIMIT = 3

const LEVEL_TONES: Record<string, ChipTone> = {
  ERROR: 'error',
  WARN: 'warning',
  INFO: 'info',
}

/**
 * 复制正文：只放日志里的原始内容，不加面板的推断。
 *
 * 截断必须**留痕**：消息体本身可能被切在中间，接收方把半截堆栈当完整堆栈比少几条更难查。
 * 尾部说明放在截断判定之后，否则一段长堆栈会把「只取了最近 N 条」一起挤掉——那是
 * 「这不是全部」的唯一交代。
 */
export function panelErrorsCopyText(data: PanelErrors): string {
  const head = ['MC_Commander 面板错误反馈', `日志文件：${data.logFile}`]
  const body = data.entries.map((e) => `[${e.time}] [${e.level}] ${e.message}`)
  const tail = data.hasMore ? [`（只取了最近 ${data.entries.length} 条，更早的见日志文件）`] : []
  const text = [...head, ...body].join('\n')
  const truncated = text.length > COPY_TEXT_MAX
  return [truncated ? `${text.slice(0, COPY_TEXT_MAX)}\n…（正文已截断）` : text, ...tail].join('\n')
}

function PanelErrorsCard() {
  const errorsQuery = useSystemErrors()
  const nowMs = useNow()
  const data = errorsQuery.data
  const [expanded, setExpanded] = useState(false)

  const failed = queryFailed(errorsQuery)
  const entries = data?.available ? data.entries : []
  const visible = expanded ? entries : entries.slice(0, EXPANDED_LIMIT)

  const copy = async () => {
    if (!data) return
    const ok = await copyText(panelErrorsCopyText(data))
    if (ok) toast.success('错误日志已复制', { duration: 1500 })
    else toast.error('复制失败，请手动复制')
  }

  return (
    <div id="panel-errors">
      <Card size="default" className="flex flex-col gap-3">
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <FileWarning className="size-4 text-mcs-text-muted" aria-hidden="true" />
            面板自身错误
          </CardTitle>
          {entries.length > 0 && (
            <CountBadge title={`${entries.length} 条`}>{entries.length}</CountBadge>
          )}
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-mcs-xs text-mcs-text-muted">
            面板自己在运行中记录的错误（不是你服务器的崩溃）。遇到「操作失败但界面没说为什么」时，
            这里通常有原因。
          </p>

          {failed ? (
            // 请求失败要有自己的样子：面板日志读不到时，排障页最该告诉用户的就是这件事
            <NoticeBanner variant="warning" icon={Info}>
              读取面板错误日志失败（面板没能取到它）。日志文件本身可能没问题，可稍后重试。
            </NoticeBanner>
          ) : !data ? (
            <p className="text-mcs-xs text-mcs-text-muted">读取中…</p>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={CircleCheck}
              title="没有读到错误"
              // 契约里 available=false 是「没读到任何一条」：文件不存在与存在但读不到同形，
              // 说成「日志文件还不存在」就是替服务端断言它给不出的东西
              hint={
                data.available
                  ? '日志文件里没有条目'
                  : '日志文件不存在，或存在但面板读不到（这两种在这条接口上同形）'
              }
            />
          ) : (
            <>
              <ul className="flex flex-col gap-3">
                {visible.map((entry, i) => (
                  <li key={`${entry.time}-${i}`} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={LEVEL_TONES[entry.level] ?? 'muted'}>
                        {entry.level}
                      </StatusPill>
                      <span className="font-mono text-mcs-2xs text-mcs-text-muted">
                        {formatRelativeTime(entry.time, nowMs, '时间未知')}
                      </span>
                    </div>
                    <pre
                      tabIndex={0}
                      aria-label="面板错误正文"
                      className="max-h-40 overflow-auto rounded-mcs-sm bg-mcs-bg-subtle p-2 text-mcs-xs whitespace-pre-wrap text-mcs-text-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-mcs-focus-ring"
                    >
                      {entry.message}
                    </pre>
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="xs" variant="ghost" onClick={() => void copy()}>
                  <ClipboardCopy className="size-3.5" aria-hidden="true" />
                  复制错误日志
                </Button>
                {entries.length > EXPANDED_LIMIT && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? '只看最近几条' : `展开其余 ${entries.length - EXPANDED_LIMIT} 条`}
                  </Button>
                )}
              </div>

              {/* 完整日志在哪：自托管的用户要自己 SSH 去看原文时，这是唯一能告诉他路径的地方 */}
              <p
                className="font-mono text-mcs-xs break-all text-mcs-text-muted"
                title={data?.logFile}
              >
                日志文件：{data?.logFile}
              </p>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

export function DiagnosticsPanel(): ReactNode {
  const instanceId = useServerStore((s) => s.instanceId)
  const statusQuery = useInstanceStatus(instanceId)
  const statsQuery = useSystemStats()
  const historyQuery = useCrashHistory(instanceId)
  const errorsQuery = useSystemErrors()

  const nowMs = useNow()
  const checks = buildChecks({
    instanceId,
    status: statusQuery.data,
    stats: statsQuery.data,
    history: historyQuery.data,
    errors: errorsQuery.data,
    nowMs,
  })

  return (
    <div className="flex flex-col gap-4">
      <SelfCheckCard
        checks={checks}
        instanceName={statusQuery.data?.name}
        mcVersion={statusQuery.data?.mcVersion}
        nowMs={nowMs}
      />
      <CrashHistorySection />
      <PanelErrorsCard />
    </div>
  )
}
