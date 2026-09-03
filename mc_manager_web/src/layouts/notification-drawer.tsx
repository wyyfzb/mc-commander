import {
  AlertCircle,
  AlertTriangle,
  Archive,
  CalendarX,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  CircuitBoard,
  CloudSun,
  Cpu,
  Gauge,
  HeartPulse,
  History,
  LogIn,
  LogOut,
  MemoryStick,
  MessageSquare,
  MoonStar,
  Play,
  Save,
  Settings2,
  SkipForward,
  Skull,
  Square,
  Trophy,
  Webhook,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { useNotificationStore } from '@/stores/notifications'
import { formatNotificationTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { NotificationType } from '@/lib/notifications'

/**
 * NotificationDrawer —— 右侧滑出通知抽屉（设计文档 §3.2：通知面板改顶栏铃铛+滑出抽屉）
 * 对话流式气泡：game 靠左（类型色 8% 底）/ server 靠右；未读态 accent 圆点+类型色边框+加粗
 */

const TYPE_ICON: Record<NotificationType, LucideIcon> = {
  join: LogIn, leave: LogOut, death: Skull, revive: HeartPulse,
  achievement: Trophy, chat: MessageSquare, sleep: MoonStar,
  serverStart: Play, serverStop: Square, serverCrash: AlertTriangle, save: Save,
  circuitBreaker: CircuitBoard,
  lowTps: Gauge, highCpu: Cpu, highMemory: MemoryStick, weatherChange: CloudSun,
  backupStart: Archive, backupComplete: CheckCircle2, backupFailed: AlertCircle,
  backupSkipped: SkipForward, restoreStart: History, restoreComplete: CheckCheck,
  restoreFailed: XCircle, taskFailed: CalendarX, webhookFailed: Webhook,
}

/** 类型 → 语义色 token 工具类（气泡图标/边框用） */
const TYPE_COLOR: Record<NotificationType, { text: string; bg: string; border: string }> = {
  join: { text: 'text-mcs-success-fg', bg: 'bg-mcs-success-bg-subtle', border: 'border-mcs-success-border' },
  leave: { text: 'text-mcs-text-muted', bg: 'bg-mcs-bg-hover', border: 'border-mcs-border-default' },
  death: { text: 'text-mcs-error-fg', bg: 'bg-mcs-error-bg-subtle', border: 'border-mcs-error-border' },
  revive: { text: 'text-mcs-success-fg', bg: 'bg-mcs-success-bg-subtle', border: 'border-mcs-success-border' },
  achievement: { text: 'text-mcs-purple-fg', bg: 'bg-mcs-purple-bg-subtle', border: 'border-mcs-purple-border' },
  chat: { text: 'text-mcs-info-fg', bg: 'bg-mcs-info-bg-subtle', border: 'border-mcs-info-border' },
  sleep: { text: 'text-mcs-info-fg', bg: 'bg-mcs-info-bg-subtle', border: 'border-mcs-info-border' },
  serverStart: { text: 'text-mcs-success-fg', bg: 'bg-mcs-success-bg-subtle', border: 'border-mcs-success-border' },
  serverStop: { text: 'text-mcs-text-muted', bg: 'bg-mcs-bg-hover', border: 'border-mcs-border-default' },
  serverCrash: { text: 'text-mcs-error-fg', bg: 'bg-mcs-error-bg-subtle', border: 'border-mcs-error-border' },
  circuitBreaker: { text: 'text-mcs-error-fg', bg: 'bg-mcs-error-bg-subtle', border: 'border-mcs-error-border' },
  save: { text: 'text-mcs-info-fg', bg: 'bg-mcs-info-bg-subtle', border: 'border-mcs-info-border' },
  lowTps: { text: 'text-mcs-warning-fg', bg: 'bg-mcs-warning-bg-subtle', border: 'border-mcs-warning-border' },
  highCpu: { text: 'text-mcs-warning-fg', bg: 'bg-mcs-warning-bg-subtle', border: 'border-mcs-warning-border' },
  highMemory: { text: 'text-mcs-warning-fg', bg: 'bg-mcs-warning-bg-subtle', border: 'border-mcs-warning-border' },
  weatherChange: { text: 'text-mcs-info-fg', bg: 'bg-mcs-info-bg-subtle', border: 'border-mcs-info-border' },
  backupStart: { text: 'text-mcs-info-fg', bg: 'bg-mcs-info-bg-subtle', border: 'border-mcs-info-border' },
  backupComplete: { text: 'text-mcs-success-fg', bg: 'bg-mcs-success-bg-subtle', border: 'border-mcs-success-border' },
  backupFailed: { text: 'text-mcs-error-fg', bg: 'bg-mcs-error-bg-subtle', border: 'border-mcs-error-border' },
  backupSkipped: { text: 'text-mcs-warning-fg', bg: 'bg-mcs-warning-bg-subtle', border: 'border-mcs-warning-border' },
  restoreStart: { text: 'text-mcs-info-fg', bg: 'bg-mcs-info-bg-subtle', border: 'border-mcs-info-border' },
  restoreComplete: { text: 'text-mcs-success-fg', bg: 'bg-mcs-success-bg-subtle', border: 'border-mcs-success-border' },
  restoreFailed: { text: 'text-mcs-error-fg', bg: 'bg-mcs-error-bg-subtle', border: 'border-mcs-error-border' },
  taskFailed: { text: 'text-mcs-error-fg', bg: 'bg-mcs-error-bg-subtle', border: 'border-mcs-error-border' },
  webhookFailed: { text: 'text-mcs-error-fg', bg: 'bg-mcs-error-bg-subtle', border: 'border-mcs-error-border' },
}

interface NotificationDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NotificationDrawer({ open, onOpenChange }: NotificationDrawerProps) {
  const navigate = useNavigate()
  const items = useNotificationStore((s) => s.items)
  const unreadCount = useNotificationStore((s) => s.unreadCount)
  const markAsRead = useNotificationStore((s) => s.markAsRead)
  const markAllRead = useNotificationStore((s) => s.markAllRead)
  const clearAll = useNotificationStore((s) => s.clearAll)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="glass-overlay flex w-96 max-w-full flex-col p-0">
        <SheetHeader className="flex-row items-center justify-between border-b border-mcs-border-muted px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-mcs-md">
            通知
            {unreadCount > 0 && (
              <span className="rounded-full bg-mcs-accent px-1.5 py-0.5 text-mcs-2xs font-medium text-mcs-on-accent">
                {unreadCount}
              </span>
            )}
          </SheetTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={unreadCount === 0}
              onClick={markAllRead}
              className="text-mcs-xs"
            >
              <CheckCheck aria-hidden /> 全部已读
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={items.length === 0}
              onClick={clearAll}
              className="text-mcs-xs"
            >
              清除全部
            </Button>
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-mcs-text-subtle">
              暂无动态
            </div>
          ) : (
            items.map((n) => {
              const Icon = TYPE_ICON[n.type]
              const color = TYPE_COLOR[n.type]
              const isGame = n.category === 'game'
              // 关联实例条目可跳转（issue 334）：关闭抽屉 → 实例页 focus 深链接切换
              const jumpToInstance = () => {
                markAsRead(n.id)
                if (n.instanceId) {
                  onOpenChange(false)
                  navigate(`/instances?focus=${encodeURIComponent(n.instanceId)}`)
                }
              }
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={jumpToInstance}
                  className={cn(
                    'flex max-w-[260px] flex-col gap-1 rounded-mcs-sm border px-3 py-2 text-left',
                    isGame
                      ? 'self-start rounded-bl-mcs-xs'
                      : 'self-end rounded-br-mcs-xs bg-mcs-bg-hover',
                    isGame && color.bg,
                    n.read
                      ? 'border-mcs-border-muted'
                      : cn('border', color.border),
                    n.instanceId && 'cursor-pointer transition-colors hover:border-mcs-accent-border',
                  )}
                  aria-label={
                    n.read
                      ? (n.instanceId ? `${n.content}，点击查看关联实例` : n.content)
                      : `未读：${n.content}${n.instanceId ? '，点击查看关联实例' : ''}`
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <Icon className={cn('size-3', color.text)} aria-hidden />
                    {!n.read && (
                      <span className="size-1.5 rounded-full bg-mcs-accent" aria-hidden />
                    )}
                    <span className={cn('text-mcs-2xs text-mcs-text-subtle tnum')}>
                      {formatNotificationTime(n.timestamp)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'line-clamp-3 text-mcs-xs',
                      n.read ? 'font-normal text-mcs-text-muted' : 'font-medium text-mcs-text-default',
                    )}
                  >
                    {n.content}
                    {n.count > 1 && <span className="text-mcs-accent-fg"> ×{n.count}</span>}
                  </span>
                  {n.instanceId && (
                    <span className="flex items-center gap-0.5 text-mcs-2xs text-mcs-info-fg">
                      查看实例
                      <ChevronRight className="size-3" aria-hidden />
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* 底部：偏好设置入口 */}
        <footer className="shrink-0 border-t border-mcs-border-muted px-4 py-3">
          <button
            type="button"
            onClick={() => {
              onOpenChange(false)
              navigate('/settings/notifications')
            }}
            className="flex w-full items-center gap-2 rounded-mcs-sm text-mcs-xs text-mcs-text-muted transition-colors hover:bg-mcs-bg-hover hover:text-mcs-text-default"
          >
            <Settings2 className="size-3.5" aria-hidden />
            偏好设置
            <span className="ml-auto text-mcs-2xs text-mcs-text-subtle">通知矩阵</span>
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </footer>
      </SheetContent>
    </Sheet>
  )
}
