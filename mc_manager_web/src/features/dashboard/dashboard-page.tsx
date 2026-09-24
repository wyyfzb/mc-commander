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
import { queryFailed } from '@/lib/query-phase'
import { Button } from '@/components/ui/button'

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
  // 留成静默。两条都失败时合并为一条横幅、一次重试，避免横幅堆叠。
  const statsFailed = queryFailed(systemStatsQuery)
  const failedSources = [
    statusFailed ? '服务器状态' : null,
    statsFailed ? '系统资源' : null,
  ].filter((v): v is string => v != null)
  // 只按「已失败且正在重取」的那几条算重试在途：健康查询的 30s 保底轮询/WS 失效
  // 重取与用户点重试无关，把它算进来会让按钮在无关窗口里无故变灰
  const retryInFlight =
    (statusFailed && statusQuery.isFetching) || (statsFailed && systemStatsQuery.isFetching)
  const retryFailedQueries = () => {
    if (statusFailed) void statusQuery.refetch()
    if (statsFailed) void systemStatsQuery.refetch()
  }

  // 无实例门：加载中/加载失败/真空态/待选中四态各自诚实（见 InstanceRequiredState）
  if (!instanceId) {
    return <InstanceRequiredState />
  }

  return (
    /* @container：本页栅格按「可用内容宽」切档，而不是按视口宽。
       侧栏可手动折叠（56px ↔ 208px），同一视口宽下内容宽会差 152px——
       视口断点（lg/xl）在这里原理上判不准：1023px 视口内容宽已有 783px，
       却因差 1px 未达 lg 而把三张卡硬塞成一列、每张拉到 783px 宽 */
    <div className="@container flex h-full flex-col gap-4 overflow-y-auto p-4">
      <PageHeader title="仪表盘" description="实例运行状态 · 终端 · 快捷操作" inlineDescription />

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

      {/* 顶部三卡：在线玩家 / 资源使用 / 实例运行信息
          阈值按容器**内容盒**计（不含页面 p-4 与滚动条）：
          @2xl=672px 两列（每张约 328px）、@5xl=1024px 三列（每张约 330px，与改前 1280 视口下的 336px 同档） */}
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
        <PlayersCard isLoading={statusLoading} />
        <BigStatCards isLoading={statusLoading} />
        <RuntimeInfoCard isLoading={statusLoading} />
      </div>

      {/* 终端主体 + 右栏卡。
          单列窄屏（<@5xl）主栅格必须按内容高度排布：外层是定高 flex 列，`min-h-0 flex-1`
          会让这一行被压到几像素，行内 flex-1 的终端与右栏 <aside> 一并塌陷（
          375 下右栏只剩 3.6px 高、三张卡用户完全够不到）。
          分栏与顶卡三列同档（@5xl=1024px）：分栏后终端吃满剩余高度，而剩余高度取决于
          顶卡占几行——两档必须同时翻，否则顶卡占两行时会把终端压到读不了几行。
          @5xl 起恢复 min-h-0 flex-1，终端保底约 672px，右栏自身滚动。 */}
      <div className="grid flex-1 grid-cols-1 gap-4 @5xl:min-h-0 @5xl:grid-cols-[minmax(0,1fr)_336px]">
        <div className="flex flex-col gap-4 @5xl:min-h-0">
          <ServerTerminal isLoading={statusLoading} />
          <CommandInput />
        </div>
        <aside
          data-testid="dashboard-aside"
          className="flex flex-col gap-4 overflow-y-auto pr-1 @5xl:min-h-0"
        >
          <McClockCard />
          {/* 状态 → 数据安全 → 主动操作：备份卡排在公告发送之前（蓝本同序） */}
          <RecentBackupsCard />
          <AnnouncementCard />
        </aside>
      </div>
    </div>
  )
}
