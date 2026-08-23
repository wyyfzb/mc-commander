import { Bell, ChevronsLeft, ChevronsRight, Menu, Moon, Search, Server, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusIndicator, type IndicatorStatus } from '@/components/mcs/status-indicator'
import { NotificationDrawer } from '@/layouts/notification-drawer'
import { useUiStore } from '@/stores/ui'
import { useServerStore } from '@/stores/server'
import { useNotificationStore } from '@/stores/notifications'
import { useConnectionStore } from '@/stores/connection'
import { useInstances } from '@/api/queries'

/**
 * AppTopBar —— 主顶栏（设计文档 §3.1）
 * 实例选择器 ▸ 全局搜索 (Cmd+K) ▸ 服务器状态点（WS 实时）▸ 通知铃铛（未读徽章+抽屉）▸ 主题切换
 */
export function AppTopBar() {
  const theme = useUiStore((s) => s.theme)
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const toggleMobileNav = useUiStore((s) => s.toggleMobileNav)
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const notificationsOpen = useUiStore((s) => s.notificationsOpen)
  const setNotificationsOpen = useUiStore((s) => s.setNotificationsOpen)

  const connectionStatus = useConnectionStore((s) => s.status)
  const socketConnected = useServerStore((s) => s.socketConnected)
  const hasConnectedOnce = useServerStore((s) => s.hasConnectedOnce)
  const status = useServerStore((s) => s.status)
  const instanceId = useServerStore((s) => s.instanceId)
  const setInstanceId = useServerStore((s) => s.setInstanceId)
  const unreadCount = useNotificationStore((s) => s.unreadCount)

  const instancesQuery = useInstances()

  // 状态点语义（三重编码；区分"初次连接"与"实时通道断开"——WS 断开时 HTTP 轮询保底，数据仍可用）
  let indicator: IndicatorStatus = 'disconnected'
  if (connectionStatus === 'unconfigured') {
    indicator = 'disconnected'
  } else if (!socketConnected && !hasConnectedOnce) {
    indicator = 'connecting'
  } else if (!socketConnected && hasConnectedOnce) {
    indicator = 'degraded'
  } else if (status?.isRunning && (status.tps ?? 20) < 15) {
    indicator = 'warning'
  } else {
    indicator = 'connected'
  }

  const currentInstanceName =
    instancesQuery.data?.find((i) => i.id === instanceId)?.name ?? '默认实例'

  return (
    <header className="glass-chrome flex h-12 shrink-0 items-center gap-2 border-b border-mcs-border-muted px-3">
      {/* 侧栏折叠（桌面）/ 移动端导航抽屉开关 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            className="hidden md:inline-flex"
          >
            {sidebarCollapsed ? <ChevronsRight /> : <ChevronsLeft />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}</TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={toggleMobileNav}
        aria-label="打开导航菜单"
        className="md:hidden"
      >
        <Menu aria-hidden />
      </Button>

      {/* 服务器地址（B15：原型顶栏地址 chip；延迟由状态点语义覆盖） */}
      {status?.address && (
        <span className="hidden items-center gap-1.5 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-muted px-2 py-1 font-mono text-mcs-2xs text-mcs-text-muted lg:inline-flex">
          <Server className="size-3" aria-hidden />
          {status.address}
        </span>
      )}

      {/* 实例选择器（真实实例列表） */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="gap-1.5 text-mcs-sm font-medium">
            <Server className="size-4 text-mcs-text-muted" aria-hidden />
            {currentInstanceName}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>服务器实例</DropdownMenuLabel>
          {(instancesQuery.data ?? []).length === 0 && (
            <DropdownMenuItem disabled>暂无实例</DropdownMenuItem>
          )}
          {(instancesQuery.data ?? []).map((inst) => (
            <DropdownMenuItem
              key={inst.id}
              onClick={() => setInstanceId(inst.id)}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">{inst.name}</span>
              {inst.id === instanceId ? (
                <span className="size-1.5 rounded-full bg-mcs-accent" aria-label="当前实例" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 全局搜索（Cmd+K） */}
      <Button
        variant="outline"
        className="ml-auto w-44 justify-between gap-2 text-mcs-sm text-mcs-text-subtle sm:w-56"
        onClick={() => setCommandPaletteOpen(true)}
      >
        <span className="inline-flex items-center gap-2">
          <Search className="size-3.5" aria-hidden />
          搜索或执行命令…
        </span>
        <kbd className="pointer-events-none inline-flex h-5 items-center gap-0.5 rounded border border-mcs-border-default bg-mcs-bg-default px-1.5 font-mono text-mcs-2xs font-medium text-mcs-text-muted">
          Ctrl K
        </kbd>
      </Button>

      {/* 服务器状态点（WS 实时） */}
      <StatusIndicator status={indicator} className="hidden md:inline-flex" />

      {/* 通知铃铛（未读徽章 + 抽屉） */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative"
            onClick={() => setNotificationsOpen(true)}
            aria-label={`通知${unreadCount > 0 ? `（${unreadCount} 条未读）` : ''}`}
          >
            <Bell aria-hidden />
            {unreadCount > 0 && (
              // subtle 底 + fg 字：实底（fg+白字）在 dark 亮红上对比度不足（~2.6:1），且白字非 token
              <span
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-mcs-error-bg-subtle px-1 text-mcs-2xs font-medium text-mcs-error-fg"
                aria-hidden
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">通知</TooltipContent>
      </Tooltip>

      {/* 主题切换 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
          >
            {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
        </TooltipContent>
      </Tooltip>

      <NotificationDrawer open={notificationsOpen} onOpenChange={setNotificationsOpen} />
    </header>
  )
}
