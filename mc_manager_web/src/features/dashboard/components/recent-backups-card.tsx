/**
 * RecentBackupsCard —— 仪表盘右栏「最近备份」卡片
 * - 最近 5 条备份：状态图标（tone 浅底）+ 名称 + 时间·大小 + 状态徽章
 * - 数据复用备份域 hooks：useBackups（30s 轮询）＋ useBackupEventRefresh（备份/恢复 WS 通知即时失效）
 * - 「立即备份」在有在途备份（creating/restoring）时禁用，与备份页互斥状态机同口径
 * - 入口统一指向设置页备份子路由（真实路由为 /settings/backup）
 */
import { useNavigate } from 'react-router'
import { ArrowRight, CircleAlert, CloudUpload, HardDrive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import type { BackupItem } from '@/api/types'
import { useServerStore } from '@/stores/server'
import { LoadingButton } from '@/components/mcs/loading-button'
import { StatusPill } from '@/components/mcs/status-pill'
import { Skeleton } from '@/components/ui/skeleton'
import {
  backupStatusTone,
  backupStatusLabel,
  formatBackupDate,
  formatBackupSize,
  isLegacyFormat,
} from '@/lib/mc-backup'
import { useBackups, useCreateBackup, useBackupEventRefresh } from '@/features/settings/queries'

/** 卡片展示条数上限（服务端列表已按时间倒序） */
const MAX_ITEMS = 5
/** 备份管理页（设置子路由） */
const BACKUP_PAGE = '/settings/backup'

/** 状态图标 tone 类（与 BackupPanel 的 TONE_CLASSES 同源；Tailwind 只认字面量，勿拼模板串） */
const TONE_CLASSES: Record<ReturnType<typeof backupStatusTone>, string> = {
  success: 'bg-mcs-success-bg-subtle text-mcs-success-fg border-mcs-success-border',
  error: 'bg-mcs-error-bg-subtle text-mcs-error-fg border-mcs-error-border',
  warning: 'bg-mcs-warning-bg-subtle text-mcs-warning-fg border-mcs-warning-border',
  info: 'bg-mcs-info-bg-subtle text-mcs-info-fg border-mcs-info-border',
}

export function RecentBackupsCard() {
  const instanceId = useServerStore((s) => s.instanceId)
  const navigate = useNavigate()
  const backupsQuery = useBackups(instanceId)
  const createMutation = useCreateBackup(instanceId)
  useBackupEventRefresh(instanceId)

  const backups = backupsQuery.data ?? []
  const items = backups.slice(0, MAX_ITEMS)
  /** 在途备份存在时禁止再发起（服务端互斥状态机会拒绝重复创建） */
  const hasInProgress = backups.some((b) => b.status === 'creating' || b.status === 'restoring')

  const handleCreate = async () => {
    try {
      await createMutation.mutateAsync()
      toast.success('备份任务已启动')
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    }
  }

  return (
    <section className="animate-mcs-fade-up mcs-delay-6 mcs-edge-top relative flex shrink-0 flex-col gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4 shadow-mcs-card">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-mcs-sm font-medium text-mcs-text-muted">最近备份</h3>
        <button
          type="button"
          onClick={() => navigate(BACKUP_PAGE)}
          aria-label="查看全部备份"
          className="inline-flex items-center gap-0.5 text-mcs-xs font-medium text-mcs-info-fg hover:underline"
        >
          全部
          <ArrowRight className="size-3" aria-hidden />
        </button>
      </header>

      {backupsQuery.isLoading ? (
        <div className="space-y-2" aria-label="加载备份中" role="status">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="size-6 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : backupsQuery.isError ? (
        <div className="flex flex-col items-center gap-1.5 py-4 text-center">
          <CircleAlert className="size-6 text-mcs-error-fg" aria-hidden />
          <p className="text-mcs-xs text-mcs-error-fg">
            备份记录加载失败：{getFriendlyErrorText(backupsQuery.error)}
          </p>
          <button
            type="button"
            onClick={() => void backupsQuery.refetch()}
            className="text-mcs-xs font-medium text-mcs-info-fg hover:underline"
          >
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 py-4 text-center">
          <HardDrive className="size-6 text-mcs-text-muted opacity-60" aria-hidden />
          <p className="text-mcs-xs text-mcs-text-muted">暂无备份记录</p>
          <button
            type="button"
            onClick={() => navigate(BACKUP_PAGE)}
            className="text-mcs-xs font-medium text-mcs-info-fg hover:underline"
          >
            前往备份管理
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.map((backup) => (
            <BackupMiniRow key={backup.id} backup={backup} />
          ))}
        </div>
      )}

      <div className="border-t border-mcs-border-muted pt-3">
        <LoadingButton
          variant="outline"
          size="sm"
          className="w-full"
          loading={createMutation.isPending}
          loadingText="备份中..."
          disabled={hasInProgress}
          onClick={() => void handleCreate()}
        >
          <CloudUpload className="size-3.5" aria-hidden />
          立即备份
        </LoadingButton>
      </div>
    </section>
  )
}

/** 紧凑单行：状态图标 + 名称（+ 旧格式徽章）+ 时间·大小 + 状态徽章 */
function BackupMiniRow({ backup }: { backup: BackupItem }) {
  const status = backup.status
  const tone = backupStatusTone(status)
  const isInProgress = status === 'creating' || status === 'restoring'
  const metaLine = [formatBackupDate(backup.createdAt), formatBackupSize(backup.size)]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex items-center gap-2 px-1.5 py-1.5">
      <span
        className={
          'flex size-6 shrink-0 items-center justify-center rounded-mcs-xs border ' +
          TONE_CLASSES[tone]
        }
        aria-hidden
      >
        {isInProgress ? (
          <Loader2 className="size-3 animate-spin" />
        ) : status === 'failed' ? (
          <CircleAlert className="size-3" />
        ) : (
          <HardDrive className="size-3" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="truncate text-mcs-xs font-medium text-mcs-text-default"
            title={backup.name}
          >
            {backup.name}
          </span>
          {isLegacyFormat(backup.format) && (
            <StatusPill tone="warning" className="text-mcs-2xs">
              旧格式
            </StatusPill>
          )}
        </div>
        <p className="truncate text-mcs-2xs text-mcs-text-muted" title={metaLine}>
          {metaLine || '—'}
        </p>
      </div>

      <StatusPill tone={tone} className="text-mcs-2xs">
        {backupStatusLabel(status)}
      </StatusPill>
    </div>
  )
}
