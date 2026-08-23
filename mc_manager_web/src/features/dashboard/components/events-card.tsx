import { ArrowRight } from 'lucide-react'
import { formatNotificationTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useNotificationStore } from '@/stores/notifications'
import { useUiStore } from '@/stores/ui'

/**
 * 事件与待办卡
 * - 未读角标 + 最新 4 条事件；点事件/「全部 →」开通知抽屉（与顶栏铃铛共享状态）
 */

const MAX_ITEMS = 4

export function EventsCard() {
  const items = useNotificationStore((s) => s.items)
  const unread = useNotificationStore((s) => s.unreadCount)
  const markAsRead = useNotificationStore((s) => s.markAsRead)
  const setNotificationsOpen = useUiStore((s) => s.setNotificationsOpen)

  const latest = items.slice(0, MAX_ITEMS)
  const openDrawer = () => setNotificationsOpen(true)

  return (
    <section className="flex shrink-0 flex-col rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4">
      <header className="mb-1.5 flex items-center gap-2">
        <h3 className="text-mcs-sm font-medium text-mcs-text-muted">事件与待办</h3>
        {unread > 0 && (
          <span className="rounded-mcs-xs bg-mcs-accent-bg-subtle px-1.5 py-0.5 text-mcs-2xs font-medium text-mcs-accent-fg">
            {unread} 未读
          </span>
        )}
        <button
          type="button"
          onClick={openDrawer}
          aria-label="全部动态"
          className="ml-auto inline-flex items-center gap-0.5 text-mcs-xs font-medium text-mcs-info-fg hover:text-mcs-info-fg hover:underline"
        >
          全部
          <ArrowRight className="size-3" aria-hidden />
        </button>
      </header>

      {latest.length === 0 ? (
        <p className="py-2 text-mcs-xs text-mcs-text-subtle">暂无动态</p>
      ) : (
        <ol className="flex flex-col">
          {latest.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => {
                  markAsRead(n.id)
                  openDrawer()
                }}
                className="group flex w-full items-center gap-2 rounded-mcs-xs px-1.5 py-1 text-left hover:bg-mcs-state-hover"
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    n.read ? 'bg-mcs-text-subtle' : 'bg-mcs-accent',
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-mcs-xs text-mcs-text-muted group-hover:text-mcs-text-default">
                  {n.content}
                </span>
                <time className="shrink-0 font-mono text-mcs-2xs text-mcs-text-subtle">
                  {formatNotificationTime(n.timestamp)}
                </time>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
