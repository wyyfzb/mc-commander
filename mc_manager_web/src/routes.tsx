import { lazy } from 'react'
import { createBrowserRouter, redirect } from 'react-router'
import { AppShell } from '@/layouts/app-shell'
import { useConnectionStore } from '@/stores/connection'
import {
  AboutSettingsPage,
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
const TasksPage = lazy(() =>
  import('@/features/tasks/tasks-page').then((m) => ({ default: m.TasksPage })),
)
const InstancesPage = lazy(() =>
  import('@/features/instances/instances-page').then((m) => ({ default: m.InstancesPage })),
)
const OnboardingPageLazy = lazy(() =>
  import('@/features/onboarding/onboarding-page').then((m) => ({ default: m.OnboardingPage })),
)
const EmergencyPageLazy = lazy(() =>
  import('@/features/emergency/emergency-page').then((m) => ({ default: m.EmergencyPage })),
)

/** 首次使用守卫（D11）：无连接配置（status=unconfigured）→ 引导页 */
function requireConfigured() {
  const status = useConnectionStore.getState().status
  if (status === 'unconfigured') return redirect('/onboarding')
  return null
}

/** 已配置时访问引导页 → 回仪表盘 */
function requireUnconfigured() {
  const status = useConnectionStore.getState().status
  if (status !== 'unconfigured') return redirect('/dashboard')
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
      { path: 'instances', Component: InstancesPage },
      {
        path: 'settings',
        Component: SettingsPage,
        children: [
          { index: true, loader: () => redirect('/settings/connection') },
          { path: 'connection', Component: ConnectionSettingsPage },
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
