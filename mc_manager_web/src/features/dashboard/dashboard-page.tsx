import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { BigStatCards, PlayersCard, RuntimeInfoCard } from './components/stat-cards'
import { ServerTerminal } from './components/server-terminal'
import { CommandInput } from './components/command-input'
import { McClockCard } from './components/mc-clock-card'
import { RecentBackupsCard } from './components/recent-backups-card'
import { AnnouncementCard } from './components/announcement-card'
import { useInstanceStatus, useSystemStats, queryKeys } from '@/api/queries'
import { useServerStore } from '@/stores/server'
import { InstanceRequiredState } from '@/features/instances/components/instance-required-state'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { PageHeader } from '@/components/mcs/page-header'
import { Button } from '@/components/ui/button'

/**
 * 查询是否处于「已失败且尚未恢复」：失败过一轮后的重试会把 query 短暂置回 pending
 * （isError 瞬时为 false），只看 isError 会让横幅连同重试按钮在整个请求窗口内消失——
 * 端点持续故障时用户点完重试得不到任何反馈。
 * 用两次「落定时间」比较兜住：失败的时间戳晚于成功，说明最近一次落定是失败
 * （fetch 开始时 failureCount 会归零，不能拿它判）。
 */
function queryFailed(q: { isError: boolean; errorUpdatedAt: number; dataUpdatedAt: number }) {
  return q.isError || q.errorUpdatedAt > q.dataUpdatedAt
}

/**
 * 仪表盘驾驶舱
 * 顶部三卡（在线玩家 / 资源使用 / 实例信息）→ 终端主体 + 右栏卡（MC 时钟·世界控制 / 最近备份 / 公告发送）
 * 数据流：Query 轮询（实例与系统资源同为保底 30s，见 queries.ts 常量）→ server store → WS 事件即时合并
 */
export function DashboardPage() {
  const queryClient = useQueryClient()
  const instanceId = useServerStore((s) => s.instanceId)
  const setStatus = useServerStore((s) => s.setStatus)
  const setSystemStats = useServerStore((s) => s.setSystemStats)
  const lastStatusEvent = useServerStore((s) => s.lastStatusEvent)
  const status = useServerStore((s) => s.status)

  const statusQuery = useInstanceStatus(instanceId)
  const systemStatsQuery = useSystemStats()

  // Query 结果 → store（WS 合并基线）
  useEffect(() => {
    if (statusQuery.data) setStatus(statusQuery.data)
  }, [statusQuery.data, setStatus])

  useEffect(() => {
    if (systemStatsQuery.data) setSystemStats(systemStatsQuery.data)
  }, [systemStatsQuery.data, setSystemStats])

  // status 跃迁（started/stopped/...）→ 全量刷新
  useEffect(() => {
    if (lastStatusEvent && instanceId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance(instanceId) })
    }
  }, [lastStatusEvent, instanceId, queryClient])

  // B17 首屏骨架：仅 status 未到（Query 加载中）时显示，WS 已送达则直出数据。
  // 失败过一轮后的重试同样让 isLoading 为真，那时该给横幅而非骨架
  const statusFailed = queryFailed(statusQuery)
  const statusLoading = statusQuery.isLoading && status === null && !statusFailed

  // 两条查询各自失败都要有出口：只报状态失败会把「资源卡永久停在暂无数据、又无重试」
  // 留成静默（J49）。两条都失败时合并为一条横幅、一次重试，避免横幅堆叠。
  const statsFailed = queryFailed(systemStatsQuery)
  const failedSources = [
    statusFailed ? '服务器状态' : null,
    statsFailed ? '系统资源' : null,
  ].filter((v): v is string => v != null)
  // 只按「已失败且正在重取」的那几条算重试在途：健康查询的 30s 保底轮询/WS 失效
  // 重取与用户点重试无关，把它算进来会让按钮在无关窗口里无故变灰
  const retryInFlight = (statusFailed && statusQuery.isFetching) || (statsFailed && systemStatsQuery.isFetching)
  const retryFailedQueries = () => {
    if (statusFailed) void statusQuery.refetch()
    if (statsFailed) void systemStatsQuery.refetch()
  }

  // 无实例门：加载中/加载失败/真空态/待选中四态各自诚实（见 InstanceRequiredState）
  if (!instanceId) {
    return <InstanceRequiredState />
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <PageHeader title="仪表盘" description="实例运行状态 · 终端 · 快捷操作" />

      {/* 查询失败横幅（避免卡片静默显示 0 / 留在「暂无数据」被误读为真实状态） */}
      {failedSources.length > 0 && !statusLoading && (
        <NoticeBanner variant="error" icon={AlertTriangle}>
          <span className="flex items-center gap-2">
            <b>{failedSources.join('与')}获取失败</b> · 相关数据可能缺失或已过期
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-mcs-2xs text-mcs-error-fg"
              onClick={retryFailedQueries}
              disabled={retryInFlight}
            >
              <RefreshCw className="size-3" aria-hidden />
              重试
            </Button>
          </span>
        </NoticeBanner>
      )}

      {/* 顶部三卡：在线玩家 / 资源使用 / 实例运行信息 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <PlayersCard />
        <BigStatCards isLoading={statusLoading} />
        <RuntimeInfoCard />
      </div>

      {/* 终端主体 + 右栏卡 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_336px]">
        <div className="flex min-h-0 flex-col gap-4">
          <ServerTerminal isLoading={statusLoading} />
          <CommandInput />
        </div>
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <McClockCard />
          {/* 状态 → 数据安全 → 主动操作：备份卡排在公告发送之前（蓝本同序） */}
          <RecentBackupsCard />
          <AnnouncementCard />
        </aside>
      </div>
    </div>
  )
}
