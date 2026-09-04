import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw, ServerOff } from 'lucide-react'
import { BigStatCards, PlayersCard, RuntimeInfoCard } from './components/stat-cards'
import { ServerTerminal } from './components/server-terminal'
import { CommandInput } from './components/command-input'
import { McClockCard } from './components/mc-clock-card'
import { AnnouncementCard } from './components/announcement-card'
import { useInstanceStatus, useSystemStats, queryKeys } from '@/api/queries'
import { useServerStore } from '@/stores/server'
import { EmptyState } from '@/components/mcs/empty-state'
import { NoticeBanner } from '@/components/mcs/notice-banner'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router'

/**
 * 仪表盘驾驶舱
 * 顶部三卡（在线玩家 / 资源使用 / 实例信息）→ 终端主体 + 右栏卡（MC 时钟·世界控制 / 公告发送）
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
      {/* 状态查询失败横幅（避免卡片静默显示 0 被误读为真实状态） */}
      {statusQuery.isError && !statusLoading && (
        <NoticeBanner variant="error" icon={AlertTriangle}>
          <span className="flex items-center gap-2">
            <b>服务器状态获取失败</b> · 以下数据可能已过期
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-mcs-2xs text-mcs-error-fg"
              onClick={() => void statusQuery.refetch()}
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
          <AnnouncementCard />
        </aside>
      </div>
    </div>
  )
}
