import { lazy } from 'react'
import { createBrowserRouter, redirect } from 'react-router'
import { AppShell } from '@/layouts/app-shell'
import { hasUsableCredentials } from '@/stores/connection'
import { installSessionExpiryHandler } from '@/lib/session-expiry'
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
 * - 性能：页面组件 route-level React.lazy（Monaco 随页 chunk 懒加载）；
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
 * 连接守卫（D11 演进）：无本面板可用凭据 → 登录页（登录页内含首访设密向导）
 * 凭据口径见 stores/connection.ts 的 hasUsableCredentials（会话只在签发它的面板上算数）
 */
function requireConfigured() {
  if (!hasUsableCredentials()) return redirect('/login')
  return null
}

/** 无凭据守卫：已连接时访问登录页/引导页 → 回仪表盘 */
function requireUnconfigured() {
  if (hasUsableCredentials()) return redirect('/dashboard')
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

// 会话过期（40103）的全局处置：client.ts 派发事件 → 此处决策跳登录页或保留 Key 续用
// （与 React 无关的模块层监听，不依赖组件树，history/hash 两种路由模式均正确）
if (typeof window !== 'undefined') installSessionExpiryHandler(router)
