/**
 * SettingsPage —— 设置页布局
 * - 左子导航 200px（实底卡片）+ 右内容区 Outlet（子路由 /settings/connection|general|notifications|backup|about）
 * - 菜单激活态：accent-bg-subtle 底 + accent-border + accent 文字
 * - 设计纪律：设置页内容区实底（风格 A 玻璃禁区）；子侧栏同实底卡
 */
import { Link, Outlet, useLocation } from 'react-router'
import { BellRing, DatabaseBackup, Info, Link2, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TONE_SELECTED_CLASSES } from '@/components/mcs/tone'
import { PageHeader } from '@/components/mcs/page-header'
import { useServerStore } from '@/stores/server'
import { ConnectionForm } from './components/connection-form'
import { AccountPanel } from './components/account-panel'
import { GeneralPanel } from './components/general-panel'
import { NotificationsPanel } from './components/notifications-panel'
import { BackupPanel } from './components/backup-panel'
import { AboutPanel } from './components/about-panel'
import { UpdateCheckSection } from './components/update-check-section'

/** 子导航项（六项） */
const SUB_NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/settings/connection', label: '连接设置', icon: Link2 },
  { to: '/settings/account', label: '账号与安全', icon: ShieldCheck },
  { to: '/settings/general', label: '通用设置', icon: SlidersHorizontal },
  { to: '/settings/notifications', label: '通知设置', icon: BellRing },
  { to: '/settings/backup', label: '备份管理', icon: DatabaseBackup },
  { to: '/settings/about', label: '关于', icon: Info },
]

export function SettingsPage() {
  const { pathname } = useLocation()
  // 页面头标题随当前子路由（与其他列表页统一 22px 主标题层级）
  const current = SUB_NAV.find((item) => pathname.startsWith(item.to)) ?? SUB_NAV[0]

  return (
    <div className="flex h-full min-h-0 gap-4 p-4">
      {/* ── 左子导航（实底卡，200px，标题「设置」；<md 折叠为纯图标） ── */}
      <nav
        aria-label="设置子导航"
        className="flex w-12 shrink-0 flex-col gap-1 self-start rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-2 shadow-mcs-card md:w-50"
      >
        <p className="hidden px-2 py-1.5 text-mcs-2xs font-semibold text-mcs-text-muted md:block">
          设置
        </p>
        {SUB_NAV.map(({ to, label, icon: Icon }) => {
          const active = pathname.startsWith(to)
          return (
            <Link
              key={to}
              to={to}
              title={label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center justify-center gap-2 rounded-mcs-sm border p-2 text-mcs-sm transition-colors md:justify-start md:px-2.5',
                active
                  ? `${TONE_SELECTED_CLASSES} font-semibold`
                  : 'border-transparent font-medium text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="hidden md:inline">{label}</span>
            </Link>
          )
        })}
      </nav>

      {/* ── 右内容区（页面头 + 子路由 Outlet） ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PageHeader title={current?.label} className="px-4 pt-1" />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Outlet />
        </div>
      </div>
    </div>
  )
}

// ── 六个子页薄封装（子路由组件；实例数据从 server store 注入 backup/general 面板） ──

/** 连接设置子页 */
export function ConnectionSettingsPage() {
  return <ConnectionForm variant="settings" />
}

/** 账号与安全子页（管理员密码 / 会话管理 / 登出） */
export function AccountSettingsPage() {
  return <AccountPanel />
}

/** 通用设置子页 */
export function GeneralSettingsPage() {
  return <GeneralPanel />
}

/** 通知设置子页 */
export function NotificationsSettingsPage() {
  return <NotificationsPanel />
}

/** 备份管理子页（实例切换经 server store 自动重载） */
export function BackupSettingsPage() {
  const instanceId = useServerStore((s) => s.instanceId)
  return <BackupPanel instanceId={instanceId} />
}

/** 关于子页（静态面板 + 更新检查） */
export function AboutSettingsPage() {
  return (
    <>
      <AboutPanel />
      <div className="mt-3">
        <UpdateCheckSection />
      </div>
    </>
  )
}
