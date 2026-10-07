import { useState } from 'react'
import { ChevronDown, Copy, ExternalLink, FileWarning, Info } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Button } from '@/components/ui/button'
import { useCrashArtifact } from '@/api/queries'
import type { CrashArtifact, CrashDiagnosisEntry } from '@/api/types'
import { copyText } from '@/lib/clipboard'
import { formatRelativeTime } from '@/lib/format'
import { useNow } from '@/hooks/use-now'

/**
 * 崩溃诊断产物卡：把最近一次崩溃的要点摆到实例页。
 *
 * 为什么需要它：MC 崩溃报告（`crash-reports/crash-*.txt`）与 JVM 崩溃日志
 * （`hs_err_pid*.log`）此前只出现在备份排除清单里，从未呈现给用户——排查崩溃时
 * 用户被推回「请检查日志」，而这两份恰是最有价值的诊断文件。
 *
 * 只读展示，不进备份（快照不被诊断产物撑大）。产物不存在时**整卡不渲染**：
 * 没崩过的实例不该多一张空卡。
 *
 * 结论来自服务端的诊断词条（键只锚崩溃报告自身的语义字段），面板不在这里做任何推断：
 * 未收录时如实说「不猜」，把原始字段摆出来并给出反馈入口。
 */

/** 开源仓库主页（关于页另有一份字面量，本仓尚无共享常量） */
const REPO_URL = 'https://github.com/wyyfzb/mc-commander'

/** 词条依据的展示词：区分「实机观测到的样本」与「从该版本包里静态提取」 */
const EVIDENCE_LABELS: Record<string, string> = {
  实测: '实测样本',
  静态提取: '版本静态提取',
}

/** Issue 预填正文上限：预填走 URL，过长会被浏览器/服务端截断，截在这里比截在跳转后可控 */
const FEEDBACK_BODY_MAX = 1200

/** 复制载荷上限：含调用栈与原文，避免一份超大崩溃把剪贴板与粘贴框塞满 */
const FEEDBACK_TEXT_MAX = 8000

/** 反馈正文：只放产物里的原始字段与原文，不放面板的推断 */
function feedbackText(data: CrashArtifact): string {
  const lines = ['MC_Commander 崩溃诊断反馈', `产物文件：${data.fileName ?? '未知'}`]
  if (data.minecraftVersion) lines.push(`崩溃报告里的 MC 版本：${data.minecraftVersion}`)
  if (data.description) lines.push(`Description: ${data.description}`)
  if (data.exception) lines.push(`顶层异常：${data.exception}`)
  for (const field of data.summary ?? []) lines.push(`${field.label}：${field.value}`)
  if (data.stack?.length) lines.push('', '调用栈：', ...data.stack)
  if (data.excerpt) lines.push('', '产物原文：', data.excerpt)
  return lines.join('\n').slice(0, FEEDBACK_TEXT_MAX)
}

/**
 * 反馈用的 Issue 预填链接。
 * 标题按产物类型分岔：崩溃报告是我们「没有收录这条」，而 JVM 崩溃日志**没有可锚的键**，
 * 说成「未收录」是面板无从知道的判断。
 */
