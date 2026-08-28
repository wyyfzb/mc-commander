import { NavLink } from 'react-router'
import {
  LayoutDashboard,
  Users,
  Globe,
  FolderOpen,
  CalendarClock,
  Server,
  Settings,
  ScrollText,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useInstances } from '@/api/queries'
import { useServerStore } from '@/stores/server'

/**
 * AppSidebar —— 主侧栏（设计文档 §3.1）
 * 导航：仪表盘/玩家/世界/文件/任务/实例 + 底部设置
 * 折叠由 zustand（useUiStore.sidebarCollapsed）驱动
 * 移动端（<768px）：fixed 抽屉 + 遮罩（useUiStore.mobileNavOpen 驱动）；底部实例迷你卡
 */

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const PRIMARY_NAV: NavItem[] = [
  { to: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { to: '/players', label: '玩家', icon: Users },
  { to: '/world', label: '世界', icon: Globe },
  { to: '/files', label: '文件', icon: FolderOpen },
  { to: '/tasks', label: '任务', icon: CalendarClock },
  { to: '/instances', label: '实例', icon: Server },
  { to: '/audit', label: '审计', icon: ScrollText },
]

const BOTTOM_NAV: NavItem[] = [{ to: '/settings', label: '设置', icon: Settings }]

interface AppSidebarProps {
  collapsed: boolean
  mobileNavOpen: boolean
  onMobileNavClose: () => void
}

export function AppSidebar({ collapsed, mobileNavOpen, onMobileNavClose }: AppSidebarProps) {
  const instanceId = useServerStore((s) => s.instanceId)
  const instancesQuery = useInstances()
  const current = instancesQuery.data?.find((i) => i.id === instanceId)

  const nav = (
    <>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-2">
        {PRIMARY_NAV.map(({ to, label, icon: Icon }) => (
          <SidebarLink
            key={to}
            to={to}
            label={label}
            icon={Icon}
            collapsed={collapsed}
            onClick={onMobileNavClose}
          />
        ))}
      </nav>

      <nav className="flex flex-col gap-1 border-t border-mcs-border-muted px-2 py-2">
        {BOTTOM_NAV.map(({ to, label, icon: Icon }) => (
          <SidebarLink
            key={to}
            to={to}
            label={label}
            icon={Icon}
            collapsed={collapsed}
            onClick={onMobileNavClose}
          />
        ))}
      </nav>

      {/* 实例迷你卡（原型 side-foot：当前实例 + TPS + 人数；仅展开态展示） */}
      {!collapsed && current && (
        <div className="border-t border-mcs-border-muted p-2.5">
          <div className="flex items-center gap-2 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted px-2.5 py-2">
            <span className="size-2 shrink-0 rounded-full bg-mcs-accent" aria-hidden />
            <div className="min-w-0">
              <div className="truncate text-mcs-xs font-semibold text-mcs-text-default">
                {current.name}
              </div>
              <div className="truncate font-mono text-mcs-2xs text-mcs-text-subtle">
                {current.isRunning ? '运行中' : '已停止'} · {current.playerCount} 人在线
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <>
      {/* 桌面侧栏（≥768px） */}
      <aside
        className={cn(
          'glass-chrome hidden h-full shrink-0 flex-col border-r border-mcs-border-muted md:flex',
          'transition-[width] duration-mcs-base ease-mcs-snappy',
          collapsed ? 'w-14' : 'w-52',
        )}
        aria-label="主导航"
      >
        <BrandRow collapsed={collapsed} />
        {nav}
      </aside>

      {/* 移动端抽屉（<768px）：fixed 覆盖层 + 遮罩 */}
      <div className={cn('fixed inset-0 z-50 md:hidden', !mobileNavOpen && 'pointer-events-none')}>
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity duration-mcs-base',
            mobileNavOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={onMobileNavClose}
          aria-hidden
        />
        <aside
          className={cn(
            'glass-chrome absolute inset-y-0 left-0 flex w-64 flex-col border-r border-mcs-border-muted',
            'transition-transform duration-mcs-base ease-mcs-snappy',
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          )}
          aria-label="主导航（移动端）"
          aria-hidden={!mobileNavOpen}
        >
          <BrandRow collapsed={false} />
          {nav}
        </aside>
      </div>
    </>
  )
}

function BrandRow({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn('flex h-12 items-center gap-2 px-3', collapsed && 'justify-center')}>
      <span className="size-2.5 shrink-0 rounded-full bg-mcs-accent" aria-hidden />
      {!collapsed && <span className="truncate text-mcs-md font-semibold">MC Commander</span>}
    </div>
  )
}

function SidebarLink({
  to,
  label,
  icon: Icon,
  collapsed,
  onClick,
}: NavItem & { collapsed: boolean; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center gap-2.5 rounded-mcs-sm px-2.5 text-mcs-sm font-medium',
          'text-mcs-text-muted transition-colors duration-mcs-fast',
          'hover:bg-mcs-state-hover hover:text-mcs-text-default',
          'focus-visible:outline-2',
          isActive && 'bg-mcs-accent-bg-subtle text-mcs-accent-fg',
          collapsed && 'justify-center px-0',
        )
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  )
}
