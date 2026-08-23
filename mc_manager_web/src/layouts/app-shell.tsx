import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { AppTopBar } from './app-topbar'
import { AppSidebar } from './app-sidebar'
import { CommandPalette } from './command-palette'
import { CommandBridge } from './command-bridge'
import { DegradationBanners } from './degradation-banners'
import { useUiStore } from '@/stores/ui'
import { useServerStore } from '@/stores/server'
import { useInstances } from '@/api/queries'
import { useServerSocket } from '@/hooks/use-server-socket'

/**
 * AppShell —— 主布局壳
 * ┌────────────────────────────────────────────────────┐
 * │ 顶栏：实例 ▸ 搜索(Cmd+K) ▸ 状态点 ▸ 铃铛 ▸ 主题切换 │
 * ├──────┬─────────────────────────────────────────────┤
 * │ 侧栏 │ Outlet（页面内容）                            │
 * └──────┴─────────────────────────────────────────────┘
 * 主题同步：html.classList = dark（默认）/ light（亮色）
 */
export function AppShell() {
  const theme = useUiStore((s) => s.theme)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen)
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen)
  const density = useUiStore((s) => s.density)
  const instanceId = useServerStore((s) => s.instanceId)
  const setInstanceId = useServerStore((s) => s.setInstanceId)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.classList.toggle('light', theme === 'light')
  }, [theme])

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

  return (
    <div data-density={density} className="flex h-dvh overflow-hidden bg-mcs-bg-default text-mcs-text-default">
      {/* 无障碍（P5）：键盘 Tab 首站跳过侧栏/顶栏直达内容区，平时移出屏外 */}
      <a
        href="#main-content"
        className="absolute left-3 top-3 z-50 -translate-y-24 rounded-mcs-sm bg-mcs-bg-emphasis px-3 py-2 text-mcs-sm font-medium text-mcs-text-default shadow-lg ring-1 ring-mcs-border-default transition-transform duration-150 focus-visible:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mcs-focus-ring"
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
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      {/* 全局命令执行器（命令面板全站可用） */}
      <CommandBridge />
    </div>
  )
}
