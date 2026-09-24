/**
 * BackupPanel —— 备份管理子页
 * - 卡片结构：标题「备份管理」→ 上次备份信息行（最近一条 completed）+「立即备份」
 *   → 快照机制说明（subtle 小字）→ 备份列表（最近 10 条）
 * - 行：状态图标（tone 浅底；进行中转圈）→ 名称 → 时间·大小 → 状态徽章
 *   （backupStatusTone+backupStatusLabel）→ 下载/恢复/删除
 * - 下载仅 completed（服务端 GET /backups/:id/download 同约束），blob → a[download]
 *   触发浏览器保存；下载中按钮转圈禁用，失败 toast
 * - 恢复仅 completed；任一行 restoring 或
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
  FolderInput,
  HardDrive,
  Loader2,
  RotateCcw,
  ServerOff,
  Trash2,
  X,
} from 'lucide-react'
import { LoadingButton } from '@/components/mcs/loading-button'
import { toast } from 'sonner'
import { ErrorCode, getFriendlyErrorText } from '@/api/errors'
import { ApiError } from '@/api/client'
import { apiDownloadBackup } from '@/api/backups'
import type { BackupItem } from '@/api/types'
import { useConnectionStore } from '@/stores/connection'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { IconButton } from '@/components/mcs/icon-button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { cn } from '@/lib/utils'
import { StatusPill } from '@/components/mcs/status-pill'
import { ProgressBar } from '@/components/mcs/progress-bar'
import { Card } from '@/components/mcs/card'
import { InfoHint } from '@/components/mcs/info-hint'
import { useBackupProgressStore } from '@/stores/backup-progress'
import { toneClasses } from '@/components/mcs/tone'
import {
  backupStatusLabel,
  backupStatusTone,
  formatBackupDate,
  formatBackupSize,
} from '@/lib/mc-backup'
import { restoreConfirmTarget } from '@mc-commander/schemas'
import {
  useArchivedSnapshots,
  useAttachArchive,
  useBackupEventRefresh,
  useBackups,
  useCancelBackupOperation,
  useCreateBackup,
  useDeleteBackup,
  useRestoreBackup,
} from '../queries'
import { useInstances } from '@/api/queries'
import type { BackupPanelProps } from './contracts'
import { EmptyState } from '@/components/mcs/empty-state'
import { InstanceRequiredState } from '@/features/instances/components/instance-required-state'

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

export function BackupPanel({ instanceId }: BackupPanelProps) {
  const navigate = useNavigate()
  /** 待确认的恢复/删除目标（null = 对话框关闭） */
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BackupItem | null>(null)
  /** 恢复危险确认：实例名输入（不匹配禁用确认） */
  const [restoreInput, setRestoreInput] = useState('')
  /** 是否展开全部备份（默认只显示最近 10 条，超出时提供展开入口） */
  const [showAll, setShowAll] = useState(false)
  /** 待挂载的归档标识（null = 未打开确认弹窗） */
  const [attachTarget, setAttachTarget] = useState<string | null>(null)

  // 实例名（恢复危险确认输入匹配；无实例时按钮路径已拦截）
  const instancesQuery = useInstances()
  const instanceName = instancesQuery.data?.find((i) => i.id === instanceId)?.name ?? ''

  const backupsQuery = useBackups(instanceId)
  // 归档快照：卸载实例后按设计保留、但已无索引的快照目录。
  // 挂载入口只在存在可挂载项时出现（空态不出一个「永远没有内容」的区块）
  const archivedQuery = useArchivedSnapshots(Boolean(instanceId))
  const attachMutation = useAttachArchive(instanceId)
  const createMutation = useCreateBackup(instanceId)
  // 确认串随恢复请求下发（服务端强制比对）：输入框是同一确认的界面，不再是唯一闸门
  const restoreMutation = useRestoreBackup(instanceId)
  const deleteMutation = useDeleteBackup(instanceId)
  const cancelMutation = useCancelBackupOperation(instanceId)
  useBackupEventRefresh(instanceId)
  // WS 进度推送（1s 节流）：rsync 路径有百分比；robocopy/ditto 降级路径无推送，
  // 进度条退化为转圈不确定态
  const progress = useBackupProgressStore((s) => s.progress[instanceId ?? ''])
  // 确认目标由契约层单一派生（实例名 → 无名称时退到备份名 → 再退到备份 id）：
  // 空名实例下实例名确认会空转（空串天然匹配），服务端同用这一条派生链
  const restoreConfirm = restoreTarget
    ? restoreConfirmTarget({
        instanceName,
        backupName: restoreTarget.name,
        backupId: restoreTarget.id,
      })
    : ''
  // 两侧都 trim（与服务端比对口径一致）：升级前库里的名字可能带首尾空白，
  // 按原样比对会让按钮永久禁用（有备份却恢复不了）
  const restoreInputMatches = restoreInput.trim() === restoreConfirm
  // 实例列表未回时 instanceName 是占位空串，此刻放行只会发出一个注定 400 的提交
  // （服务端按实例名全等比对，空串命中的是「实例名恰好为空」那类语义）——等名字到了再放行。
  // 注意不能用 instanceName.trim() === '' 当判据：真的无名称实例本就以空串确认（服务端接受）
  const instanceNameLoaded = instancesQuery.data !== undefined

  // 无实例门：加载中/加载失败/真空态/待选中四态各自诚实（见 InstanceRequiredState）
  if (!instanceId) {
    return <InstanceRequiredState />
  }

  const backups = backupsQuery.data ?? []
  const archived = archivedQuery.data ?? []
  /** 默认展示最近 10 条，用户可展开全部（避免列表无限增长） */
  const isTruncated = backups.length > 10
  const items = showAll ? backups : backups.slice(0, 10)
  /** 最近一条 completed 备份（上次备份信息行数据源；服务端列表已按时间倒序） */
  const lastCompleted = backups.find((b) => b.status === 'completed')
  /** 恢复中：任一行 restoring 或恢复请求在途 → 全列表恢复按钮禁用（检查全量，防止截断后遗漏） */
  const restoringLocked = restoreMutation.isPending || backups.some((b) => b.status === 'restoring')

  /** 本实例有进行中的备份/恢复（请求在途覆盖轮询间隙）→ 显示进度区与取消入口 */
  const activeInProgress =
    createMutation.isPending ||
    restoreMutation.isPending ||
    backups.some((b) => b.status === 'creating' || b.status === 'restoring')
  const inProgressLabel =
    restoreMutation.isPending || backups.some((b) => b.status === 'restoring') ? '恢复中' : '备份中'

  const handleCancel = async () => {
    try {
      await cancelMutation.mutateAsync()
      // 终态由 backup/restoreCancelled 事件推送（通知中心可见），此处不重复播报
    } catch (e) {
      // 40904＝点下时操作刚结束（良性竞态）：列表失效后自然看到终态，
      // 报「取消失败」会与用户刚看到的完成通知矛盾
      if (e instanceof ApiError && e.code === ErrorCode.BACKUP_NOT_ACTIVE) {
        toast.info('该操作已结束')
        return
      }
      toast.error(`取消失败：${getFriendlyErrorText(e)}`)
    }
  }

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
      await restoreMutation.mutateAsync({
        backupId: target.id,
        confirmName: restoreConfirmTarget({
          instanceName,
          backupName: target.name,
          backupId: target.id,
        }),
      })
      toast.success('恢复已开始，完成后请启动服务器生效')
    } catch (e) {
      toast.error(`恢复失败：${getFriendlyErrorText(e)}`)
    }
  }

  /** 挂载归档快照：只登记索引（磁盘内容不复制、不移动），挂上后走常规恢复/下载/删除路径 */
  const handleAttachConfirm = async () => {
    if (attachTarget == null) return
    try {
      const res = await attachMutation.mutateAsync(attachTarget)
      setAttachTarget(null)
      if (res.attached > 0) {
        toast.success(
          `已挂载 ${res.attached} 份归档快照${res.skipped > 0 ? `（跳过 ${res.skipped} 份）` : ''}`,
        )
      } else {
        toast.info('没有可挂载的快照：它们已挂载过，或目录里没有可识别的世界数据')
      }
    } catch (e) {
      toast.error(`挂载失败：${getFriendlyErrorText(e)}`)
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
    <Card as="div" className="overflow-hidden">
      {/* 标题：图标 + 备份管理 */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-mcs-sm bg-mcs-success-bg-subtle text-mcs-success-fg"
          aria-hidden
        >
          <HardDrive className="size-3.5" />
        </span>
        <h3 className="flex items-center gap-1 text-mcs-sm font-semibold text-mcs-text-default">
          备份管理
          {/* 保留策略服务端可配且 API 未暴露，不硬编码数值——避免与服务端实际配置漂移 */}
          <InfoHint label="快照备份说明">
            快照备份：未修改文件零拷贝增量传输，超出保留策略自动清理（默认保留策略见服务端配置）
          </InfoHint>
        </h3>
      </div>

      {/* 上次备份信息行 + 立即备份（在途禁用 + 备份中...） */}
      <div className="flex items-center gap-3 border-t border-mcs-border-subtle px-4 py-3">
        <p
          className="min-w-0 flex-1 truncate text-mcs-sm text-mcs-text-muted"
          title={lastBackupText}
        >
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

      {/* 进行中进度区：WS 推送有百分比走进度条，否则转圈不确定态；取消请求
          异步生效（服务端 abort 子进程），终态经事件推送，按钮只做发起 */}
      {activeInProgress && (
        <div
          data-testid="backup-progress"
          className="flex items-center gap-3 border-t border-mcs-border-subtle px-4 py-2.5"
        >
          {progress ? (
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-mcs-xs text-mcs-text-muted">{inProgressLabel}</span>
                <span className="text-mcs-xs text-mcs-text-muted">
                  {Math.round(progress.percent)}%
                </span>
              </div>
              <ProgressBar percent={progress.percent} />
            </div>
          ) : (
            <>
              <Loader2 className="size-3.5 shrink-0 animate-spin text-mcs-text-muted" aria-hidden />
              <span className="min-w-0 flex-1 text-mcs-xs text-mcs-text-muted">
                {inProgressLabel}…
              </span>
            </>
          )}
          <LoadingButton
            variant="outline"
            size="sm"
            loading={cancelMutation.isPending}
            loadingText="取消中..."
            onClick={() => void handleCancel()}
          >
            {/* 文案区别于确认弹窗的「取消」：同名会让同屏两个取消按钮无法按名区分 */}
            取消操作
          </LoadingButton>
        </div>
      )}

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
                  onCancel={() => void handleCancel()}
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
        confirmDisabled={!restoreInputMatches || !instanceNameLoaded}
        onConfirm={() => void handleRestoreConfirm()}
      >
        {/* 目标快照信息块：名称/时间/覆盖范围（恢复为目录快照复制，非命令下发，故无命令预览） */}
        <div className="flex flex-col gap-1 rounded-mcs-sm border border-mcs-border-muted bg-mcs-bg-default px-2.5 py-2 text-mcs-xs text-mcs-text-muted">
          <div className="flex items-center gap-1.5">
            <HardDrive className="size-3 shrink-0 text-mcs-accent-fg" aria-hidden />
            <span
              className="truncate font-mono text-mcs-text-default"
              title={restoreTarget?.name ?? ''}
            >
              {restoreTarget?.name ?? ''}
            </span>
          </div>
          {restoreTarget && (
            <div className="flex items-center gap-1.5">
              <CalendarClock className="size-3 shrink-0 text-mcs-text-muted" aria-hidden />
              <span>
                快照时间：
                {[formatBackupDate(restoreTarget.createdAt), formatBackupSize(restoreTarget.size)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <ServerOff className="size-3 shrink-0 text-mcs-error-fg" aria-hidden />
            <span>覆盖范围：实例「{instanceName}」全部世界数据</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="restore-confirm-input"
            className="text-mcs-xs font-semibold text-mcs-text-muted"
          >
            输入{instanceName.trim() === '' ? '备份名' : '实例名'}「{restoreConfirm}」以确认
          </label>
          {/* 归 ui/input 基座，只保留危险语义焦点环（确认框的「红色 = 不可逆」提示） */}
          <Input
            id="restore-confirm-input"
            value={restoreInput}
            onChange={(e) => setRestoreInput(e.target.value)}
            placeholder={restoreConfirm}
            className="font-mono focus-visible:border-mcs-error-fg focus-visible:ring-mcs-error-fg"
          />
          {/* 确认目标取自实例列表：读不到名字时确认按钮会一直禁用，必须给出原因
              （否则用户只看到一个永远点不动的按钮，不知道是加载失败还是自己没输对） */}
          {!instanceNameLoaded && (
            <p className="text-mcs-xs text-mcs-text-muted">
              {instancesQuery.isError
                ? '实例信息加载失败，无法确认恢复，请刷新页面重试'
                : '正在加载实例信息…'}
            </p>
          )}
        </div>
      </ConfirmDialog>

      {/* ── 归档快照：卸载实例保留下来、但已无索引的快照目录 ── */}
      {archivedQuery.isError && (
        <p className="mt-2 border-t border-mcs-border-subtle px-4 py-3 text-mcs-xs text-mcs-text-muted">
          归档快照清点失败（服务端暂时不可用），刷新页面可重试。
        </p>
      )}
      {archived.length > 0 && (
        <div className="mt-2 border-t border-mcs-border-subtle px-4 py-3">
          <h4 className="flex items-center gap-1 text-mcs-sm font-semibold text-mcs-text-default">
            归档快照（未建立索引）
            <InfoHint label="归档快照说明">
              卸载实例时会保留其快照目录（磁盘上的事实副本），但备份表里已无索引——它们不出现在任何实例的备份列表中，未挂载的会随保留期被自动清理。挂载只登记索引，不复制、不移动磁盘内容；挂载后它们就是本实例的普通备份条目，计入本实例的备份配额，超出保留策略（数量/天数）时按创建时间最旧优先被自动清理（挂载行按挂载时刻计时）；删除条目会连带删除磁盘上的原归档快照。
            </InfoHint>
          </h4>
          <div className="mt-2 space-y-1.5">
            {archived.map((group) => (
              <div
                key={group.archiveId}
                className="flex flex-wrap items-center gap-2 rounded-mcs-md border border-mcs-border-muted px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate font-mono text-mcs-xs text-mcs-text-default"
                    title={group.archiveId}
                  >
                    {group.archiveId}
                  </p>
                  <p className="text-mcs-2xs text-mcs-text-muted">
                    {group.instanceExists ? '现存实例的未索引快照' : '来自已卸载实例'} · 可挂载{' '}
                    {group.usableCount}/{group.snapshotCount} 份 · 最近{' '}
                    {formatBackupDate(group.latestMtime)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`挂载到本实例（归档 ${group.archiveId}）`}
                  onClick={() => setAttachTarget(group.archiveId)}
                >
                  <FolderInput className="size-3.5" aria-hidden />
                  挂载到本实例
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 挂载确认（把别人的历史快照登记到本实例：会出现在本实例的备份列表里） */}
      <ConfirmDialog
        open={attachTarget != null}
        onOpenChange={(open) => {
          if (!open) setAttachTarget(null)
        }}
        title="挂载归档快照到本实例？"
        description={
          `归档「${attachTarget ?? ''}」中可识别的快照会登记为实例「${instanceName || instanceId}」的备份，` +
          '随后可在本列表里恢复、下载或删除。原归档目录不会被复制或移动，仍留在磁盘原处——' +
          '也因为没有第二份副本，删除这些条目会删除磁盘上的原归档快照。'
        }
        warning="挂载后的条目计入本实例的备份配额，超出保留策略时按创建时间最旧优先被自动清理"
        confirmText="挂载"
        loading={attachMutation.isPending}
        onConfirm={() => void handleAttachConfirm()}
      />

      {/* 删除确认（危险操作：此操作不可撤销） */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`删除备份 “${deleteTarget?.name ?? ''}”？`}
        description={`确定要删除备份 “${deleteTarget?.name ?? ''}” 吗？`}
        warning={
          deleteTarget?.sourceArchiveId
            ? `此条目挂载自归档 ${deleteTarget.sourceArchiveId}：删除会一并删除磁盘上的原归档快照（不复制，没有第二份副本）`
            : '此操作不可撤销'
        }
        confirmText="删除"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => void handleDeleteConfirm()}
      />
    </Card>
  )
}

/** 单行备份：状态图标 → 名称/时间·大小 → 状态徽章 → 恢复/删除 */
function BackupRow({
  backup,
  restoringLocked,
  onRestore,
  onDelete,
  onCancel,
}: {
  backup: BackupItem
  /** 页面级恢复中锁：任一行 restoring 或恢复请求在途时全列表恢复禁用 */
  restoringLocked: boolean
  onRestore: (backup: BackupItem) => void
  onDelete: (backup: BackupItem) => void
  /** 进行中行显示取消入口（取消按实例发起，两模式共用同一 mutation） */
  onCancel: () => void
}) {
  const status = backup.status
  const tone = backupStatusTone(status)
  const iconToneClasses = toneClasses(tone)
  const name = backup.name
  const isInProgress = status === 'creating' || status === 'restoring'
  /** 可恢复 = 已完成（进行中不可操作） */
  const canRestore = status === 'completed'
  /** 可下载 = 已完成（服务端仅放行 completed，非完成 40000） */
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
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-mcs-sm',
          iconToneClasses,
        )}
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

      {/* 下载（仅 completed 可下载；下载中转圈禁用，行级 loading） */}
      <IconButton
        aria-label={`${name} 下载`}
        disabled={!canDownload || downloading}
        title={downloading ? '正在下载...' : !canDownload ? '仅已就绪的备份可下载' : undefined}
        className="text-mcs-accent-fg"
        onClick={() => void handleDownload()}
      >
        {downloading ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Download className="size-3.5" aria-hidden />
        )}
      </IconButton>
      {/* 恢复（仅 completed；restoring 中全列表禁用） */}
      <IconButton
        aria-label={`${name} 恢复`}
        disabled={!canRestore || restoringLocked}
        // 禁用原因提示（无提示会让用户误以为功能损坏）
        title={
          restoringLocked
            ? '其他备份正在恢复中，请稍候'
            : !canRestore
              ? '仅已就绪的备份可恢复'
              : undefined
        }
        className="text-mcs-accent-fg"
        onClick={() => onRestore(backup)}
      >
        <RotateCcw className="size-3.5" aria-hidden />
      </IconButton>
      {/* 进行中行显示取消（取消请求异步生效，点击后按钮交由页面级 pending）；否则删除 */}
      {isInProgress ? (
        <IconButton
          aria-label={`${name} 取消`}
          title="取消当前备份/恢复"
          className="text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
          onClick={onCancel}
        >
          <X className="size-3.5" aria-hidden />
        </IconButton>
      ) : (
        <IconButton
          aria-label={`${name} 删除`}
          className="text-mcs-error-fg hover:bg-mcs-error-bg-subtle hover:text-mcs-error-fg"
          onClick={() => onDelete(backup)}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </IconButton>
      )}
    </div>
  )
}
