import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { AppTopBar } from './app-topbar'
import { AppSidebar } from './app-sidebar'
import { CommandPalette } from './command-palette'
import { CommandBridge } from './command-bridge'
import { DegradationBanners } from './degradation-banners'
import { ErrorBoundary } from '@/components/mcs/error-boundary'
import { LastOutputDialog } from '@/components/mcs/last-output-dialog'
import { useUiStore } from '@/stores/ui'
import { useServerStore } from '@/stores/server'
import { useInstances } from '@/api/queries'
import { useNotificationToasts } from '@/hooks/use-notification-toasts'
import { useServerSocket } from '@/hooks/use-server-socket'

/**
 * AppShell —— 主布局壳
 * ┌────────────────────────────────────────────────────┐
 * │ 顶栏：实例 ▸ 搜索(Cmd+K) ▸ 状态点 ▸ 铃铛 ▸ 主题切换 │
 * ├──────┬─────────────────────────────────────────────┤
 * │ 侧栏 │ Outlet（页面内容）                            │
 * └──────┴─────────────────────────────────────────────┘
 * 主题同步在根级 main.tsx（ThemeClassSync），覆盖 AppShell 外的登录/引导路由
 */
export function AppShell() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen)
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen)
  const instanceId = useServerStore((s) => s.instanceId)
  const setInstanceId = useServerStore((s) => s.setInstanceId)

  // 默认实例选择：列表就绪且未选择时取第一个（单实例场景）
  const instancesQuery = useInstances()
  useEffect(() => {
    const first = instancesQuery.data?.[0]
    if (!instanceId && first) {
      setInstanceId(first.id)
    }
  }, [instancesQuery.data, instanceId, setInstanceId])

  // WS 实时层（全局挂载：通知/状态/日志跨页面共享）
  useServerSocket(instanceId)
  // 游戏内事件 toast 播报（通知中心之外的一过性即时反馈）
  useNotificationToasts()

  return (
    <div className="mcs-shell-bg mcs-grain flex h-dvh overflow-hidden text-mcs-text-default">
      {/* 无障碍（P5）：键盘 Tab 首站跳过侧栏/顶栏直达内容区，平时移出屏外 */}
      <a
        href="#main-content"
        className="absolute left-3 top-3 z-(--mcs-z-toast) -translate-y-24 rounded-mcs-sm bg-mcs-bg-emphasis px-3 py-2 text-mcs-sm font-medium text-mcs-text-default shadow-mcs-raised ring-1 ring-mcs-border-default transition-transform duration-mcs-fast focus-visible:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mcs-focus-ring"
      >
        跳到主要内容
      </a>
      <AppSidebar
        collapsed={sidebarCollapsed}
        mobileNavOpen={mobileNavOpen}
        onMobileNavClose={() => setMobileNavOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopBar />
        {/* 降级横幅：WS 断开/RCON 未连接时的诚实提示 + 处置入口 */}
        <DegradationBanners />
        <main
          id="main-content"
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none"
        >
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <CommandPalette />
      {/* 全局命令执行器（命令面板全站可用） */}
      <CommandBridge />
      {/* 末尾日志弹窗（崩溃/熔断 toast 深入链接入口，issue 343） */}
      <LastOutputDialog />
    </div>
  )
}
