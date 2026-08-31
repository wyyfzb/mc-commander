/**
 * NotificationsPanel —— 通知设置子页（站内单渠道）
 * - 分组表格：事件 | 严重度 | 站内 toast（单渠道，无 Telegram/Webhook）
 * - 顶部描述 + 右上「修改即时保存」实时保存提示（无保存按钮，改动即落盘 localStorage）
 * - 每组：组头行（folder 图标 + 组名 + 组级批量 Switch，仅组内全部开启才 checked，
 *   切换调 setCategoryEnabled）+ 组内行（事件 label + 严重度 chip + 单类型 Switch）
 * - 状态唯一来源 notification-preferences store（未配置项默认开）
 */
import { CheckCircle2, Folder } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { StatusPill } from '@/components/mcs/status-pill'
import {
  NOTIFICATION_TYPE_META,
  NOTIFICATION_TYPE_ORDER,
  type NotificationCategory,
  type NotificationSeverity,
  type NotificationType,
} from '@/lib/notifications'
import { isToastEnabledRaw, useNotificationPreferenceStore } from '@/stores/notification-preferences'

/** 设置页分组顺序（类型体系无 management 组，仅渲染 game/server） */
const CATEGORY_SECTIONS: ReadonlyArray<{ category: NotificationCategory; title: string }> = [
  { category: 'game', title: '游戏通知' },
  { category: 'server', title: '服务器通知' },
]

const SEVERITY_META: Record<NotificationSeverity, { label: string; tone: 'error' | 'warning' | 'info' }> = {
  severe: { label: '严重', tone: 'error' },
  warning: { label: '警告', tone: 'warning' },
  info: { label: '提示', tone: 'info' },
}

export function NotificationsPanel() {
  const prefs = useNotificationPreferenceStore((s) => s.prefs)
  const setEnabled = useNotificationPreferenceStore((s) => s.setEnabled)
  const setCategoryEnabled = useNotificationPreferenceStore((s) => s.setCategoryEnabled)

  const isEnabled = (type: NotificationType) => isToastEnabledRaw(prefs, type)

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部描述 + 右上实时保存提示 */}
      <div className="flex items-center justify-between gap-4">
        <p className="min-w-0 text-mcs-sm text-mcs-text-subtle">设置各类通知的站内推送（严重度仅作展示分级）。</p>
        <div className="flex shrink-0 items-center gap-1.5">
          <CheckCircle2 className="size-3.5 text-mcs-success-fg" aria-hidden />
          <span className="text-mcs-sm text-mcs-text-muted">修改即时保存</span>
        </div>
      </div>

      {CATEGORY_SECTIONS.map(({ category, title }) => {
        const types = NOTIFICATION_TYPE_ORDER.filter(
          (t) => NOTIFICATION_TYPE_META[t].category === category,
        )
        if (types.length === 0) return null
        // 组级开关 checked 语义：至少一项开启即显示开——半开态显示关会误导用户
        // （配置可预期）；点击 = 全开/全关批量切换；title 提示组内部分关闭状态
        const anyOn = types.some((t) => isEnabled(t))
        const allOn = types.every((t) => isEnabled(t))
        return (
          <section
            key={category}
            data-testid={`notification-group-${category}`}
            className="overflow-hidden rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-muted"
          >
            {/* 组头行：folder 图标 + 组名 + 组级批量开关 */}
            <div className="flex items-center gap-2 border-b border-mcs-border-muted px-4 py-3">
              <Folder className="size-4 shrink-0 text-mcs-accent-fg" aria-hidden />
              <h3 className="min-w-0 flex-1 text-mcs-md font-semibold text-mcs-text-default">{title}</h3>
              <Switch
                checked={anyOn}
                onCheckedChange={(checked) => setCategoryEnabled(category, checked)}
                aria-label={`${title} 开关`}
                title={anyOn && !allOn ? '组内部分类型已关闭，点击将全部开启' : undefined}
              />
            </div>
            {/* 表格：事件 | 严重度 | 站内 */}
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 px-4 pb-1 pt-2.5">
              <span className="text-mcs-2xs font-semibold tracking-wide text-mcs-text-subtle">事件</span>
              <span className="w-12 text-mcs-2xs font-semibold tracking-wide text-mcs-text-subtle">严重度</span>
              <span className="w-10 text-mcs-2xs font-semibold tracking-wide text-mcs-text-subtle">站内</span>
            </div>
            <div className="flex flex-col">
              {types.map((type) => {
                const meta = NOTIFICATION_TYPE_META[type]
                const sev = SEVERITY_META[meta.severity]
                return (
                  <div
                    key={type}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 border-b border-mcs-border-muted px-4 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-mcs-sm text-mcs-text-default">{meta.label}</span>
                    <StatusPill tone={sev.tone} className="w-12 justify-center px-0 text-mcs-2xs">
                      {sev.label}
                    </StatusPill>
                    <Switch
                      checked={isEnabled(type)}
                      onCheckedChange={(checked) => setEnabled(type, checked)}
                      aria-label={`${meta.label} 开关`}
                    />
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
