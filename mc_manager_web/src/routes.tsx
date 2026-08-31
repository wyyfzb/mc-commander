import { lazy } from 'react'
import { createBrowserRouter, redirect } from 'react-router'
import { AppShell } from '@/layouts/app-shell'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore, SESSION_EXPIRED_EVENT } from '@/stores/auth'
import {
  AboutSettingsPage,
  AccountSettingsPage,
  BackupSettingsPage,
  ConnectionSettingsPage,
  GeneralSettingsPage,
  NotificationsSettingsPage,
  SettingsPage,
} from '@/features/settings/settings-page'

/**
 * 路由表（react-router v8 data mode）
 * - 路由必须静态定义（v8 data mode 约定）；URL 深链接/刷新保持原生支持
 * - 性能：页面组件 route-level React.lazy（Monaco/echarts 随页 chunk 懒加载）；
 *   AppShell 与设置子页不 lazy（布局核心 + 设置页高频轻量）
 */

const DashboardPage = lazy(() =>
  import('@/features/dashboard/dashboard-page').then((m) => ({ default: m.DashboardPage })),
)
const PlayersPage = lazy(() =>
  import('@/features/players/players-page').then((m) => ({ default: m.PlayersPage })),
)
const WorldPage = lazy(() =>
  import('@/features/world/world-page').then((m) => ({ default: m.WorldPage })),
)
const FilesPage = lazy(() =>
  import('@/features/files/files-page').then((m) => ({ default: m.FilesPage })),
)
const PluginsPage = lazy(() =>
  import('@/features/plugins/plugins-page').then((m) => ({ default: m.PluginsPage })),
)
const TasksPage = lazy(() =>
  import('@/features/tasks/tasks-page').then((m) => ({ default: m.TasksPage })),
)
const InstancesPage = lazy(() =>
  import('@/features/instances/instances-page').then((m) => ({ default: m.InstancesPage })),
)
const WebhookPage = lazy(() =>
  import('@/features/webhooks/webhook-page').then((m) => ({ default: m.default })),
)
const OnboardingPageLazy = lazy(() =>
  import('@/features/onboarding/onboarding-page').then((m) => ({ default: m.OnboardingPage })),
)
const AuditPageLazy = lazy(() =>
  import('@/features/audit/audit-page').then((m) => ({ default: m.AuditPage })),
)
const EmergencyPageLazy = lazy(() =>
  import('@/features/emergency/emergency-page').then((m) => ({ default: m.EmergencyPage })),
)
const LoginPageLazy = lazy(() =>
  import('@/features/auth/login-page').then((m) => ({ default: m.LoginPage })),
)

/**
 * 凭据判定（安全主线守卫）：API Key（自动化通道）或管理员会话令牌（登录通道）
 * 任一存在即视为已连接。loader 与 React 渲染周期解耦，直接读 store 快照
 */
function hasCredentials(): boolean {
  const { apiKey } = useConnectionStore.getState()
  const { session } = useAuthStore.getState()
  return Boolean(apiKey || session?.token)
}

/** 连接守卫（D11 演进）：无任何凭据 → 登录页（登录页内含首访设密向导） */
function requireConfigured() {
  if (!hasCredentials()) return redirect('/login')
  return null
}

/** 无凭据守卫：已连接时访问登录页/引导页 → 回仪表盘 */
function requireUnconfigured() {
  if (hasCredentials()) return redirect('/dashboard')
  return null
}

export const router = createBrowserRouter([
  {
    path: '/',
    Component: AppShell,
    loader: requireConfigured,
    children: [
      { index: true, loader: () => redirect('/dashboard') },
      { path: 'dashboard', Component: DashboardPage },
      { path: 'players', Component: PlayersPage },
      { path: 'world', Component: WorldPage },
      { path: 'files', Component: FilesPage },
      { path: 'tasks', Component: TasksPage },
      { path: 'plugins', Component: PluginsPage },
      { path: 'instances', Component: InstancesPage },
      { path: 'webhooks', Component: WebhookPage },
      { path: 'audit', Component: AuditPageLazy },
      {
        path: 'settings',
        Component: SettingsPage,
        children: [
          { index: true, loader: () => redirect('/settings/connection') },
          { path: 'connection', Component: ConnectionSettingsPage },
          { path: 'account', Component: AccountSettingsPage },
          { path: 'general', Component: GeneralSettingsPage },
          { path: 'notifications', Component: NotificationsSettingsPage },
          { path: 'backup', Component: BackupSettingsPage },
          { path: 'about', Component: AboutSettingsPage },
        ],
      },
      { path: '*', loader: () => redirect('/dashboard') },
    ],
  },
  {
    path: '/login',
    Component: LoginPageLazy,
    loader: requireUnconfigured,
  },
  {
    path: '/onboarding',
    Component: OnboardingPageLazy,
    loader: requireUnconfigured,
  },
  // 移动端紧急视图：独立于 AppShell 的窄屏处置页，PWA 主屏直达
  {
    path: '/emergency',
    Component: EmergencyPageLazy,
    loader: requireConfigured,
  },
])

/**
 * 会话过期全局处置：client.ts 检测 40103 时派发事件（与 React 无关的模块层），
 * 此处用 router.navigate 跳登录页——不依赖组件树，与 history/hash 路由模式无关。
 * 清会话由派发方（clearSessionAndDispatchExpired）完成，这里补一次 status 重算
 * 并带上 returnTo 便于登录后回跳。
 */
if (typeof window !== 'undefined') {
  window.addEventListener(SESSION_EXPIRED_EVENT, () => {
    useConnectionStore.getState().refreshStatus()
    const current = router.state.location.pathname
    // 已在登录页/引导页时不再跳转（避免循环）
    if (current === '/login' || current === '/onboarding') return
    const search = new URLSearchParams()
    if (current && current !== '/') search.set('returnTo', current)
    const qs = search.toString()
    void router.navigate(`/login${qs ? `?${qs}` : ''}`)
  })
}
