/**
 * 结论面板：整页的**首屏主体**，用户点完按钮先看到它。
 *
 * 呈现顺序按「用户要什么」排：结论一句话 → 依据（带单位的几个数）→ 下一步建议。
 * 不先放图、不先放表：性能诊断面板的价值在于替用户读出「是 CPU、内存还是 tick 超时」，
 * 数据表是佐证，不是答案。
 *
 * 配色只用 tone 词表（门禁第 11c 条）：结论档 → 语义色只在下面这份映射里出现一次。
 */
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PerfVerdict } from '@mc-commander/schemas'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { SEMANTIC_TONE_CLASSES } from '@/components/mcs/tone'
import { cn } from '@/lib/utils'

/** 结论档 → 图标与语义色。tone 是唯一着色源，本表只做档位到 tone 的映射 */
const LEVEL_VIEW: Record<
  PerfVerdict['level'],
  { icon: LucideIcon; tone: 'success' | 'warning' | 'error'; label: string }
> = {
  healthy: { icon: CheckCircle2, tone: 'success', label: '余量充足' },
  warning: { icon: AlertTriangle, tone: 'warning', label: '需要留意' },
  critical: { icon: XCircle, tone: 'error', label: '已经出问题' },
}

export function PerfVerdictCard({ verdict }: { verdict: PerfVerdict }) {
  const view = LEVEL_VIEW[verdict.level]
  const Icon = view.icon
  const tone = SEMANTIC_TONE_CLASSES[view.tone]

  return (
    <Card className="flex flex-col gap-3" data-testid="perf-verdict">
      <CardHeader className="items-start gap-2">
        <Icon className={cn('mt-0.5 size-5 shrink-0', tone.text)} aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle as="h3">{verdict.headline}</CardTitle>
          <p className="text-mcs-xs text-mcs-text-muted">{view.label}</p>
        </div>
      </CardHeader>

      <CardBody className="flex flex-col gap-3">
        <p className="text-mcs-sm text-mcs-text-default">{verdict.detail}</p>

        {verdict.findings.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            {verdict.findings.map((finding) => (
              <div key={finding.label} className="contents">
                <dt className="text-mcs-xs text-mcs-text-muted">{finding.label}</dt>
                <dd className="flex min-w-0 flex-col gap-0.5">
                  <span className="mcs-num text-mcs-md font-semibold text-mcs-text-default">
                    {finding.value}
                  </span>
                  {/* hint 是完整句子（服务端下发的那几条都含「，」分句），按口径最低 xs；
                      2xs 只留给角标、单位与 mono 元数据 */}
                  {finding.hint && (
                    <span className="text-mcs-xs text-mcs-text-muted">{finding.hint}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardBody>
    </Card>
  )
}

/**
 * 未取到结论时的空态。
 * 图标与文案都说「还没取过」，不显示任何数字——空面板上摆 0 会被读成「指标是 0」。
 */
export function PerfIdleHint() {
  return (
    <Card className="flex flex-col items-center gap-2 py-8 text-center">
      <HelpCircle className="size-6 text-mcs-text-muted" aria-hidden />
      <p className="text-mcs-sm font-medium text-mcs-text-muted">还没有取过快照</p>
      <p className="max-w-md text-mcs-xs text-mcs-text-muted">
        点上方按钮取一次。性能快照是 10 秒的取样，不是持续监控——它回答 「刚才那 10
        秒里卡在哪」，不会自己更新。
      </p>
    </Card>
  )
}
