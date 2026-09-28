import {
  Bell,
  Copy,
  KeyRound,
  LogOut,
  Menu,
  Moon,
  Search,
  Server,
  Settings,
  Sun,
  UserRound,
} from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/mcs/icon-button'
import { StatusIndicator, type IndicatorStatus } from '@/components/mcs/status-indicator'
import { NotificationDrawer } from '@/layouts/notification-drawer'
import { useUiStore } from '@/stores/ui'
import { useServerStore } from '@/stores/server'
import { useInstanceSwitch } from '@/hooks/use-instance-switch'
import { useNotificationStore } from '@/stores/notifications'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore } from '@/stores/auth'
import { logout } from '@/api/auth'
import { useInstances } from '@/api/queries'
import { copyText } from '@/lib/clipboard'
import { sessionAppliesToPanel } from '@/lib/mc-connection'
import { clearLocalCredentials, logoutToastText } from '@/lib/logout'
import { primaryModifierLabel } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { instanceLabel } from '@/lib/instance-label'
import { instanceHueFillClass } from '@/lib/instance-hue'

/**
 * AppTopBar —— 主顶栏（设计文档 §3.1）
 * 实例选择器 ▸ 全局搜索 (Cmd/Ctrl+K) ▸ 服务器状态点（WS 实时）▸ 通知铃铛（未读徽章+抽屉）▸ 主题切换
 */
