/**
 * FleetPage —— 多实例总览（一屏看清全部实例的健康与负载）
 *
 * 与实例页的分工：实例页逐台办事（部署/启停/设置/升级/卸载），总览只回答「现在哪台要管」。
 * 两者共用 `GET /instances` 的同一份缓存条目，切页不重新取数。
 *
 * 为什么是清单不是卡片墙：卡片墙每张约 180px，12 个实例要滚两屏，而跨实例比较靠的是
 * 指标对齐——同一列上下扫才看得出离群值。
 *
 * 页根声明 `@container`：列与摘要行按这块的**实宽**切档，视口断点在侧栏折叠/抽屉化/
 * 主从页借宽这三种场景下原理上判不准。
 */
import { AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/mcs/page-header'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Button } from '@/components/ui/button'
import { buildFleetRows, countIssues } from './fleet-health'
import { useFleetData } from './use-fleet-data'
import { FleetIssueSummary, FleetSummary } from './components/fleet-summary'
import { FleetTable } from './components/fleet-table'

export function FleetPage() {
  const { instances, overview, isLoading, phase, listError, refetchList } = useFleetData()

  const rows = buildFleetRows(instances)
  const { total: issueCount, errors: errorCount } = countIssues(rows)
  const empty = !isLoading && instances.length === 0

  return (
    <div className="@container flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title="实例总览"
        description={
          empty ? (
            '还没有已安装的实例'
          ) : (
            <FleetIssueSummary total={issueCount} errors={errorCount} />
          )
        }
        actions={
          <Button size="sm" variant="outline" onClick={refetchList} disabled={isLoading}>
            刷新
          </Button>
        }
        banner={
          phase === 'stale' ? (
            <NoticeBanner variant="warning" icon={AlertTriangle}>
              <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span>实例清单更新失败，当前显示上一轮结果</span>
                <Button size="xs" variant="outline" onClick={refetchList}>
                  重试
                </Button>
              </span>
            </NoticeBanner>
          ) : undefined
        }
      />

      <FleetSummary instances={instances} overview={overview} isLoading={isLoading} />

      {/* 顺序在清单上方交代一句：静默重排会让用户以为清单漏了实例 */}
      {rows.length > 1 && (
        <p className="shrink-0 text-mcs-xs text-mcs-text-muted">
          按需关注程度排序：故障与告警在前，其余按运行状态
        </p>
      )}

      <FleetTable
        rows={rows}
        isLoading={isLoading}
        error={phase === 'failed' ? listError : undefined}
      />
    </div>
  )
}
