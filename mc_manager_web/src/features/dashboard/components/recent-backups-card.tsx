/**
 * RecentBackupsCard —— 仪表盘右栏「最近备份」卡片
 * - 最近 3 条备份：状态图标（tone 浅底）+ 名称 + 时间·大小 + 状态徽章
 * - 数据复用备份域 hooks：useBackups（30s 轮询）＋ useBackupEventRefresh（备份/恢复 WS 通知即时失效）
 * - 「立即备份」在有在途备份（creating/restoring）时禁用，与备份页互斥状态机同口径
 * - 入口统一指向设置页备份子路由（真实路由为 /settings/backup）
 */
import { useNavigate } from 'react-router'
import { ArrowRight, CircleAlert, CloudUpload, HardDrive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { queryPhase } from '@/lib/query-phase'
import { StaleQueryNotice } from '@/components/mcs/data-states'
import type { BackupItem } from '@/api/types'
import { cn } from '@/lib/utils'
import { useServerStore } from '@/stores/server'
import { LoadingButton } from '@/components/mcs/loading-button'
import { StatusPill } from '@/components/mcs/status-pill'
import { Card, CardHeader, CardTitle } from '@/components/mcs/card'
import { toneClasses } from '@/components/mcs/tone'
import { Skeleton } from '@/components/ui/skeleton'
import {
  backupStatusTone,
  backupStatusLabel,
  formatBackupDate,
  formatBackupSize,
} from '@/lib/mc-backup'
import { useBackups, useCreateBackup, useBackupEventRefresh } from '@/features/settings/queries'

/**
 * 卡片展示条数上限（服务端列表已按时间倒序）。
 * 取 3 而非 5：右栏是可滚动窄列，条数越多越把下方的公告发送卡推离首屏；
 * 完整列表在备份页（最近 10 条 + 展开），卡上「全部」一步可达
 */
const MAX_ITEMS = 3
/** 备份管理页（设置子路由） */
const BACKUP_PAGE = '/settings/backup'

export function RecentBackupsCard() {
  const instanceId = useServerStore((s) => s.instanceId)
  const navigate = useNavigate()
  const backupsQuery = useBackups(instanceId)
  /** 卡片相位：有旧值可留时不把一次轮询抖动呈现成整块故障（卡内空间小，取紧凑下间距） */
  const backupsPhase = queryPhase(backupsQuery)
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
    <Card className="animate-mcs-fade-up mcs-delay-6 mcs-edge-top relative flex shrink-0 flex-col gap-3 p-4">
      <CardHeader className="justify-between gap-2">
        <CardTitle>最近备份</CardTitle>
        <button
          type="button"
          onClick={() => navigate(BACKUP_PAGE)}
          aria-label="查看全部备份"
          className="inline-flex items-center gap-0.5 text-mcs-xs font-medium text-mcs-info-fg hover:underline"
        >
          全部
          <ArrowRight className="size-3" aria-hidden />
        </button>
      </CardHeader>

      {backupsPhase === 'stale' && (
        <StaleQueryNotice
          className="mb-2"
          error={backupsQuery.error}
          onRetry={() => void backupsQuery.refetch()}
        />
      )}
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
      ) : backupsPhase === 'failed' ? (
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
          // 禁用原因外显：无提示会让服主以为按钮坏了（与备份页同口径）
          title={hasInProgress ? '已有备份或恢复在进行中，请稍候' : undefined}
          onClick={() => void handleCreate()}
        >
          <CloudUpload className="size-3.5" aria-hidden />
          立即备份
        </LoadingButton>
      </div>
    </Card>
  )
}

/** 紧凑单行：状态图标 + 名称 + 时间·大小 + 状态徽章 */
function BackupMiniRow({ backup }: { backup: BackupItem }) {
  const status = backup.status
  const tone = backupStatusTone(status)
  const isInProgress = status === 'creating' || status === 'restoring'
  const metaLine = [formatBackupDate(backup.createdAt), formatBackupSize(backup.size)]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex items-center gap-2 py-1.5">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-mcs-xs',
          toneClasses(tone),
        )}
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