export function AppTopBar() {
  const navigate = useNavigate()
  const theme = useUiStore((s) => s.theme)
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const toggleMobileNav = useUiStore((s) => s.toggleMobileNav)
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const notificationsOpen = useUiStore((s) => s.notificationsOpen)
  const setNotificationsOpen = useUiStore((s) => s.setNotificationsOpen)

  const connectionStatus = useConnectionStore((s) => s.status)
  const socketConnected = useServerStore((s) => s.socketConnected)
  const hasConnectedOnce = useServerStore((s) => s.hasConnectedOnce)
  const status = useServerStore((s) => s.status)
  const instanceId = useServerStore((s) => s.instanceId)
  const { switchInstance } = useInstanceSwitch()
  const unreadCount = useNotificationStore((s) => s.unreadCount)

  // 安全主线：用户菜单（会话登录显示管理员身份；API Key 直连显示凭据徽章）
  // 会话只在签发它的面板上算数：换地址后按 API Key 直连呈现（见 lib/mc-connection）
  const session = useAuthStore((s) => s.session)
  const apiKey = useConnectionStore((s) => s.apiKey)
  const baseUrl = useConnectionStore((s) => s.baseUrl)
  const sessionToken = sessionAppliesToPanel(session, baseUrl) ? (session?.token ?? null) : null
  const [loggingOut, setLoggingOut] = useState(false)

  const handleLogout = async () => {
    setLoggingOut(true)
    // 登出会一并清掉本机保存的 API Key（不可从浏览器恢复）——如实告知，不让用户在别处才发现
    const doneToast = logoutToastText(Boolean(useConnectionStore.getState().apiKey))
    try {
      if (sessionToken) {
        await logout({ baseUrl: useConnectionStore.getState().baseUrl, apiKey })
      }
      clearLocalCredentials()
      toast.info(doneToast)
      navigate('/login', { replace: true })
    } catch {
      // 服务端登出失败不阻塞本地登出（令牌已不可用）
      clearLocalCredentials()
      toast.info(doneToast)
      navigate('/login', { replace: true })
    } finally {
      setLoggingOut(false)
    }
  }

  const instancesQuery = useInstances()

  // 状态点语义（三重编码；区分"初次连接"与"实时通道断开"）：降级档只表达
  // "实时通道断了"这一已知事实——面板是否同样不可达在此无从判定，
  // 能否取到数据由页面错误态如实呈现（降级横幅另说定时轮询确实存在）
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

  // 无匹配实例时不得假造「默认实例」这类并不存在的名字；也不得把「列表还没到」
  // （加载中/请求失败）谎报成「一个实例都没有」——三种缺位各有诚实占位
  const instanceList = instancesQuery.data ?? []
  const selectedInstance = instanceList.find((i) => i.id === instanceId)
  // 展示名统一走 instanceLabel（空名/纯空白名回退 id，避免顶栏出现「未选择实例」式的空壳）
  const selectedInstanceName = selectedInstance ? instanceLabel(selectedInstance) : undefined
  const instanceNameFallback =
    instanceList.length > 0
      ? '未选择实例'
      : instancesQuery.isError
        ? '实例列表加载失败'
        : instancesQuery.isPending
          ? '加载中…'
          : '暂无实例'
  const currentInstanceName = selectedInstanceName ?? instanceNameFallback
  const noInstances = instancesQuery.isSuccess && instanceList.length === 0

  /** 单实例且正是当前选中实例时才降级为纯展示：只有一个选项的下拉除了展开什么也做不了。
      单实例但选中的是列表外的陈旧 id 时仍保留下拉——那时用户正需要靠它把那唯一实例选回来 */
  const singleSelectedInstance = instanceList.length === 1 && instanceList[0]?.id === instanceId

  /** 实例固定色相标识（非语义 identity：只回答「是哪个实例」，不表达运行/告警状态；
      未选中实例时不渲染，避免与「暂无实例」等占位文案一起假装有个实例） */
  const instanceHueDot = instanceId ? (
    <span
      data-instance-hue
      className={cn('size-2 shrink-0 rounded-full', instanceHueFillClass(instanceId))}
      aria-hidden
    />
  ) : null

  return (
    <header className="glass-chrome flex h-12 shrink-0 items-center gap-2 border-b border-mcs-border-muted px-3">
      {/* 移动端导航抽屉开关（桌面侧栏开合在侧栏 Logo 上，见 app-sidebar） */}
      <IconButton onClick={toggleMobileNav} aria-label="打开导航菜单" className="md:hidden">
        <Menu aria-hidden />
      </IconButton>

      {/* 服务器地址 chip（带复制按钮，方便发给玩家直连） */}
      {status?.address && (
        <span className="hidden items-center gap-1 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-muted py-1 pr-1 pl-2 font-mono text-mcs-2xs text-mcs-text-muted lg:inline-flex">
          <Server className="size-3" aria-hidden />
          <span title="MC 客户端连接地址（含端口）">{status.address}</span>
          <button
            type="button"
            onClick={() =>
              void copyText(status.address).then((ok) => {
                if (ok) toast.success('服务器地址已复制', { duration: 1500 })
                else toast.error('复制失败，请手动复制')
              })
            }
            aria-label="复制服务器地址"
            title="复制地址发给玩家"
            className="rounded-mcs-xs p-1 text-mcs-text-muted transition-colors hover:bg-mcs-state-hover hover:text-mcs-text-default focus-visible:outline-2 focus-visible:outline-mcs-focus-ring focus-visible:outline-offset-1"
          >
            <Copy className="size-3" aria-hidden />
          </button>
        </span>
      )}

      {/* 实例选择器：单实例降级为纯展示（见 singleSelectedInstance）；0 实例 / 加载中 / 失败
          仍保留下拉：那里要承载「前往部署」与诚实的缺位说明 */}
      {singleSelectedInstance ? (
        <span className="flex max-w-32 items-center gap-1.5 px-1 text-mcs-sm font-medium text-mcs-text-default">
          <Server className="size-4 shrink-0 text-mcs-text-muted" aria-hidden />
          {instanceHueDot}
          <span className="truncate">{currentInstanceName}</span>
        </span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="max-w-32 gap-1.5 text-mcs-sm font-medium">
              <Server className="size-4 shrink-0 text-mcs-text-muted" aria-hidden />
              {instanceHueDot}
              <span className="truncate">{currentInstanceName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>服务器实例</DropdownMenuLabel>
            {/* 仅「确实一个实例都没有」才推去部署向导；列表未到/失败时不假装没有实例 */}
            {noInstances && (
              <DropdownMenuItem onClick={() => navigate('/instances?tab=deploy')}>
                暂无实例，前往部署
              </DropdownMenuItem>
            )}
            {instancesQuery.isError && (
              <DropdownMenuItem disabled>实例列表加载失败</DropdownMenuItem>
            )}
            {instancesQuery.isPending && (
              <DropdownMenuItem disabled>正在加载实例列表…</DropdownMenuItem>
            )}
            {instanceList.map((inst) => (
              <DropdownMenuItem
                key={inst.id}
                onClick={() => switchInstance(inst.id)}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{instanceLabel(inst)}</span>
                {inst.id === instanceId ? (
                  <span className="size-1.5 rounded-full bg-mcs-accent" aria-label="当前实例" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* 全局搜索（Cmd/Ctrl+K） */}
      <Button
        variant="outline"
        // 窄窗口文案被 hidden xs:inline 隐藏后按钮无可访问名（图标 aria-hidden）→ 显式补名
        aria-label="搜索或执行命令"
        className="ml-auto w-9 justify-center gap-2 text-mcs-sm text-mcs-text-muted xs:w-44 xs:justify-between sm:w-56"
        onClick={() => setCommandPaletteOpen(true)}
      >
        {/* 窄窗口防错位：文案区可截断收缩（min-w-0 + truncate），kbd 徽标 shrink-0 永不换行 */}
        <span className="inline-flex min-w-0 flex-1 items-center gap-2">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="hidden truncate xs:inline">搜索或执行命令…</span>
        </span>
        <kbd className="pointer-events-none hidden h-5 shrink-0 items-center gap-0.5 rounded border border-mcs-border-default bg-mcs-bg-default px-1.5 font-mono text-mcs-2xs font-medium whitespace-nowrap text-mcs-text-muted xs:inline-flex">
          {`${primaryModifierLabel()} K`}
        </kbd>
      </Button>

      {/* 服务器状态点（WS 实时） */}
      <StatusIndicator status={indicator} className="hidden md:inline-flex" />

      {/* 通知铃铛（未读徽章 + 抽屉） */}
      <IconButton
        tooltip="通知"
        tooltipSide="bottom"
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
      </IconButton>

      {/* 用户菜单（安全主线：管理员身份 / 凭据状态） */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={sessionToken ? '管理员菜单' : 'API Key 直连状态'}>
            {sessionToken ? (
              <UserRound aria-hidden />
            ) : (
              <KeyRound aria-hidden className="text-mcs-warning-fg" />
            )}
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            {sessionToken ? '管理员（会话登录）' : 'API Key 直连'}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate('/settings/account')} className="gap-2">
            <Settings className="size-4 text-mcs-text-muted" aria-hidden />
            账号与安全
          </DropdownMenuItem>
          {sessionToken ? (
            <DropdownMenuItem
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              className="gap-2 text-mcs-error-fg focus:text-mcs-error-fg"
            >
              <LogOut className="size-4" aria-hidden />
              退出登录
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() => {
                // API Key 直连登出=清除本浏览器凭据（该通道无服务端会话，无需调 logout API）；
                // 不清则 /login 守卫弹回（与会话分支共用同一处置）
                // 先取文案再清凭据：清完 Key 就没了，后取会恒判为「没清过」
                const doneToast = logoutToastText(Boolean(useConnectionStore.getState().apiKey))
                clearLocalCredentials()
                toast.info(doneToast)
                navigate('/login', { replace: true })
              }}
              className="gap-2 text-mcs-error-fg focus:text-mcs-error-fg"
            >
              <LogOut className="size-4" aria-hidden />
              退出登录
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 主题切换 */}
      <IconButton
        className="hidden xs:inline-flex"
        tooltip={theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
        tooltipSide="bottom"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
      >
        {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
      </IconButton>

      <NotificationDrawer open={notificationsOpen} onOpenChange={setNotificationsOpen} />
    </header>
  )
}
