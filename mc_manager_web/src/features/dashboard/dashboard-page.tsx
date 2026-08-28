import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ServerOff } from 'lucide-react'
import { BigStatCards, PlayersCard, RuntimeInfoCard, DiskUsageCard } from './components/stat-cards'
import { ServerTerminal } from './components/server-terminal'
import { CommandInput } from './components/command-input'
import { McClockCard } from './components/mc-clock-card'
import { EventsCard } from './components/events-card'
import { AnnouncementCard } from './components/announcement-card'
import { useMetricHistory } from './use-metric-history'
import { useInstanceStatus, useSystemStats, queryKeys } from '@/api/queries'
import { useServerStore } from '@/stores/server'
import { EmptyState } from '@/components/mcs/empty-state'
import { useNavigate } from 'react-router'

/**
 * 仪表盘驾驶舱
 * 顶部大数字四卡 → 终端主体 + 右栏五卡（MC 时钟·世界控制 / 事件与待办 / 公告发送 / 在线玩家 / 运行信息）
 * 数据流：Query 轮询（实例 30s / 系统资源 5s）→ server store → WS 事件即时合并
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

  const history = useMetricHistory()
  const navigate = useNavigate()

  // B17 首屏骨架：仅 status 未到（Query 加载中）时显示，WS 已送达则直出数据
  const statusLoading = statusQuery.isLoading && status === null

  if (!instanceId) {
    return (
      <EmptyState
        icon={ServerOff}
        title="暂无服务器实例"
        hint="请先在服务端创建 MC 服务器实例"
        action={{ label: '前往实例管理', onClick: () => navigate('/instances') }}
      />
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-density="default">
      {/* 顶部大数字四卡 */}
      <BigStatCards history={history} isLoading={statusLoading} />

      {/* 终端主体 + 右栏五卡 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_336px]">
        <div className="flex min-h-0 flex-col gap-4">
          <ServerTerminal isLoading={statusLoading} />
          <CommandInput />
        </div>
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <McClockCard />
          <EventsCard />
          <AnnouncementCard />
          <PlayersCard />
          <DiskUsageCard />
          <RuntimeInfoCard />
        </aside>
      </div>
    </div>
  )
}
