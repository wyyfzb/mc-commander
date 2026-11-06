/**
 * SettingsPage —— 设置页布局
 * - 左子导航 200px（实底卡片）+ 右内容区 Outlet（子路由 device|account|notifications|integration|data）
 * - 菜单激活态：accent-bg-subtle 底 + accent-border + accent 文字
 * - 「关于」不在子导航里：它是纯静态信息，用弹窗承载（入口在导航底部）
 * - 设计纪律：设置页内容区实底（风格 A 玻璃禁区）；子侧栏同实底卡
 */
import { Suspense, lazy, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { BellRing, HardDrive, Info, Laptop, ShieldCheck, Webhook } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TONE_SELECTED_CLASSES } from '@/components/mcs/tone'
import { PageHeader } from '@/components/mcs/page-header'
import { ListSkeleton } from '@/components/mcs/data-states'
import { DevicePanel } from './components/device-panel'
import { IntegrationPanel } from './components/integration-panel'
import { NotificationsPanel } from './components/notifications-panel'
import { AboutDialog } from './components/about-dialog'

// 登录与密码、数据与卸载各自带着低频重面板（会话轮询 / 导出 / 删除命令预览），
// 静态引入会把它们塞进入口 chunk，首访任意页面都要多下几十 KB
const AccountPanel = lazy(() =>
  import('./components/account-panel').then((m) => ({ default: m.AccountPanel })),
)
const DataPanel = lazy(() =>
  import('./components/data-panel').then((m) => ({ default: m.DataPanel })),
)

/** 子页 chunk 加载占位：内容区骨架，切页时不留整块空白 */
function PanelFallback() {
  return (
    <div role="status" aria-label="设置内容加载中">
      <ListSkeleton rows={3} />
    </div>
  )
}

/**
 * 子导航项（五项）。分组判据是**换设备跟不跟过来**：浏览器本地偏好（连接与外观）／
 * 服务端账号（登录与密码）／服务端偏好（通知）／独立页面入口（推送与记录）／
 * 面板自身去留（数据与卸载）。按到达频率分会把「换电脑后要重配的」拆散。
 */
const SUB_NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/settings/device', label: '连接与外观', icon: Laptop },
  { to: '/settings/account', label: '登录与密码', icon: ShieldCheck },
  { to: '/settings/notifications', label: '通知', icon: BellRing },
  { to: '/settings/integration', label: '推送与记录', icon: Webhook },
  { to: '/settings/data', label: '数据与卸载', icon: HardDrive },
]

export function SettingsPage() {
  const { pathname } = useLocation()
  const [aboutOpen, setAboutOpen] = useState(false)
  // 页面头标题随当前子路由（与其他列表页统一 22px 主标题层级）
  const current = SUB_NAV.find((item) => pathname.startsWith(item.to)) ?? SUB_NAV[0]

  return (
    /* @container：子导航「图标态 ↔ 文字态」按可用内容宽切档而非视口宽——侧栏可折叠
       （56px ↔ 208px），同视口下内容宽差 152px：768 视口展开侧栏内容仅 528px，
       视口 md 把子导航展成 200px 文字态，右表单区被压到 312px */
    <div className="@container flex h-full min-h-0 gap-4 p-4">
      {/* ── 左子导航（实底卡，内容宽 ≥768px 时展到 200px 带文字；否则纯图标 + title） ──
          档位 @3xl=768px：展态占 200px，右表单区至少还剩 552px；低于此宽保持图标态，
          把宽度让给表单（528px 内容宽下表单可得 464px，比展态的 312px 宽 152px） */}
      <nav
        aria-label="设置子导航"
        className="flex w-12 shrink-0 flex-col gap-1 self-start rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-2 shadow-mcs-card @3xl:w-50"
      >
        <p className="hidden px-2 py-1.5 text-mcs-2xs font-semibold text-mcs-text-muted @3xl:block">
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
                'flex items-center justify-center gap-2 rounded-mcs-sm border p-2 text-mcs-sm transition-colors @3xl:justify-start @3xl:px-2.5',
                active
                  ? `${TONE_SELECTED_CLASSES} font-semibold`
                  : 'border-transparent font-medium text-mcs-text-muted hover:bg-mcs-state-hover hover:text-mcs-text-default',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="hidden @3xl:inline">{label}</span>
            </Link>
          )
        })}
        {/* 关于：不占子导航位（纯静态信息），但也不能没有入口——放在导航末尾，
            与上面的路由项用一条分隔线区分「这不是一个子页」。
            窄容器下只出图标，故可访问名由 aria-label 承担（title 只是鼠标提示） */}
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          aria-label="关于"
          className="mt-1 flex items-center justify-center gap-2 rounded-mcs-sm border-t border-mcs-border-subtle px-2 py-2 pt-3 text-mcs-sm font-medium text-mcs-text-muted transition-colors hover:bg-mcs-state-hover hover:text-mcs-text-default @3xl:justify-start @3xl:px-2.5"
        >
          <Info className="size-4 shrink-0" aria-hidden />
          <span className="hidden @3xl:inline">关于</span>
        </button>
      </nav>

      {/* ── 右内容区（页面头 + 子路由 Outlet） ── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PageHeader title={current?.label} className="px-4 pt-1" />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Outlet />
        </div>
      </div>

      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  )
}

// ── 子页薄封装（子路由组件） ──

/** 连接与外观子页（面板连接 + 界面偏好，两项都只落浏览器 localStorage） */
export function DeviceSettingsPage() {
  return <DevicePanel />
}

/** 推送与记录子页（webhooks / audit 两个独立页面的入口卡） */
export function IntegrationSettingsPage() {
  return <IntegrationPanel />
}

/** 登录与密码子页（管理员密码 / 会话管理 / 登出 / 两步验证 / 传输加密） */
export function AccountSettingsPage() {
  return (
    <Suspense fallback={<PanelFallback />}>
      <AccountPanel />
    </Suspense>
  )
}

/** 通知子页（事件类型开关矩阵，偏好存服务端） */
export function NotificationsSettingsPage() {
  return <NotificationsPanel />
}

/** 数据与卸载子页（面板自身去留） */
export function DataSettingsPage() {
  return (
    <Suspense fallback={<PanelFallback />}>
      <DataPanel />
    </Suspense>
  )
}
