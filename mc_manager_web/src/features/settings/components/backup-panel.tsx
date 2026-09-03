/**
 * BackupPanel —— 备份管理子页
 * - 卡片结构：标题「备份管理」→ 上次备份信息行（最近一条 completed）+「立即备份」
 *   → 快照机制说明（subtle 小字）→ 备份列表（最近 10 条）
 * - 行：状态图标（tone 浅底；进行中转圈）→ 名称 + 旧格式(zip)徽章 → 时间·大小 → 状态徽章
 *   （backupStatusTone+backupStatusLabel）→ 下载/恢复/删除
 * - 下载仅 completed 且非 zip（服务端 GET /backups/:id/download 同约束），blob → a[download]
 *   触发浏览器保存；下载中按钮转圈禁用，失败 toast
 * - 恢复仅 completed 且非 zip（旧 zip 仅可删除，服务端 40904 拒绝）；任一行 restoring 或
 *   恢复请求在途 → 全列表恢复按钮禁用；creating/restoring 行
 *   不可删除（服务端互斥状态机拒绝）
 * - 30s 轮询（useBackups 自带）+ useBackupEventRefresh 事件驱动刷新；确认框 ConfirmDialog（danger）
 * - 实底卡片（风格 A：列表/表单实底，禁玻璃）；tone 类 bg-mcs-{tone}-bg-subtle + text-mcs-{tone}-fg
 *   + border-mcs-{tone}-border（token 唯一来源 src/styles/）
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CloudUpload,
  Download,
  HardDrive,
  Loader2,
  RotateCcw,
  ServerOff,
  Trash2,
} from 'lucide-react'
import { LoadingButton } from '@/components/mcs/loading-button'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { apiDownloadBackup } from '@/api/backups'
import type { BackupItem } from '@/api/types'
import { useConnectionStore } from '@/stores/connection'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { cn } from '@/lib/utils'
import { StatusPill } from '@/components/mcs/status-pill'
import {
  backupStatusLabel,
  backupStatusTone,
  formatBackupDate,
  formatBackupSize,
  isLegacyFormat,
} from '@/lib/mc-backup'
import { useBackupEventRefresh, useBackups, useCreateBackup, useDeleteBackup, useRestoreBackup } from '../queries'
import { useInstances } from '@/api/queries'
import type { BackupPanelProps } from './contracts'
import { EmptyState } from '@/components/mcs/empty-state'

/**
 * 下载文件名：快照名 + 创建时间戳（紧凑 yyyyMMdd-HHmm，随本地时区）+ .tar.gz。
 * 服务端响应为 tar.gz 流且前端 blob 模式拿不到 Content-Disposition，
 * 由前端生成确定性文件名（时间戳来自 createdAt，满足「文件名含备份时间戳」）。
 * export 供测试断言（时区中立）。
 */
