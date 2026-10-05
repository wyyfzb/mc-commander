import { useState } from 'react'
import { ChevronDown, FileWarning, Info } from 'lucide-react'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/mcs/card'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { useCrashArtifact } from '@/api/queries'
import type { CrashArtifact } from '@/api/types'
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
 */

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
