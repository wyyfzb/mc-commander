import { useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  Ban,
  CalendarX,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  CircuitBoard,
  CloudSun,
  Cpu,
  Gauge,
  HardDrive,
  HeartPulse,
  History,
  LogIn,
  LogOut,
  MemoryStick,
  MessageSquare,
  MoonStar,
  Play,
  Rocket,
  Save,
  Settings2,
  SkipForward,
  Skull,
  Square,
  Trophy,
  Webhook,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/mcs/chip'
import { SEMANTIC_TONE_CLASSES, type SemanticTone, type ToneClasses } from '@/components/mcs/tone'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { ProgressBar } from '@/components/mcs/progress-bar'
import { useRadioGroup } from '@/hooks/use-radio-group'
import { useNotificationStore } from '@/stores/notifications'
import { useWorldUpgradeProgressStore } from '@/stores/world-upgrade-progress'
import { formatNotificationTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { instanceHueFillClass } from '@/lib/instance-hue'
import {
  NOTIFICATION_TYPE_META,
  type NotificationSeverity,
  type NotificationType,
} from '@/lib/notifications'

/**
 * NotificationDrawer —— 右侧滑出通知抽屉（设计文档 §3.2：通知面板改顶栏铃铛+滑出抽屉）
 * 对话流式气泡：game 靠左（类型色 8% 底）/ server 靠右；未读态 accent 圆点+类型色边框+加粗
 */

const TYPE_ICON: Record<NotificationType, LucideIcon> = {
  join: LogIn,
  leave: LogOut,
  death: Skull,
  revive: HeartPulse,
  achievement: Trophy,
  chat: MessageSquare,
  sleep: MoonStar,
  serverStart: Play,
  serverStop: Square,
  serverCrash: AlertTriangle,
  save: Save,
  circuitBreaker: CircuitBoard,
  lowTps: Gauge,
  highCpu: Cpu,
  highMemory: MemoryStick,
  highDisk: HardDrive,
  criticalDisk: HardDrive,
  weatherChange: CloudSun,
  backupStart: Archive,
  backupComplete: CheckCircle2,
  backupFailed: AlertCircle,
  backupSkipped: SkipForward,
  backupCancelled: Ban,
  restoreStart: History,
  restoreComplete: CheckCheck,
  restoreFailed: XCircle,
  restoreCancelled: Ban,
  taskFailed: CalendarX,
  webhookFailed: Webhook,
  deployComplete: Rocket,
  deployFailed: XCircle,
  deployCancelled: Ban,
  upgradeComplete: CheckCircle2,
  upgradeFailed: XCircle,
  upgradeCancelled: Ban,
  // 世界格式升级（服务端推送）：用 AlertTriangle 表达「期间连不上，属需要注意的过程」
  worldUpgradeStart: AlertTriangle,
  worldUpgradeComplete: CheckCircle2,
  worldUpgradeFailed: XCircle,
}

/** 中性档（进出/停服等无成败含义的事件）：次级底，不占语义六色 */
const NEUTRAL_TYPE_COLOR: ToneClasses = {
  text: 'text-mcs-text-muted',
  bg: 'bg-mcs-bg-secondary',
  border: 'border-mcs-border-default',
}

/**
 * 类型 → 语义档（色值来自 components/mcs/tone，勿在此手抄）。
 * 用档位名而非类名建表：三处着色（底/边/图标）由一处派生，改档不会漏改其中一处。
 */
export const NOTIFICATION_TONE: Record<NotificationType, SemanticTone | 'neutral'> = {
  join: 'success',
  leave: 'neutral',
  death: 'error',
  revive: 'success',
  achievement: 'purple',
  chat: 'info',
  sleep: 'info',
  serverStart: 'success',
  serverStop: 'neutral',
  serverCrash: 'error',
  circuitBreaker: 'error',
  save: 'info',
  lowTps: 'warning',
  highCpu: 'warning',
  highMemory: 'warning',
  highDisk: 'warning',
  criticalDisk: 'error',
  weatherChange: 'info',
  backupStart: 'info',
  backupComplete: 'success',
  backupFailed: 'error',
  backupSkipped: 'warning',
  backupCancelled: 'neutral',
  restoreStart: 'info',
  restoreComplete: 'success',
  restoreFailed: 'error',
  restoreCancelled: 'neutral',
  taskFailed: 'error',
  webhookFailed: 'error',
  deployComplete: 'success',
  deployFailed: 'error',
  deployCancelled: 'neutral',
  upgradeComplete: 'success',
  upgradeFailed: 'error',
  upgradeCancelled: 'neutral',
  worldUpgradeStart: 'warning',
  worldUpgradeComplete: 'success',
  worldUpgradeFailed: 'error',
}

/** 气泡图标/边框/底色（三处同档） */
function notificationColor(type: NotificationType): ToneClasses {
  const tone = NOTIFICATION_TONE[type]
  return tone === 'neutral' ? NEUTRAL_TYPE_COLOR : SEMANTIC_TONE_CLASSES[tone]
}

/** severity 筛选选项（Tasteful Friction：按严重度快速聚焦告警） */
const SEVERITY_FILTERS: Array<{
  value: 'all' | NotificationSeverity
  label: string
  tone: 'default' | 'error' | 'warning' | 'info'
}> = [
  { value: 'all', label: '全部', tone: 'default' },
  { value: 'severe', label: '严重', tone: 'error' },
  { value: 'warning', label: '警告', tone: 'warning' },
  { value: 'info', label: '提示', tone: 'info' },
]

interface NotificationDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NotificationDrawer({ open, onOpenChange }: NotificationDrawerProps) {
  const navigate = useNavigate()
  const items = useNotificationStore((s) => s.items)
  const unreadCount = useNotificationStore((s) => s.unreadCount)
  // 世界格式升级的实时进度：按实例读**瞬态** store（不进通知条目、不落盘），
  // 就地更新「升级开始」那条的进度条
  const worldUpgradeProgress = useWorldUpgradeProgressStore((s) => s.progress)
  const markAsRead = useNotificationStore((s) => s.markAsRead)
  const markAllRead = useNotificationStore((s) => s.markAllRead)
  const clearAll = useNotificationStore((s) => s.clearAll)
  const [severityFilter, setSeverityFilter] = useState<'all' | NotificationSeverity>('all')
  const severityGroup = useRadioGroup<'all' | NotificationSeverity>({
    label: '按严重度筛选',
    value: severityFilter,
    values: SEVERITY_FILTERS.map((f) => f.value),
    onChange: setSeverityFilter,
  })
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)

  // 筛选仅作用于列表展示；未读徽章/全部已读语义仍是全局（不随筛选变）
  const visibleItems =
    severityFilter === 'all'
      ? items
      : items.filter((n) => NOTIFICATION_TYPE_META[n.type].severity === severityFilter)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-96 max-w-full flex-col p-0 shadow-mcs-overlay"
      >
        <SheetHeader className="flex-row items-center justify-between border-b border-mcs-border-muted py-3 pl-4 pr-3">
          <SheetTitle className="flex items-center gap-2 text-mcs-lg">
            通知
            {unreadCount > 0 && (
              <span className="rounded-full bg-mcs-accent px-1.5 py-0.5 text-mcs-2xs font-medium text-mcs-on-accent">
                {unreadCount}
              </span>
            )}
          </SheetTitle>
          {/* 关闭按钮并入操作组统一排布（SheetContent 内置的 absolute X 会与最右按钮重叠） */}
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
              onClick={() => setConfirmClearOpen(true)}
              className="text-mcs-xs"
            >
              清除全部
            </Button>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="关闭通知">
                <X aria-hidden />
              </Button>
            </SheetClose>
          </div>
        </SheetHeader>

        {/* severity 筛选 chips（有通知时才出现，避免空态噪音；单选组：语义与方向键走 hook） */}
        {items.length > 0 && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-mcs-border-muted px-4 py-2"
            {...severityGroup.groupProps}
          >
            {SEVERITY_FILTERS.map((f, index) => (
              <Chip
                key={f.value}
                tone={f.tone}
                selected={severityFilter === f.value}
                {...severityGroup.itemProps(index)}
                onClick={() => setSeverityFilter(f.value)}
                ariaLabel={`${f.label}通知`}
              >
                {f.label}
              </Chip>
            ))}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {visibleItems.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-mcs-text-muted">
              {items.length === 0 ? '暂无动态' : '该严重度下暂无通知'}
            </div>
          ) : (
            visibleItems.map((n) => {
              const Icon = TYPE_ICON[n.type]
              const color = notificationColor(n.type)
              const isGame = n.category === 'game'
              // 只在「升级开始」那条上挂实时进度（见 stores/world-upgrade-progress）
              const upgradePercent =
                n.type === 'worldUpgradeStart' && n.instanceId
                  ? worldUpgradeProgress[n.instanceId]
                  : undefined
              // 关联实例条目可跳转（issue 334）：关闭抽屉 → 实例页 focus 深链接切换
              const jumpToInstance = () => {
                markAsRead(n.id)
                if (n.instanceId) {
                  onOpenChange(false)
                  navigate(`/instances?focus=${encodeURIComponent(n.instanceId)}`)
                }
              }
              const baseLabel = n.read
                ? n.instanceId
                  ? `${n.content}，点击查看关联实例`
                  : n.content
                : `未读：${n.content}${n.instanceId ? '，点击查看关联实例' : ''}`
              // 条目整体是 button ⇒ 子节点在无障碍树里一律 presentational，进度条与可见的
              // 百分比都读不到，故把数值拼进 aria-label。**不做 aria-live 播报**：服务端
              // 1 条/秒，逐秒播报只会变成噪音（值在聚焦时可读即可）。
              const entryLabel =
                upgradePercent === undefined
                  ? baseLabel
                  : `${baseLabel}，升级进度 ${Math.round(upgradePercent)}%`
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={jumpToInstance}
                  className={cn(
                    // 横向两列：左列只在有实例时出现（实例色相标识），右列是原有内容
                    'flex max-w-65 gap-2 rounded-mcs-sm border px-3 py-2 text-left',
                    isGame
                      ? 'self-start rounded-bl-mcs-xs'
                      : 'self-end rounded-br-mcs-xs bg-mcs-bg-secondary',
                    isGame && color.bg,
                    n.read ? 'border-mcs-border-muted' : cn('border', color.border),
                    n.instanceId &&
                      'cursor-pointer transition-colors hover:border-mcs-accent-border',
                  )}
                  aria-label={entryLabel}
                >
                  {/* 实例固定色相标识（非语义 identity）：独立左列，**不进**「查看实例」那行——
                       那行整体是 info 语义色，色点嵌在里面（同为圆点 + 2px 间距）会被读成 info 语义点 */}
                  {n.instanceId && (
                    <span className="flex shrink-0 items-start pt-0.5" aria-hidden>
                      <span
                        data-instance-hue
                        className={cn('size-2 rounded-full', instanceHueFillClass(n.instanceId))}
                      />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-center gap-1.5">
                      <Icon className={cn('size-3', color.text)} aria-hidden />
                      {!n.read && (
                        <span className="size-1.5 rounded-full bg-mcs-accent" aria-hidden />
                      )}
                      <span className={cn('text-mcs-2xs text-mcs-text-muted tnum')}>
                        {formatNotificationTime(n.timestamp)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'line-clamp-3 text-mcs-xs',
                        n.read
                          ? 'font-normal text-mcs-text-muted'
                          : 'font-medium text-mcs-text-default',
                      )}
                    >
                      {n.content}
                      {n.count > 1 && <span className="text-mcs-accent-fg"> ×{n.count}</span>}
                    </span>
                    {/* 世界格式升级的进度就地显示在这条通知上：不新增条目、不弹 toast
                        （服务端 1 条/秒），终态事件到达即随 store 清除而消失 */}
                    {upgradePercent !== undefined && (
                      <span className="flex items-center gap-2">
                        <ProgressBar percent={upgradePercent} />
                        {/* 与备份面板同语义的百分比同档（xs）：它承载的是「还要等多久」的
                            读数，不是可扫读的角标 */}
                        <span className="shrink-0 text-mcs-xs text-mcs-text-muted tnum">
                          {Math.round(upgradePercent)}%
                        </span>
                      </span>
                    )}
                    {n.instanceId && (
                      <span className="flex items-center gap-0.5 text-mcs-2xs text-mcs-info-fg">
                        查看实例
                        <ChevronRight className="size-3" aria-hidden />
                      </span>
                    )}
                  </span>
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
            className="flex w-full items-center gap-2 rounded-mcs-sm text-mcs-xs text-mcs-text-muted transition-colors hover:bg-mcs-state-hover hover:text-mcs-text-default"
          >
            <Settings2 className="size-3.5" aria-hidden />
            偏好设置
            <span className="ml-auto text-mcs-2xs text-mcs-text-muted">通知矩阵</span>
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </footer>

        {/* 清除全部：不可逆操作走 Tasteful Friction 确认（清空含未读，误触代价高） */}
        <ConfirmDialog
          open={confirmClearOpen}
          onOpenChange={setConfirmClearOpen}
          title="清除全部通知"
          description={`将移除当前全部 ${items.length} 条通知（含未读）。`}
          confirmText="清除"
          warning="此操作不可撤销"
          onConfirm={() => {
            clearAll()
            setConfirmClearOpen(false)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