export function buildBackupDownloadName(backup: Pick<BackupItem, 'name' | 'createdAt'>): string {
  const d = new Date(backup.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = Number.isNaN(d.getTime())
    ? ''
    : `_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${backup.name}${stamp}.tar.gz`
}

/** tone → 徽章类（完整字面量类名，Tailwind 主题色静态生成；全 token 引用） */
const TONE_CLASSES: Record<ReturnType<typeof backupStatusTone>, string> = {
  success: 'bg-mcs-success-bg-subtle text-mcs-success-fg border-mcs-success-border',
  error: 'bg-mcs-error-bg-subtle text-mcs-error-fg border-mcs-error-border',
  warning: 'bg-mcs-warning-bg-subtle text-mcs-warning-fg border-mcs-warning-border',
  info: 'bg-mcs-info-bg-subtle text-mcs-info-fg border-mcs-info-border',
}

export function BackupPanel({ instanceId }: BackupPanelProps) {
  const navigate = useNavigate()
  /** 待确认的恢复/删除目标（null = 对话框关闭） */
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BackupItem | null>(null)
  /** 恢复危险确认：实例名输入（不匹配禁用确认） */
  const [restoreInput, setRestoreInput] = useState('')
  /** 是否展开全部备份（默认只显示最近 10 条，超出时提供展开入口） */
  const [showAll, setShowAll] = useState(false)

  const backupsQuery = useBackups(instanceId)
  const createMutation = useCreateBackup(instanceId)
  const restoreMutation = useRestoreBackup(instanceId)
  const deleteMutation = useDeleteBackup(instanceId)
  useBackupEventRefresh(instanceId)
  // 实例名（恢复危险确认输入匹配；无实例时按钮路径已拦截）
  const instancesQuery = useInstances()
  const instanceName = instancesQuery.data?.find((i) => i.id === instanceId)?.name ?? ''
  const restoreInputMatches = restoreInput.trim() === instanceName

  // 无实例空态（与定时任务页同文案）
  if (!instanceId) {
    return (
      <EmptyState
        icon={ServerOff}
        title="暂无服务器实例"
        hint="请先在服务端创建 MC 服务器实例"
        action={{ label: '前往实例管理', onClick: () => navigate('/instances') }}
      />
    )
  }

  const backups = backupsQuery.data ?? []
  /** 默认展示最近 10 条，用户可展开全部（避免列表无限增长） */
  const isTruncated = backups.length > 10
  const items = showAll ? backups : backups.slice(0, 10)
  /** 最近一条 completed 备份（上次备份信息行数据源；服务端列表已按时间倒序） */
  const lastCompleted = backups.find((b) => b.status === 'completed')
  /** 恢复中：任一行 restoring 或恢复请求在途 → 全列表恢复按钮禁用（检查全量，防止截断后遗漏） */
  const restoringLocked = restoreMutation.isPending || backups.some((b) => b.status === 'restoring')

  const lastBackupText = lastCompleted
    ? `上次备份：${[formatBackupDate(lastCompleted.createdAt), formatBackupSize(lastCompleted.size)]
        .filter(Boolean)
        .join(' · ')}`
    : '尚未创建备份'

  const handleCreate = async () => {
    try {
      await createMutation.mutateAsync()
      toast.success('备份任务已启动')
    } catch (e) {
      toast.error(`操作失败：${getFriendlyErrorText(e)}`)
    }
  }

  const handleRestoreConfirm = async () => {
    if (!restoreTarget) return
    const target = restoreTarget
    setRestoreTarget(null)
    setRestoreInput('')
    try {
      await restoreMutation.mutateAsync(target.id)
      toast.success('恢复已开始，完成后请启动服务器生效')
    } catch (e) {
      toast.error(`恢复失败：${getFriendlyErrorText(e)}`)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    setDeleteTarget(null)
    try {
      await deleteMutation.mutateAsync(target.id)
      toast.success('备份已删除')
    } catch (e) {
      toast.error(`删除失败：${getFriendlyErrorText(e)}`)
    }
  }

  return (
    <div className="overflow-hidden rounded-mcs-md border border-mcs-border-muted bg-mcs-bg-muted">
      {/* 标题：图标 + 备份管理 */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-success-bg-subtle text-mcs-success-fg"
          aria-hidden
        >
          <HardDrive className="size-3.5" />
        </span>
        <h3 className="text-mcs-sm font-semibold text-mcs-text-default">备份管理</h3>
      </div>

      {/* 上次备份信息行 + 立即备份（在途禁用 + 备份中...） */}
      <div className="flex items-center gap-3 border-t border-mcs-border-subtle px-4 py-3">
        <p className="min-w-0 flex-1 truncate text-mcs-sm text-mcs-text-muted" title={lastBackupText}>
          {lastBackupText}
        </p>
        <LoadingButton
          variant="outline"
          size="sm"
          loading={createMutation.isPending}
          loadingText="备份中..."
          onClick={() => void handleCreate()}
        >
          <CloudUpload className="size-3.5" aria-hidden />
          立即备份
        </LoadingButton>
      </div>

      {/* 快照机制说明（subtle 小字；保留策略服务端可配且 API 未暴露，不硬编码数值——避免与服务端实际配置漂移） */}
      <p className="px-4 text-mcs-xs text-mcs-text-subtle">
        快照备份：未修改文件零拷贝增量传输，超出保留策略自动清理（默认保留策略见服务端配置）
      </p>

      {/* 列表 / 空态 / 骨架 */}
      <div className="mt-2 border-t border-mcs-border-subtle">
        {backupsQuery.isLoading ? (
          <div data-testid="backup-skeletons" aria-label="加载备份中" className="space-y-1 p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className="size-9 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : backupsQuery.isError ? (
          /* 错误态：明确报错 + 重试（避免错误被空态分支伪装成「点击立即备份」引导） */
          <EmptyState
            icon={CircleAlert}
            title="加载失败"
            hint={`无法获取备份列表：${getFriendlyErrorText(backupsQuery.error)}`}
            action={{ label: '重试', onClick: () => void backupsQuery.refetch() }}
          />
        ) : items.length === 0 ? (
          /* 空态：引导立即备份或配置定时备份（后者跳 /tasks） */
          <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center text-mcs-text-muted">
            <HardDrive className="size-8 opacity-60" aria-hidden />
            <p className="mt-1 text-mcs-sm">点击“立即备份”或配置定时备份任务</p>
            <Button variant="link" size="sm" className="mt-1" onClick={() => navigate('/tasks')}>
              <CalendarClock className="size-3.5" aria-hidden />
              配置定时备份
            </Button>
          </div>
        ) : (
          <>
            <div className="divide-y divide-mcs-border-subtle">
              {items.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  restoringLocked={restoringLocked}
                  onRestore={setRestoreTarget}
                  onDelete={setDeleteTarget}
                />
              ))}
            </div>
            {/* 底栏：总数统计（始终显示）+ 展开/收起按钮（仅超出时显示） */}
            <div className="flex items-center justify-between border-t border-mcs-border-subtle px-4 py-2.5">
              <span className="text-mcs-xs text-mcs-text-muted">
                共 {backups.length} 条备份
                {isTruncated && !showAll && `，已显示 ${items.length} 条`}
              </span>
              {isTruncated && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-mcs-accent-fg"
                  onClick={() => setShowAll((prev) => !prev)}
                >
                  {showAll ? (
                    <>
                      <ChevronUp className="size-3.5" aria-hidden />
                      收起
                    </>
                  ) : (
                    <>
                      <ChevronDown className="size-3.5" aria-hidden />
                      显示全部
                    </>
                  )}
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      {/* 恢复确认：红色警示 + 影响说明 + 信息块（快照名/时间/覆盖范围）+ 输入实例名确认（不匹配禁用） */}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRestoreTarget(null)
            setRestoreInput('')
          }
        }}
        title="恢复备份（危险操作）"
        description={`将用备份 “${restoreTarget?.name ?? ''}” 覆盖当前世界数据，且不可撤销。当前世界自该备份后的所有变化将永久丢失，在线玩家会被断开。`}
        confirmText="确认恢复"
        cancelText="取消"
        danger
        warning="流程：停止 → 校验 level.dat → 原子替换 → 重启"
        loading={restoreMutation.isPending}
        confirmDisabled={!restoreInputMatches}
        onConfirm={() => void handleRestoreConfirm()}
      >
        {/* 目标快照信息块：名称/时间/覆盖范围（恢复为目录快照复制，非命令下发，故无命令预览） */}
        <div className="flex flex-col gap-1 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-2.5 py-2 text-mcs-xs text-mcs-text-muted">
          <div className="flex items-center gap-1.5">
            <HardDrive className="size-3 shrink-0 text-mcs-accent-fg" aria-hidden />
            <span className="truncate font-mono text-mcs-text-default" title={restoreTarget?.name ?? ''}>
              {restoreTarget?.name ?? ''}
            </span>
          </div>
          {restoreTarget && (
            <div className="flex items-center gap-1.5">
              <CalendarClock className="size-3 shrink-0 text-mcs-text-subtle" aria-hidden />
              <span>
                快照时间：{[formatBackupDate(restoreTarget.createdAt), formatBackupSize(restoreTarget.size)].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <ServerOff className="size-3 shrink-0 text-mcs-error-fg" aria-hidden />
            <span>覆盖范围：实例「{instanceName}」全部世界数据</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="restore-confirm-input" className="text-mcs-xs font-semibold text-mcs-text-muted">
            输入实例名「{instanceName}」以确认
          </label>
          <input
            id="restore-confirm-input"
            value={restoreInput}
            onChange={(e) => setRestoreInput(e.target.value)}
            placeholder={instanceName}
            className="h-9 rounded-mcs-md border border-mcs-error-border bg-mcs-bg-default px-3 font-mono text-mcs-sm text-mcs-text-default outline-none placeholder:text-mcs-text-subtle focus:border-mcs-error-fg"
          />
        </div>
      </ConfirmDialog>

      {/* 删除确认（危险操作：此操作不可撤销） */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`删除备份 “${deleteTarget?.name ?? ''}”？`}
        description={`确定要删除备份 “${deleteTarget?.name ?? ''}” 吗？`}
        warning="此操作不可撤销"
        confirmText="删除"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => void handleDeleteConfirm()}
      />
    </div>
  )
}

/** 单行备份：状态图标 → 名称/时间·大小 → 旧格式/状态徽章 → 恢复/删除 */
function BackupRow({
  backup,
  restoringLocked,
  onRestore,
  onDelete,
}: {
  backup: BackupItem
  /** 页面级恢复中锁：任一行 restoring 或恢复请求在途时全列表恢复禁用 */
  restoringLocked: boolean
  onRestore: (backup: BackupItem) => void
  onDelete: (backup: BackupItem) => void
}) {
  const status = backup.status
  const tone = backupStatusTone(status)
  const toneClasses = TONE_CLASSES[tone]
  const name = backup.name
  const isInProgress = status === 'creating' || status === 'restoring'
  const isLegacy = isLegacyFormat(backup.format)
  /** 可恢复 = 已完成 + 快照格式（旧 zip 仅可删；进行中不可操作） */
  const canRestore = status === 'completed' && !isLegacy
  /** 可下载 = 已完成 + 快照格式（服务端仅此二者放行；zip 40904 / 非完成 40000） */
  const canDownload = canRestore
  const metaLine = [formatBackupDate(backup.createdAt), formatBackupSize(backup.size)]
    .filter(Boolean)
    .join(' · ')

  const config = useConnectionStore()
  /** 下载在途（行级独立 loading，不影响其他行按钮） */
  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const blob = await apiDownloadBackup(config, backup.id)
      const objectUrl = URL.createObjectURL(blob)
      // a[download] 需挂在 DOM 中触发（Firefox）；点击后同步 revoke 释放内存
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = buildBackupDownloadName(backup)
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(objectUrl)
      toast.success('备份已开始下载')
    } catch (e) {
      toast.error(`下载失败：${getFriendlyErrorText(e)}`)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* 状态图标（tone 浅底；备份中/恢复中转圈，失败 error 图标，其余硬盘图标） */}
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-mcs-sm', toneClasses)}
        aria-hidden
      >
        {isInProgress ? (
          <Loader2 className="size-4 animate-spin" />
        ) : status === 'failed' ? (
          <CircleAlert className="size-4" />
        ) : (
          <HardDrive className="size-4" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-mcs-sm font-semibold text-mcs-text-default" title={name}>
            {name}
          </span>
          {/* 旧格式徽章（zip 压缩包：仅可删除，不支持恢复） */}
          {isLegacy && (
            <StatusPill tone="warning" className="text-mcs-xs">
              旧格式
            </StatusPill>
          )}
        </div>
        {/* 时间 · 大小（size 空则不显示，避免尾部分隔符） */}
        <p className="mt-0.5 truncate text-mcs-xs text-mcs-text-muted" title={metaLine}>
          {metaLine}
        </p>
      </div>

      {/* 状态徽章（backupStatusTone + label） */}
      <StatusPill tone={tone} className="text-mcs-xs">
        {backupStatusLabel(status)}
      </StatusPill>

      {/* 下载（仅 completed 快照可下载；下载中转圈禁用，行级 loading） */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${name} 下载`}
        disabled={!canDownload || downloading}
        title={
          downloading
            ? '正在下载...'
            : isLegacy
              ? '旧格式备份不支持下载'
              : !canDownload
                ? '仅已就绪的备份可下载'
                : undefined
        }
        className="text-mcs-accent-fg"
        onClick={() => void handleDownload()}
      >
        {downloading ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Download className="size-3.5" aria-hidden />
        )}
      </Button>
      {/* 恢复（仅 completed 且非 zip；restoring 中全列表禁用） */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${name} 恢复`}
        disabled={!canRestore || restoringLocked}
        // 禁用原因提示（无提示会让用户误以为功能损坏）
        title={
          restoringLocked
            ? '其他备份正在恢复中，请稍候'
            : isLegacy
              ? '旧格式备份不支持恢复'
              : !canRestore
                ? '仅已就绪的备份可恢复'
                : undefined
        }
        className="text-mcs-accent-fg"
        onClick={() => onRestore(backup)}
      >
        <RotateCcw className="size-3.5" aria-hidden />
      </Button>
      {/* 删除（creating/restoring 中不可删——服务端互斥状态机拒绝） */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${name} 删除`}
        disabled={isInProgress}
        className="text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
        onClick={() => onDelete(backup)}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}