function feedbackIssueUrl(data: CrashArtifact): string {
  const subject = data.description ?? data.exception ?? data.fileName ?? '未知崩溃'
  const title =
    data.kind === 'jvm-crash'
      ? `[崩溃诊断] JVM 崩溃日志：${data.fileName ?? '未知文件'}`
      : `[崩溃诊断] 未收录：${subject}`
  const body = `${feedbackText(data).slice(0, FEEDBACK_BODY_MAX)}\n\n（由 MC_Commander 面板生成）`
  return `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

/** 已核实字段的展示顺序由服务端给定（Ordered），此处只决定版式 */
function FieldGrid({ fields }: { fields: NonNullable<CrashArtifact['summary']> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {fields.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-mcs-2xs text-mcs-text-muted">{f.label}</dt>
          <dd className="text-mcs-xs break-all text-mcs-text-default">{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 折叠区：栈与原文默认收起——它们是排查细节，不该把卡片撑成一面墙 */
function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-7 items-center gap-1 self-start rounded-mcs-sm px-2 text-mcs-xs text-mcs-text-muted hover:bg-mcs-state-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-mcs-focus-ring"
      >
        <ChevronDown
          className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
        {title}
      </button>
      {open && children}
    </div>
  )
}

/**
 * 诊断结论区：命中就给结论与处置动作；未命中就如实说「不猜」，并给出反馈入口。
 * 放在卡片正文最前——用户先要答案，再看细节。
 */
function DiagnosisBlock({ data }: { data: CrashArtifact }) {
  const diagnosis = data.diagnosis
  if (!diagnosis) return null

  if (diagnosis.matched && diagnosis.entry) {
    const entry: CrashDiagnosisEntry = diagnosis.entry
    const versions = entry.verifiedVersions.filter(Boolean)
    return (
      <div className="flex flex-col gap-1.5" data-testid="crash-diagnosis">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-mcs-sm font-semibold text-mcs-text-default">{entry.title}</span>
          <span className="text-mcs-2xs text-mcs-text-muted">
            依据：{entry.evidence.map((e) => EVIDENCE_LABELS[e] ?? e).join(' / ')}
            {versions.length > 0 && ` · 已验证 ${versions.join(' / ')}`}
          </span>
        </div>
        <p className="text-mcs-xs text-mcs-text-muted">{entry.detail}</p>
        <ul className="flex list-disc flex-col gap-0.5 pl-4">
          {entry.actions.map((action) => (
            <li key={action} className="text-mcs-xs text-mcs-text-default">
              {action}
            </li>
          ))}
        </ul>
        {/* 版本不符只提示适用范围，不否定键的命中——结论仍是证据，只是不能照搬到别的版本。
            两个值都非空才说得成句：畸形数据不该渲染出「当前实例是 ；」 */}
        {diagnosis.verifiedForInstance === false &&
          versions.length > 0 &&
          diagnosis.instanceVersion && (
            <NoticeBanner variant="info" icon={Info}>
              本条结论在 {versions.join(' / ')} 上验证过，当前实例是 {diagnosis.instanceVersion}
              ；请结合下方原文判断。
            </NoticeBanner>
          )}
      </div>
    )
  }

  // 未命中分两类：崩溃报告是「键有值但没收录」，JVM 崩溃日志是「没有可锚的键」——
  // 后者说成「不在已知词条里」等于替面板断言一件它无从知道的事，给出的对照物也不存在于该产物
  const isJvm = data.kind === 'jvm-crash'
  const missTitle = isJvm ? '这份 JVM 崩溃日志没有可对照的词条' : '这次崩溃不在已知词条里'
  const missBody = isJvm
    ? '面板不在此推断原因：下方「故障」与「问题帧」两行来自 JVM 崩溃日志本身，是判断 JVM/系统级故障（段错误、堆内存或堆外内存耗尽等）的直接依据。'
    : '面板不猜原因。下面已把产物原文与已核实字段摆出来：可对照「顶层异常」与「由以下引起」链里的包名判断；装有模组或插件时，把崩溃报告全文提供给对应作者通常最快。'

  const copy = async () => {
    const ok = await copyText(feedbackText(data))
    if (ok) toast.success('反馈信息已复制', { duration: 1500 })
    else toast.error('复制失败，请手动复制')
  }

  return (
    <div className="flex flex-col gap-2" data-testid="crash-diagnosis-miss">
      <NoticeBanner variant="neutral" form="card" icon={Info}>
        <p className="text-mcs-xs font-medium text-mcs-text-default">{missTitle}</p>
        <p className="mt-1 text-mcs-xs text-mcs-text-muted">{missBody}</p>
      </NoticeBanner>
      {/* 同卡折叠控件是紧凑档 h-7、这两枚是行内小档 h-6：前者是披露控件、后者是动作按钮，角色不同 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          <Copy className="size-3" aria-hidden="true" />
          复制反馈信息
        </Button>
        <Button size="xs" variant="outline" asChild>
          <a href={feedbackIssueUrl(data)} target="_blank" rel="noreferrer noopener">
            <ExternalLink className="size-3" aria-hidden="true" />
            反馈到 GitHub
          </a>
        </Button>
      </div>
    </div>
  )
}

/**
 * 纯展示：取数由 `CrashReportCard` 承担，本组件只管把已有数据画出来。
 * 分开的理由是测试——本仓组件测试一律以 props 喂数据，不引 msw。
 */
export function CrashReportView({ data, nowMs }: { data: CrashArtifact; nowMs: number }) {
  const isJvm = data.kind === 'jvm-crash'
  const title = isJvm ? 'JVM 崩溃日志' : '崩溃报告'

  return (
    <Card className="flex flex-col gap-3" size="default">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <FileWarning className="size-4 text-mcs-warning-fg" aria-hidden="true" />
          {title}
        </CardTitle>
        <span className="text-mcs-2xs text-mcs-text-muted">
          {data.fileName} ·{' '}
          {formatRelativeTime(
            data.mtimeMs != null ? new Date(data.mtimeMs).toISOString() : null,
            nowMs,
            '时间未知',
          )}
        </span>
      </CardHeader>

      <CardBody className="flex flex-col gap-3">
        <DiagnosisBlock data={data} />

        {/* 解析失败如实说「读不到」，不显示空内容让用户以为「没有报错」 */}
        {data.parseError && (
          <NoticeBanner variant="warning" icon={Info}>
            {data.parseError}
          </NoticeBanner>
        )}

        {data.summary && data.summary.length > 0 && <FieldGrid fields={data.summary} />}

        {data.exception && (
          <p className="text-mcs-xs break-all text-mcs-text-default">{data.exception}</p>
        )}

        {data.causedBy && data.causedBy.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {data.causedBy.map((c) => (
              <li key={c} className="text-mcs-2xs break-all text-mcs-text-muted">
                由以下引起：{c}
              </li>
            ))}
          </ul>
        )}

        {data.stack && data.stack.length > 0 && (
          <Collapsible title={`调用栈（${data.stack.length} 帧）`}>
            <pre className="max-h-60 overflow-auto rounded-mcs-sm bg-mcs-bg-muted p-2 text-mcs-2xs text-mcs-text-default">
              {data.stack.join('\n')}
            </pre>
          </Collapsible>
        )}

        {data.excerpt && (
          <Collapsible title="完整产物原文">
            <pre className="max-h-80 overflow-auto rounded-mcs-sm bg-mcs-bg-muted p-2 text-mcs-2xs whitespace-pre-wrap text-mcs-text-default">
              {data.excerpt}
            </pre>
          </Collapsible>
        )}
      </CardBody>
    </Card>
  )
}

/**
 * 薄包装：取最新一份崩溃诊断产物。
 * 从未崩溃过（服务端返回 null）时**整卡不渲染**——没崩过的实例不该多一张空卡。
 */
export function CrashReportCard({ instanceId }: { instanceId: string | null }) {
  const { data } = useCrashArtifact(instanceId)
  // 相对时间要随时间自己走：渲染期直接 Date.now() 是不纯的（React Compiler 会告警），
  // 用仓库既有的分钟级时间源
  const nowMs = useNow()
  if (!data) return null
  return <CrashReportView data={data} nowMs={nowMs} />
}
