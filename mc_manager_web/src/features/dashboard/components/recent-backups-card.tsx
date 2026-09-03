/**
 * RecentBackupsCard —— 仪表盘右栏「最近备份」卡片
 * - 展示最近 5 条备份记录（名称 + 状态 + 时间）
 * - 立即备份按钮 + 跳转备份设置页链接
 * - 复用 useBackups / useCreateBackup / useBackupEventRefresh（30s 轮询 + WS 事件驱动）
 * - 实底卡片风格，与 stat-cards.tsx Card 组件一致
 */
import { useNavigate } from 'react-router'
import { ArrowRight, CircleAlert, CloudUpload, HardDrive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
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

const MAX_ITEMS = 5

export function RecentBackupsCard() {
  const instanceId = useServerStore((s) => s.instanceId)
  const navigate = useNavigate()
  const backupsQuery = useBackups(instanceId)
  const createMutation = useCreateBackup(instanceId)
  useBackupEventRefresh(instanceId)

  const backups = backupsQuery.data ?? []
  /** 最近 N 条（服务端列表已按时间倒序） */
  const items = backups.slice(0, MAX_ITEMS)
  /** 是否有备份进行中（creating/restoring） */
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
    <section className="flex min-w-0 flex-col gap-3 rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted p-4">
      {/* 标题行 */}
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-mcs-sm font-medium text-mcs-text-muted">最近备份</h2>
        <button
          type="button"
          onClick={() => navigate('/settings/backups')}
          aria-label="查看全部备份"
          className="inline-flex items-center gap-0.5 text-mcs-xs font-medium text-mcs-info-fg hover:underline"
        >
          全部
          <ArrowRight className="size-3" aria-hidden />
        </button>
      </header>

      {/* 列表 / 骨架 / 空态 */}
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
          <p className="text-mcs-xs text-mcs-error-fg">备份记录加载失败：{getFriendlyErrorText(backupsQuery.error)}</p>
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
          <HardDrive className="size-6 opacity-60 text-mcs-text-subtle" aria-hidden />
          <p className="text-mcs-xs text-mcs-text-subtle">暂无备份记录</p>
          <button
            type="button"
            onClick={() => navigate('/settings/backups')}
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

      {/* 底部：立即备份按钮 */}
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

/** 紧凑单行：状态图标 + 名称 + 时间·大小 + 状态徽章 */
function BackupMiniRow({ backup }: { backup: import('@/api/types').BackupItem }) {
  const status = backup.status
  const tone = backupStatusTone(status)
  const isInProgress = status === 'creating' || status === 'restoring'
  const isLegacy = isLegacyFormat(backup.format)
  const metaLine = [formatBackupDate(backup.createdAt), formatBackupSize(backup.size)]
    .filter(Boolean)
    .join(' · ')

  /** 状态图标 tone 类（与 BackupPanel TONE_CLASSES 一致） */
  const toneIconClass =
    tone === 'success'
      ? 'bg-mcs-success-bg-subtle text-mcs-success-fg'
      : tone === 'error'
        ? 'bg-mcs-error-bg-subtle text-mcs-error-fg'
        : tone === 'warning'
          ? 'bg-mcs-warning-bg-subtle text-mcs-warning-fg'
          : 'bg-mcs-info-bg-subtle text-mcs-info-fg'

  return (
    <div className="flex items-center gap-2 rounded-mcs-xs px-1.5 py-1.5 hover:bg-mcs-state-hover">
      {/* status icon */}
      <span
        className={
          'flex size-6 shrink-0 items-center justify-center rounded-mcs-xs ' + toneIconClass
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
          <span className="truncate text-mcs-xs font-medium text-mcs-text-default" title={backup.name}>
            {backup.name}
          </span>
          {isLegacy && (
            <StatusPill tone="warning" className="shrink-0 text-mcs-2xs">
              旧格式
            </StatusPill>
          )}
        </div>
        <p className="truncate text-mcs-2xs text-mcs-text-subtle" title={metaLine}>
          {metaLine || '—'}
        </p>
      </div>

      {/* status pill */}
      <StatusPill tone={tone} className="shrink-0 text-mcs-2xs">
        {backupStatusLabel(status)}
      </StatusPill>
    </div>
  )
}
