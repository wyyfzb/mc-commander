/**
 * ArchivedSnapshotsCard —— 归档快照（磁盘上有、备份表里没有索引的快照目录）
 *
 * 单独成块、且**不依赖当前实例**：清点端点是面板级的（`GET /backups/archived` 无实例参数），
 * 它回答的是「卸载实例时保留下来的那些快照还在不在」。放进实例级页面内部会让它在
 * 「一台实例都没有」时整块消失——而那恰好是用户最需要它的时刻：卸载确认框刚说过
 * 「已保留 N 份备份」，他转身却找不到它们。
 *
 * 挂载动作需要目标实例（登记到谁名下），故无实例时只清点、不给挂载按钮，并说明原因。
 */
import { useState } from 'react'
import { FolderInput } from 'lucide-react'
import { toast } from 'sonner'
import { getFriendlyErrorText } from '@/api/errors'
import { Card } from '@/components/mcs/card'
import { Button } from '@/components/ui/button'
import { InfoHint } from '@/components/mcs/info-hint'
import { ConfirmDialog } from '@/components/mcs/confirm-dialog'
import { formatBackupDate } from '@/lib/mc-backup'
import { useArchivedSnapshots, useAttachArchive } from '../queries'

export function ArchivedSnapshotsCard({
  instanceId,
  instanceName,
}: {
  instanceId: string | null
  instanceName: string
}) {
  const [attachTarget, setAttachTarget] = useState<string | null>(null)
  const archivedQuery = useArchivedSnapshots(true)
  const attachMutation = useAttachArchive(instanceId)
  const archived = archivedQuery.data ?? []

  // 清点失败与「确实没有」必须可区分：静默不渲染会让用户以为快照已被清掉
  if (archivedQuery.isError) {
    return (
      <p className="border-t border-mcs-border-subtle px-4 py-3 text-mcs-xs text-mcs-text-muted">
        归档快照清点失败（服务端暂时不可用），刷新页面可重试。
      </p>
    )
  }
  if (archived.length === 0) return null

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

  return (
    <Card as="section" size="flush">
      <div className="border-b border-mcs-border-subtle px-4 py-3">
        <h3 className="flex items-center gap-1 text-mcs-lg font-semibold text-mcs-text-default">
          归档快照（未建立索引）
          <InfoHint label="归档快照说明">
            卸载实例时会保留其快照目录（磁盘上的事实副本），但备份表里已无索引——它们不出现在任何实例的备份列表中，未挂载的会随保留期被自动清理。挂载只登记索引，不复制、不移动磁盘内容；挂载后它们就是目标实例的普通备份条目，计入该实例的备份配额，超出保留策略（数量/天数）时按创建时间最旧优先被自动清理（挂载行按挂载时刻计时）；删除条目会连带删除磁盘上的原归档快照。
          </InfoHint>
        </h3>
        {!instanceId && (
          <p className="mt-1 text-mcs-xs text-mcs-text-muted">
            挂载需要先有一台实例：快照要登记到某台服务器名下才能恢复。现在没有实例，这里只能查看。
          </p>
        )}
      </div>
      <div className="space-y-1.5 p-4">
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
            {instanceId && (
              <Button
                variant="outline"
                size="sm"
                aria-label={`挂载到本实例（归档 ${group.archiveId}）`}
                onClick={() => setAttachTarget(group.archiveId)}
              >
                <FolderInput className="size-3.5" aria-hidden />
                挂载到本实例
              </Button>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={attachTarget != null}
        onOpenChange={(open) => {
          if (!open) setAttachTarget(null)
        }}
        title="挂载归档快照到本实例？"
        description={
          `归档「${attachTarget ?? ''}」中可识别的快照会登记为实例「${instanceName || instanceId}」的备份，` +
          '随后可在备份列表里恢复、下载或删除。原归档目录不会被复制或移动，仍留在磁盘原处——' +
          '也因为没有第二份副本，删除这些条目会删除磁盘上的原归档快照。'
        }
        warning="挂载后的条目计入本实例的备份配额，超出保留策略时按创建时间最旧优先被自动清理"
        confirmText="挂载"
        loading={attachMutation.isPending}
        onConfirm={() => void handleAttachConfirm()}
      />
    </Card>
  )
}
