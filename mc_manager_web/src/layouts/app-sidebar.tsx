import { useEffect, useRef, useCallback } from 'react'
import { NavLink } from 'react-router'
import {
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  LayoutDashboard,
  Users,
  Globe,
  FolderOpen,
  CalendarClock,
  Puzzle,
  Server,
  Settings,
  ScrollText,
  Webhook as WebhookIcon,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { BrandLogo } from '@/components/mcs/brand-logo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useUiStore } from '@/stores/ui'
import { useInstanceStatus, useInstances, FALLBACK_POLL_INTERVAL_MS } from '@/api/queries'
import { instanceLabel } from '@/lib/instance-label'
import { useServerStore } from '@/stores/server'

/**
 * AppSidebar —— 主侧栏（设计文档 §3.1）
 * 导航：仪表盘/玩家/世界/文件/任务/实例 + 底部设置
 * 折叠由 zustand（useUiStore.sidebarCollapsed）驱动
 * 移动端（<768px）：fixed 抽屉 + 遮罩（useUiStore.mobileNavOpen 驱动）；底部实例迷你卡
 * 两种形态的共用主体见 SidebarBody——形态差异由判别联合在编译期切开
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
  { to: '/plugins', label: '插件', icon: Puzzle },
  { to: '/instances', label: '实例', icon: Server },
  { to: '/webhooks', label: 'Webhook', icon: WebhookIcon },
  { to: '/audit', label: '审计日志', icon: ScrollText },
]

// 底部辅助区与「设置」并列：帮助是查阅型静态内容，不进日常操作主序列（PRIMARY_NAV 保持 9 项）
const BOTTOM_NAV: NavItem[] = [
  { to: '/help', label: '帮助', icon: CircleHelp },
  { to: '/settings', label: '设置', icon: Settings },
]

/**
 * useFocusTrap —— WAI-ARIA 焦点陷阱（hook 形式）
 * 返回的 keydown 处理器须挂在**包含容器在内的祖先**上：React 合成事件沿 fiber 祖先链传播，
 * 挂在兄弟哨兵节点上的处理器永远收不到容器内的事件（Escape/Tab 均失效）。
 * 打开时 Tab 循环在容器内、Escape 关闭；关闭后焦点还原到触发按钮。
 * 仅用于移动端抽屉（<768px），桌面侧栏无需焦点陷阱。
 */
function useFocusTrap(
  active: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  onDeactivate: () => void,
) {
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // 保存/还原焦点
  useEffect(() => {
    if (active) {
      previousFocusRef.current = document.activeElement as HTMLElement
      // 自动聚焦容器内第一个可聚焦元素
      const first = containerRef.current?.querySelector<HTMLElement>(
        'a, button, [tabindex]:not([tabindex="-1"])',
      )
      first?.focus()
    } else {
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [active, containerRef])

  // Tab 循环 + Escape 关闭
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!active || !containerRef.current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onDeactivate()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = containerRef.current.querySelectorAll<HTMLElement>(
        'a, button, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    },
    [active, containerRef, onDeactivate],
  )

  return handleKeyDown
}

interface AppSidebarProps {
  collapsed: boolean
  mobileNavOpen: boolean
  onMobileNavClose: () => void
}

export function AppSidebar({ collapsed, mobileNavOpen, onMobileNavClose }: AppSidebarProps) {
  const mobileDrawerRef = useRef<HTMLElement | null>(null)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const handleDrawerKeyDown = useFocusTrap(mobileNavOpen, mobileDrawerRef, onMobileNavClose)

  return (
    <>
      {/* 桌面侧栏（≥768px）；overflow-hidden 让常驻文字随宽度过渡裁剪（防收起中溢出）
          宽度过渡是布局属性：收起/展开要重排兄弟节点，transform 无法替代（除非改「滑出浮层」模型，
          会改变交互语义）→ 保留宽度过渡，用 contain 把重排/重绘限制在侧栏内部 */}
      <aside
        className={cn(
          'hidden h-full shrink-0 flex-col overflow-hidden border-r border-mcs-border-muted contain-[layout_paint] md:flex',
          'bg-mcs-bg-muted',
          'transition-[width] duration-mcs-base ease-mcs-snappy',
          collapsed ? 'w-14' : 'w-52',
        )}
        aria-label="主导航"
      >
        <SidebarBody
          variant="rail"
          collapsed={collapsed}
          onToggle={() => toggleSidebar()}
          onNavigate={onMobileNavClose}
        />
      </aside>

      {/* 移动端抽屉（<768px）：fixed 覆盖层 + 遮罩；关闭态 inert 移出焦点顺序 */}
      <div
        className={cn(
          'fixed inset-0 z-(--mcs-z-overlay) md:hidden',
          !mobileNavOpen && 'pointer-events-none',
        )}
        onKeyDown={handleDrawerKeyDown}
      >
        <div
          className={cn(
            'absolute inset-0 bg-mcs-scrim transition-opacity duration-mcs-base',
            mobileNavOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={onMobileNavClose}
          aria-hidden
        />
        <aside
          ref={mobileDrawerRef}
          className={cn(
            'relative inset-y-0 left-0 flex w-64 flex-col border-r border-mcs-border-muted bg-mcs-bg-muted',
            'transition-transform duration-mcs-base ease-mcs-snappy',
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          )}
          aria-label="主导航（移动端）"
          aria-hidden={!mobileNavOpen}
          inert={!mobileNavOpen}
        >
          <SidebarBody variant="drawer" onNavigate={onMobileNavClose} />
        </aside>
      </div>
    </>
  )
}

/**
 * SidebarBody —— 侧栏主体（品牌行 + 导航 + 实例迷你卡），两种形态共用一份标记
 *
 * 形态差异用判别联合表达，且 **drawer 形态拿不到 collapsed**：
 * - rail：桌面常驻导轨，占布局宽，可收起（w-52 ↔ w-14）⇒ 带 collapsed 与开合交互
 * - drawer：<768 的 256px 浮层，不占布局宽 ⇒ 没有「收起」概念，恒展开态
 *
 * drawer 恒展开态是硬约束：桌面 sidebarCollapsed 渗进来会让窄屏下开抽屉只剩图标、
 * 实例迷你卡也被条件卸载。判别联合把这条约束变成编译期事实，不依赖调用约定自觉。
 */
type SidebarBodyProps = {
  onNavigate: () => void
} & ({ variant: 'rail'; collapsed: boolean; onToggle: () => void } | { variant: 'drawer' })

function SidebarBody(props: SidebarBodyProps) {
  const { onNavigate } = props
  const instanceId = useServerStore((s) => s.instanceId)
  const socketConnected = useServerStore((s) => s.socketConnected)
  const instancesQuery = useInstances()
  const current = instancesQuery.data?.find((i) => i.id === instanceId)
  const isCollapsed = props.variant === 'rail' && props.collapsed
  // 详情与实例名一样取自本组件自己的订阅（不复用顶栏那份）：两者渲染在同一屏，
  // query key 相同，TanStack Query 去重后仍是一次请求
  const { data: instanceDetail } = useInstanceStatus(instanceId)

  /* 该标记的真值是实例详情里的 capabilities.msmpPush，而服务端在推送面断连时**不广播**
     capabilities（只改自身状态）⇒ 标记最多滞后一个详情轮询周期（30 秒）后才翻转；
     方向上是「已断但仍说实时」这个短暂窗口，自愈。要消掉需服务端在通道 connect/disconnect
     时广播一次状态。
     「是否实时」这条结果说明挂在实例状态行尾部（不新增控件、不新增一行）：
     推送连通 = 状态变化即时到达，否则回落到定时轮询。
     实时通道断开时两个档位都不说——那时轮询是否真在刷新无从判定（面板整体不可达时
     它同样失败），降级横幅已据实写明「每 N 秒」，两处会重复。
     详情未到达（capabilities 读不到）时同样不说：宁可不说，也不说错。
     秒数取 queries 常量，写死一处就会与真实间隔漂移。
     两档都用两字标签（「实时」/「轮询」）而不是「每 30 秒」：后者只给数量、不说什么东西每
     30 秒一次，读起来像倒计时或限额；「轮询」直接描述数据是怎么来的，且与该行既有内容同为
     短语。展开态 rail 该行内容宽实测 149px（「运行中 · 3 人在线」占 90px），带空格的整句要
     172px 会被 truncate 成「每 30 …」——两字标签不会；完整句子仍进 title/sr-only */
  const pushConnected = instanceDetail?.capabilities?.msmpPush
  const pollSeconds = FALLBACK_POLL_INTERVAL_MS / 1000
  const refreshMark =
    socketConnected && pushConnected !== undefined ? (pushConnected ? '实时' : '轮询') : null
  const refreshMarkDescription = !refreshMark
    ? undefined
    : pushConnected
      ? '实时推送已连通，服务器的状态变化会立即到达面板'
      : `实时推送未连通，面板每 ${pollSeconds} 秒刷新一次状态`

  const links = (items: NavItem[], extraClass?: string) => (
    <nav className={cn('flex flex-col gap-1 p-2', extraClass)}>
      {items.map(({ to, label, icon: Icon }) => (
        <SidebarLink
          key={to}
          to={to}
          label={label}
          icon={Icon}
          collapsed={isCollapsed}
          onClick={onNavigate}
        />
      ))}
    </nav>
  )

  return (
    <>
      <BrandRow
        collapsed={isCollapsed}
        onToggle={props.variant === 'rail' ? props.onToggle : undefined}
      />
      {links(PRIMARY_NAV, 'flex-1 overflow-y-auto')}
      {links(BOTTOM_NAV, 'border-t border-mcs-border-muted')}

      {/* 实例迷你卡（原型 side-foot：当前实例 + TPS + 人数；仅展开态展示） */}
      {!isCollapsed && current && (
        <div className="border-t border-mcs-border-muted p-2.5">
          <div className="flex items-center gap-2 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted px-2.5 py-2 shadow-mcs-card">
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                current.isRunning
                  ? 'bg-mcs-success-fg shadow-mcs-glow-accent'
                  : 'bg-mcs-text-muted',
              )}
              aria-hidden
            />
            <div className="min-w-0">
              <div className="truncate text-mcs-xs font-semibold text-mcs-text-default">
                {instanceLabel(current)}
              </div>
              <div
                className="truncate font-mono text-mcs-2xs text-mcs-text-muted"
                title={refreshMarkDescription}
              >
                {current.isRunning ? '运行中' : '已停止'} · {current.playerCount} 人在线
                {refreshMark && ` · ${refreshMark}`}
                {/* 完整解释挂在 role=generic 的 div 上按规范会被读屏忽略（本仓已踩过），故用 sr-only */}
                {refreshMarkDescription && (
                  <span className="sr-only">，{refreshMarkDescription}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * BrandRow —— 侧栏品牌行
 * - 文字常驻挂载，收起时以 max-w + opacity 与容器宽度同曲线渐隐（条件卸载会造成收起抖动）
 * - onToggle 存在时（桌面侧栏）Logo 承载开合交互：hover 时 Logo 淡出、切换为对应态的开合按钮；
 *   移动端抽屉不传 onToggle，Logo 纯展示
 */
function BrandRow({ collapsed, onToggle }: { collapsed: boolean; onToggle?: () => void }) {
  const label = collapsed ? '展开侧栏' : '收起侧栏'
  const Chevron = collapsed ? ChevronsRight : ChevronsLeft
  const logoArt = (
    <>
      <BrandLogo
        className={cn(
          'text-mcs-text-default transition-[width,height,opacity] duration-mcs-fast',
          collapsed ? 'size-6' : 'size-5',
          'group-hover/brand-btn:opacity-0',
        )}
      />
      <Chevron
        aria-hidden
        className={cn(
          'absolute size-4 text-mcs-text-default transition-opacity duration-mcs-fast',
          'opacity-0 group-hover/brand-btn:opacity-100',
        )}
      />
    </>
  )
  const logoButton = onToggle ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          className="group/brand-btn relative flex size-8 shrink-0 items-center justify-center rounded-mcs-sm transition-colors duration-mcs-fast hover:bg-mcs-state-hover focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {logoArt}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  ) : (
    <div className="relative flex size-8 shrink-0 items-center justify-center">
      <BrandLogo className={cn('text-mcs-text-default', 'size-5')} />
    </div>
  )
  return (
    <div
      className={cn(
        'flex h-12 items-center gap-2 px-3 transition-[padding] duration-mcs-base ease-mcs-snappy',
        collapsed && 'justify-center px-0',
      )}
    >
      {logoButton}
      <span
        className={cn(
          'min-w-0 truncate whitespace-nowrap text-mcs-md font-semibold',
          'transition-[max-width,opacity] duration-mcs-base ease-mcs-snappy',
          collapsed ? 'max-w-0 opacity-0' : 'max-w-36 opacity-100',
        )}
      >
        MC Commander
      </span>
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
          'relative flex h-8 items-center gap-2.5 rounded-mcs-sm px-2.5 text-mcs-sm font-medium',
          'text-mcs-text-muted transition-colors duration-mcs-fast',
          'hover:bg-mcs-state-hover active:bg-mcs-state-pressed hover:text-mcs-text-default',
          'focus-visible:outline-2',
          // 激活指示条：2px accent 左缘 inset（伪元素常驻 + opacity 过渡，避免 display 切换不可过渡）
          'before:pointer-events-none before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-mcs-accent-fg before:opacity-0 before:transition-opacity before:duration-mcs-fast',
          isActive && 'bg-mcs-accent-bg-subtle text-mcs-accent-fg before:opacity-100',
          collapsed && 'justify-center px-0',
        )
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {/* 文字常驻挂载：收起时 max-w + opacity 与容器宽度同曲线渐隐（条件卸载会抖动） */}
      <span
        className={cn(
          'min-w-0 truncate whitespace-nowrap',
          'transition-[max-width,opacity] duration-mcs-base ease-mcs-snappy',
          collapsed ? 'max-w-0 opacity-0' : 'max-w-28 opacity-100',
        )}
      >
        {label}
      </span>
    </NavLink>
  )
}
